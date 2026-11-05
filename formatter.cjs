const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile, fork } = require('node:child_process');
const { promisify } = require('node:util');

// Each formatter's npm package and the arguments that format stdin as a named file. Order is dependency precedence.
const tools = {
  oxfmt: { pkg: 'oxfmt', args: ['--stdin-filepath'] },
  biome: { pkg: '@biomejs/biome', args: ['format', '--stdin-file-path'] },
  dprint: { pkg: 'dprint', args: ['fmt', '--stdin'] },
  prettier: { pkg: 'prettier', args: ['--stdin-filepath'] },
  bun: { args: ['fmt', '--stdin-filepath'] },
};
const prettierConfigs = [
  '.prettierrc',
  ...['json', 'yml', 'yaml', 'json5'].map(ext => `.prettierrc.${ext}`),
  ...['js', 'ts', 'mjs', 'mts', 'cjs', 'cts'].flatMap(ext => [`.prettierrc.${ext}`, `prettier.config.${ext}`]),
  '.prettierrc.toml',
];
const oxfmtConfigs = [
  '.oxfmtrc.json', '.oxfmtrc.jsonc',
  ...['js', 'mjs', 'cjs', 'ts', 'mts', 'cts'].map(ext => `oxfmt.config.${ext}`),
];
// The documents the Oxc extension formats, so VS Code never reports this default formatter as unable to format them:
// its languages in any scheme, each with the file extension that selects the same syntax, plus its file patterns on disk.
const languageExtensions = {
  javascript: 'js', typescript: 'ts', javascriptreact: 'jsx', typescriptreact: 'tsx', css: 'css', graphql: 'graphql',
  handlebars: 'hbs', json: 'json', jsonc: 'jsonc', json5: 'json5', less: 'less', markdown: 'md', mdx: 'mdx', mjml: 'mjml',
  html: 'html', scss: 'scss', toml: 'toml', vue: 'vue', yaml: 'yaml', svelte: 'svelte', astro: 'astro',
};
const fileExtensions = 'cjs,cts,js,jsx,mjs,mts,ts,tsx,_js,bones,es,es6,gs,jake,javascript,jsb,jscad,jsfl,jslib,jsm,jspre,jss,njs,pac,sjs,ssjs,xsjs,xsjslib,frag,json,4DForm,4DProject,avsc,geojson,gltf,har,ice,JSON-tmLanguage,json.example,mcmeta,sarif,tact,tfstate,tfstate.backup,topojson,webapp,webmanifest,yy,yyp,jsonc,json5,code-snippets,code-workspace,sublime-build,sublime-color-scheme,sublime-commands,sublime-completions,sublime-keymap,sublime-macro,sublime-menu,sublime-mousemap,sublime-project,sublime-settings,sublime-theme,sublime-workspace,sublime_metrics,sublime_session,html,hta,htm,inc,xht,xhtml,vue,mjml,css,wxss,pcss,postcss,less,scss,graphql,gql,graphqls,handlebars,hbs,md,livemd,markdown,mdown,mdwn,mkd,mkdn,mkdown,ronn,scd,workbook,mdx,yml,mir,reek,rviz,sublime-syntax,syntax,yaml,yaml-tmlanguage,toml,toml.example,svelte,astro';
const fileNames = ['Jakefile', '.all-contributorsrc', '.arcconfig', '.auto-changelog', '.c8rc', '.htmlhintrc', '.imgbotconfig', '.nycrc', '.tern-config', '.tern-project', '.watchmanconfig', '.babelrc', '.jscsrc', '.jshintrc', '.jslintrc', '.swcrc', 'contents.lr', 'README', '.clang-format', '.clang-tidy', '.clangd', '.gemrc', 'CITATION.cff', 'glide.lock', 'pixi.lock', '.prettierrc', '.stylelintrc', '.lintstagedrc', 'Pipfile', 'Cargo.toml.orig'];
const selector = [
  { pattern: `**/*.{${fileExtensions}}`, scheme: 'file' },
  ...fileNames.map(name => ({ pattern: `**/${name}`, scheme: 'file' })),
  ...Object.keys(languageExtensions).map(language => ({ language })),
];

// The path a formatter sees. A document without a file of its own (settings.json, untitled, a notebook cell) gets one
// at its own location or the workspace root, so project config applies, and named after its language's syntax.
function documentPath({ fileName, languageId, uri }, root) {
  if (uri.scheme === 'file') return fileName;
  const file = path.resolve(root || os.homedir(), fileName);
  const extension = `.${languageExtensions[languageId]}`;
  return file.endsWith(extension) ? file : file + extension;
}

// The file's folder and its parents, up to the repository root or home.
function projectDirs(file) {
  const result = [];
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    result.push(dir);
    if (dir === os.homedir() || dir === path.dirname(dir) || fs.existsSync(path.join(dir, '.git'))) break;
  }
  return result;
}

function readIfExists(file) {
  try { return fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}

// The formatter one folder declares: script, bunfig, Oxfmt config, Biome config, dprint config, Prettier config, then dependency.
function declared(dir, pkg) {
  // shortcut: recognize standard formatter commands; custom wrappers need an explicit VSCode formatter override.
  for (const [name, command] of Object.entries(pkg.scripts || {})) {
    if (!/^(?:format|fmt)(?::.*)?$/.test(name) || typeof command !== 'string') continue;
    const match = command.match(/(?:^|[\s;&|])(?:(bun)\s+fmt\b|(prettier|oxfmt|biome|dprint)\b)/);
    if (match) return { tool: match[1] || match[2], reason: `package.json: ${name}` };
  }
  if (/^\s*\[\[?fmt(?:\.|\])/m.test(readIfExists(path.join(dir, 'bunfig.toml')))) return { tool: 'bun', reason: 'bunfig.toml: fmt' };
  for (const [tool, names] of [
    ['oxfmt', oxfmtConfigs], ['biome', ['biome.json', 'biome.jsonc']],
    ['dprint', ['dprint.json', 'dprint.jsonc', '.dprint.json', '.dprint.jsonc']],
  ]) {
    const config = names.find(name => fs.existsSync(path.join(dir, name)));
    if (config) return { tool, reason: config };
  }
  if (pkg.prettier) return { tool: 'prettier', reason: 'package.json: prettier' };
  const config = prettierConfigs.find(name => fs.existsSync(path.join(dir, name)));
  if (config) return { tool: 'prettier', reason: config };
  const dependencies = { ...pkg.dependencies, ...pkg.devDependencies };
  const tool = Object.keys(tools).find(name => tools[name].pkg && dependencies[tools[name].pkg]);
  if (tool) return { tool, reason: `dependency: ${tools[tool].pkg}` };
}

function detect(file) {
  const dirs = projectDirs(file);
  for (const dir of dirs) {
    // Home contains personal Oxfmt defaults, not a project formatter declaration.
    if (dir === os.homedir()) break;
    const source = readIfExists(path.join(dir, 'package.json'));
    const pkg = source ? JSON.parse(source) : {};
    const found = declared(dir, pkg);
    if (!found) continue;
    // shortcut: Bun dispatches a fmt package script before its formatter; refuse it until Bun exposes a direct native invocation.
    if (found.tool === 'bun' && pkg.scripts?.fmt) throw new Error('A package.json fmt script overrides bun fmt; configure this project formatter explicitly.');
    return { ...found, cwd: dir };
  }
  const fallback = dirs.find(dir => fs.existsSync(path.join(dir, 'package.json'))) || dirs.at(-1);
  return { tool: 'oxfmt', cwd: fallback, reason: 'Oxfmt fallback' };
}

// Resolve an oxc.path.* setting like the Oxc extension: ${userHome}, ${env:NAME}, relative to the first workspace folder.
function oxcPath(value, root) {
  if (typeof value !== 'string') return undefined;
  const resolved = value.replaceAll(/\$\{(userHome|env:([^}]+))\}/g, (_, variable, name) => name ? process.env[name] ?? '' : os.homedir());
  return resolved && (path.isAbsolute(resolved) ? path.normalize(resolved) : root && path.join(root, resolved));
}

// Biome's and dprint's npm launchers start Node on every save only to run a native program; find that program instead.
// Same cwd, arguments and environment, so it reads the same project config.
function nativeProgram(tool, launcher) {
  const modules = path.dirname(path.dirname(launcher));
  const exe = process.platform === 'win32' ? '.exe' : '';
  let candidates = [];
  // dprint's launcher copies its program into its own package on first run.
  if (tool === 'dprint') candidates = [path.join(modules, 'dprint', `dprint${exe}`)];
  // Biome's platform package sits next to @biomejs/biome in npm, pnpm and Bun layouts,
  // and package managers install only the libc variant that fits.
  const biome = path.join(modules, '@biomejs', 'biome');
  if (tool === 'biome' && !process.env.BIOME_BINARY && fs.existsSync(biome)) {
    candidates = ['', '-musl'].map(libc =>
      path.join(fs.realpathSync(biome), '..', `cli-${process.platform}-${process.arch}${libc}`, `biome${exe}`));
  }
  return candidates.find(candidate => fs.existsSync(candidate));
}

function invocation(file, oxfmtPath, selection = detect(file)) {
  const local = projectDirs(file).map(dir => path.join(dir, 'node_modules', '.bin', selection.tool))
    .find(candidate => fs.existsSync(candidate));
  // An explicit oxc.path.oxfmt beats node_modules, as in the Oxc extension.
  const executable = (selection.tool === 'oxfmt' && oxfmtPath) || (local && nativeProgram(selection.tool, local)) || local || selection.tool;
  // Only Prettier 3 ships index.cjs; older and global Prettier run through the CLI.
  const prettier = selection.tool === 'prettier' && local && path.join(path.dirname(local), '..', 'prettier', 'index.cjs');
  return { ...selection, executable, args: [...tools[selection.tool].args, file],
    prettier: prettier && fs.existsSync(prettier) ? prettier : undefined };
}

// One Prettier process per project folder, so Prettier loads once instead of on every save.
const prettierProcesses = new Map();
// Node caches imported JS configs, so any change to these files gets a fresh process.
const prettierInputs = [...prettierConfigs, 'package.json', 'package.yaml', '.editorconfig', '.prettierignore', '.gitignore'];
let nextRequest = 0;

function prettierProcess(prettier, file, cwd, env) {
  const dirs = projectDirs(file);
  const stamp = [prettier, ...dirs.slice(dirs.indexOf(cwd)).flatMap(dir => prettierInputs.map(name => path.join(dir, name)))]
    .map(name => fs.statSync(name, { throwIfNoEntry: false })?.mtimeMs).join();
  let child = prettierProcesses.get(cwd);
  if (!child?.connected || child.stamp !== stamp) {
    child?.kill();
    child = fork(path.join(__dirname, 'prettier-worker.cjs'), [prettier], {
      cwd, env, execPath: 'node', execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    child.stamp = stamp;
    prettierProcesses.set(cwd, child);
  }
  // An unused project gives its memory back: closing the channel lets the process exit, and the next save starts it again.
  clearTimeout(child.idle);
  child.idle = setTimeout(() => child.connected && child.disconnect(), 15 * 60 * 1000).unref();
  return child;
}

function formatWithPrettier(command, input, file, env, signal) {
  signal?.throwIfAborted();
  const child = prettierProcess(command.prettier, file, command.cwd, env);
  const id = nextRequest++;
  return new Promise((resolve, reject) => {
    const done = (error, formatted) => {
      clearTimeout(timer);
      child.off('message', onMessage).off('exit', onExit).off('error', done);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error); else resolve(formatted);
    };
    const onMessage = reply => reply.id === id && done(reply.error && new Error(`prettier: ${reply.error}`), reply.formatted);
    const onExit = code => done(new Error(`prettier: process exited (${code ?? 'killed'}); file kept unchanged.`));
    const onAbort = () => done(signal.reason);
    const timer = setTimeout(() => child.kill(), 15000);
    child.on('message', onMessage).on('exit', onExit).on('error', done);
    signal?.addEventListener('abort', onAbort);
    child.send({ id, text: input, file });
  });
}

function stopPrettier() {
  for (const child of prettierProcesses.values()) child.kill();
  prettierProcesses.clear();
}

async function run(command, input, file, nodePath, signal, log) {
  log(`${file}: ${command.tool} (${command.reason})${command.prettier ? ', kept loaded' : ''}`);
  const env = { ...process.env, PATH: [
    nodePath && path.dirname(nodePath), process.env.PATH,
    // shortcut: only mise shims are added for editors started without the shell PATH; add other version managers when asked.
    path.join(process.env.MISE_DATA_DIR || path.join(os.homedir(), '.local/share/mise'), 'shims'),
  ].filter(Boolean).join(path.delimiter) };
  if (command.tool === 'bun') {
    const { stdout } = await promisify(execFile)(command.executable, ['--help'], { cwd: command.cwd, env, encoding: 'utf8', timeout: 5000, signal });
    if (!/^\s+fmt\s/m.test(stdout)) throw new Error('This Bun installation does not include bun fmt. File kept unchanged.');
  }
  const output = command.prettier ? await formatWithPrettier(command, input, file, env, signal) : await new Promise((resolve, reject) => {
    const child = execFile(command.executable, command.args, {
      cwd: command.cwd, env, encoding: 'utf8', timeout: 15000, maxBuffer: 16 * 1024 * 1024, signal,
    }, (error, stdout, stderr) => {
      if (stderr) log(stderr.trim());
      // Oxfmt skips file names it does not know, as the Oxc extension does.
      if (error && command.tool === 'oxfmt' && /Unsupported file type/.test(stderr)) return resolve(input);
      if (error) return reject(new Error(`${command.tool}: ${stderr.trim() || error.message}`, { cause: error }));
      resolve(stdout);
    });
    child.stdin.on('error', () => {}); // Process failures are reported by execFile's callback.
    child.stdin.end(input);
  });
  if (input.trim() && !output.trim()) throw new Error(`${command.tool} returned empty output; file kept unchanged.`);
  return output;
}

async function format(input, file, oxfmtPath, nodePath, signal, log = () => {}) {
  const command = invocation(file, oxfmtPath);
  try {
    return await run(command, input, file, nodePath, signal, log);
  } catch (error) {
    // The project's formatter decides only for file types it can parse; the rest, like TOML under Prettier, go to Oxfmt.
    // shortcut: only Prettier's message is recognized; add Biome's and dprint's when a project needs them.
    if (!/No parser could be inferred/.test(error.message)) throw error;
    const fallback = { tool: 'oxfmt', cwd: command.cwd, reason: 'Prettier has no parser for this file' };
    return run(invocation(file, oxfmtPath, fallback), input, file, nodePath, signal, log);
  }
}

module.exports = { detect, documentPath, invocation, format, oxcPath, selector, stopPrettier };
