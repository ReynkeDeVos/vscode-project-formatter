const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile, fork, spawn } = require('node:child_process');
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
// In CSharpier's precedence within one folder.
const csharpierConfigs = ['.csharpierrc', '.csharpierrc.json', '.csharpierrc.yaml', '.csharpierrc.yml', '.editorconfig'];
// The path a formatter sees. A document without a file of its own (settings.json, untitled, a notebook cell) gets one at its own
// location or the workspace root, so project config applies, and a name that selects its language's syntax if it has none yet.
function documentPath({ fileName, languageId, uri }, root, languages = [], oxcExtensions = []) {
  if (uri.scheme === 'file') return fileName;
  const file = path.resolve(root || os.homedir(), fileName);
  const contributed = languages.filter(({ id, extensions }) => id === languageId && extensions?.length).map(({ extensions }) => extensions);
  const all = contributed.flat();
  // A name that already selects a syntax Oxc formats stays, so config overrides for it still apply.
  if (all.some(candidate => file.endsWith(candidate) && oxcExtensions.includes(candidate.slice(1)))) return file;
  // A language's own contribution has an extension named after it and lists its usual one first; other extensions only add to that.
  const extension = contributed.find(extensions => extensions.includes(`.${languageId}`))?.[0]
    ?? all.find(candidate => oxcExtensions.includes(candidate.slice(1))) ?? all[0];
  return !extension || file.endsWith(extension) ? file : file + extension;
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

// What the Oxc extension formats, read from its installed copy so an Oxc update needs no change here: the languages from its
// manifest, the file patterns from its bundle, the only place that has them. If the bundle changes shape, only the languages remain.
function oxcRules({ extensionPath, packageJSON }) {
  const bundle = readIfExists(path.join(extensionPath, packageJSON.main));
  const match = bundle.match(/documentSelectors=\[\{pattern:`\*\*\/\*\.\{\$\{([\w$]+)\.join\(.{3}\)\}\}`,scheme:.{6}\},\.\.\.([\w$]+)\.map\([\w$]+=>\(\{pattern:/);
  // A minified constant is [`a`,`b`] or `a,b`.split(`,`). Names get reused across scopes, so a name defined twice counts as unreadable.
  const list = name => {
    const definition = new RegExp(`(?<![\\w$])${name.replaceAll('$', '\\$')}=(?:/\\*.*?\\*/\\s*)?(?:\\[([^\\]]*)\\]|[\`"']([^\`"']*)[\`"']\\.split\\()`, 'g');
    const definitions = [...bundle.matchAll(definition)];
    if (definitions.length !== 1) return [];
    const [, array, joined] = definitions[0];
    return array?.match(/[^`"',]+/g) ?? joined?.split(',') ?? [];
  };
  const lists = match ? [list(match[1]), list(match[2])] : [];
  // Both lists or neither, so a half-read bundle can't pass for a whole one.
  const [extensions, names] = lists.length && lists.every(items => items.length) ? lists : [[], []];
  const languages = packageJSON.activationEvents.flatMap(event => event.match(/^onLanguage:(.+)$/)?.[1] ?? []);
  return {
    extensions,
    selector: [
      ...(extensions.length ? [{ pattern: `**/*.{${extensions.join(',')}}`, scheme: 'file' }] : []),
      ...names.map(name => ({ pattern: `**/${name}`, scheme: 'file' })),
      ...languages.map(language => ({ language })),
    ],
  };
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

function invocation(file, oxc = {}, selection = detect(file)) {
  const isOxfmt = selection.tool === 'oxfmt';
  const local = projectDirs(file).map(dir => path.join(dir, 'node_modules', '.bin', selection.tool))
    .find(candidate => fs.existsSync(candidate));
  // An explicit oxc.path.oxfmt beats node_modules, as in the Oxc extension.
  const executable = (isOxfmt && oxc.oxfmtPath) || (local && nativeProgram(selection.tool, local)) || local || selection.tool;
  // Also as there: its settings apply, and it runs from the workspace folder, the one place it reads ignore files from.
  const flags = isOxfmt ? [...(oxc.configPath ? [`--config=${oxc.configPath}`] : []), ...(oxc.disableNestedConfig ? ['--disable-nested-config'] : [])] : [];
  // Only Prettier 3 ships index.cjs; older and global Prettier run through the CLI.
  const prettier = selection.tool === 'prettier' && local && path.join(path.dirname(local), '..', 'prettier', 'index.cjs');
  return { ...selection, cwd: (isOxfmt && oxc.folder) || selection.cwd, executable, args: [...flags, ...tools[selection.tool].args, file],
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

function toolEnv(nodePath) {
  return { ...process.env, PATH: [
    nodePath && path.dirname(nodePath), process.env.PATH,
    // shortcut: only mise shims are added for editors started without the shell PATH; add other version managers when asked.
    path.join(process.env.MISE_DATA_DIR || path.join(os.homedir(), '.local/share/mise'), 'shims'),
  ].filter(Boolean).join(path.delimiter) };
}

// Runs a program with input on stdin; failures come back as `error`, with the exit code or `ENOENT` as its `code`, as from
// execFile. In a process group of its own, so a timeout or a cancellation also ends what it started, like an npm launcher's program.
function execute(executable, args, input, { cwd, env, signal }) {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve({ error: signal.reason, stdout: '', stderr: '' });
    const output = { stdout: [], stderr: [] };
    let error;
    const child = spawn(executable, args, { cwd, env, detached: true });
    const stop = reason => {
      error ??= reason;
      try { process.kill(-child.pid, 'SIGTERM'); } catch {} // Not started, or already ended.
    };
    const timer = setTimeout(() => stop(Object.assign(new Error('timed out after 15 seconds'), { killed: true })), 15000);
    const abort = () => stop(signal.reason);
    signal?.addEventListener('abort', abort);
    // As execFile's maxBuffer: at most 16 MB on each stream.
    for (const [name, chunks] of Object.entries(output)) {
      let bytes = 0;
      child[name].on('data', chunk => {
        if ((bytes += chunk.length) > 16 * 1024 * 1024) return stop(Object.assign(new Error(`${name} larger than 16 MB`), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }));
        chunks.push(chunk);
      });
    }
    child.on('error', spawnError => { error ??= spawnError; });
    child.on('close', (code, killedBy) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (!error && (code || killedBy)) error = Object.assign(new Error(`exited with ${code ?? killedBy}`), { code });
      resolve({ error, stdout: Buffer.concat(output.stdout).toString(), stderr: Buffer.concat(output.stderr).toString() });
    });
    child.stdin.on('error', () => {}); // Process failures are reported by 'error' and 'close'.
    child.stdin.end(input);
  });
}

async function run(command, input, file, env, signal, log) {
  log(`${file}: ${command.tool} (${command.reason})${command.prettier ? ', kept loaded' : ''}`);
  if (command.tool === 'bun') {
    const { stdout } = await promisify(execFile)(command.executable, ['--help'], { cwd: command.cwd, env, encoding: 'utf8', timeout: 5000, signal });
    if (!/^\s+fmt\s/m.test(stdout)) throw new Error('This Bun installation does not include bun fmt. File kept unchanged.');
  }
  let output;
  if (command.prettier) output = await formatWithPrettier(command, input, file, env, signal);
  else {
    const { error, stdout, stderr } = await execute(command.executable, command.args, input, { cwd: command.cwd, env, signal });
    if (stderr) log(stderr.trim());
    // Oxfmt skips file names it does not know, as the Oxc extension does.
    if (error?.code === 1 && command.tool === 'oxfmt' && stderr.trim() === 'Unsupported file type for stdin-filepath') return input;
    if (error) throw new Error(`${command.tool}: ${stderr.trim() || error.message}`, { cause: error });
    output = stdout;
  }
  if (input.trim() && !output.trim()) throw new Error(`${command.tool} returned empty output; file kept unchanged.`);
  return output;
}

// The info strings of the code blocks formatted here, lowercased; Prettier's `lang` is the info string's first word.
const languages = { python: ['python', 'py', 'python3', 'py3'], csharp: ['csharp', 'cs', 'c#'] };
// A fence that may hold Python or C#; only spares parsing a file without one.
const codeFence = /(?:`{3,}|~{3,})[ \t]*\{?\.?(?:py|cs\b|csharp|c#)/i;
// Prettier's Markdown parser, which Oxfmt formats Markdown with too, so both agree on what is a code block.
let markdownParser;

// The fenced Python and C# blocks as Prettier finds them, also in lists and blockquotes: each with its code, where its lines
// start and end, and the prefix every line carries (a list's indentation, a blockquote's `> `). A block whose lines do not follow
// from its code and one prefix, or one without a closing fence, is left out, so it stays as it is.
async function codeBlocks(text) {
  markdownParser ??= require('prettier/plugins/markdown').parsers.markdown;
  const blocks = [];
  const visit = node => {
    const language = Object.keys(languages).find(name => languages[name].includes(node.lang?.toLowerCase()));
    if (node.type === 'code' && language) {
      const { start, end } = node.position;
      const lines = text.slice(start.offset, end.offset).split('\n');
      const fence = lines[0].match(/^(`{3,}|~{3,})/)?.[1];
      const closing = lines.at(-1).match(/^[ >]*(`{3,}|~{3,})[ \t]*$/)?.[1];
      const code = node.value.split('\n');
      const first = code.findIndex(Boolean);
      const content = lines.slice(1, -1);
      if (fence && lines.length > 2 && closing?.[0] === fence[0] && closing.length >= fence.length && first !== -1 && content[first]?.endsWith(code[first])) {
        const prefix = content[first].slice(0, content[first].length - code[first].length);
        const blank = content[code.indexOf('')] ?? prefix.trimEnd();
        const lineOf = line => line ? prefix + line : blank;
        if (code.map(lineOf).join('\n') === content.join('\n')) {
          blocks.push({ language, code: node.value, lineOf, start: start.offset + lines[0].length + 1, end: end.offset - lines.at(-1).length });
        }
      }
    }
    node.children?.forEach(visit);
  };
  visit(await markdownParser.parse(text, {}));
  return blocks;
}

// Ruff starts in milliseconds, so each Python block goes to it on its own, named so that the document folder's config applies.
function formatPython(blocks, file, cwd, env, signal, log) {
  const name = path.join(path.dirname(file), 'snippet.py');
  const logged = new Set();
  const once = message => logged.has(message) || (logged.add(message), log(message));
  return Promise.all(blocks.map(async ({ code }) => {
    const { error, stdout, stderr } = await execute('ruff', ['format', '--stdin-filename', name, '-'], `${code}\n`, { cwd, env, signal });
    if (!error) return { formatted: stdout };
    if (error.code === 'ENOENT') once('Ruff is not installed; Python blocks stay as they are.');
    else if (/Failed to parse/.test(stderr)) return { invalid: true };
    else once(`ruff: ${stderr.trim() || error.message}`);
    return {};
  }));
}

// CSharpier starts .NET on every run and has no Markdown support, so all C# blocks go to it at once, as files of their own.
async function formatCSharp(blocks, file, cwd, env, signal, log) {
  if (!blocks.length) return [];
  // The files are in a temporary folder, so the project's config is passed along.
  // shortcut: only the nearest config file counts; .editorconfig files above it are not merged as CSharpier would.
  const config = projectDirs(file).flatMap(dir => csharpierConfigs.map(name => path.join(dir, name))).find(candidate => fs.existsSync(candidate));
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'project-formatter-'));
  try {
    const files = blocks.map((_, index) => path.join(dir, `${index}.cs`));
    await Promise.all(files.map((name, index) => fs.promises.writeFile(name, `${blocks[index].code}\n`)));
    const args = ['format', '--no-cache', '--no-msbuild-check', ...(config ? ['--config-path', config] : []), dir];
    const { error, stdout, stderr } = await execute('csharpier', args, '', { cwd, env, signal });
    signal?.throwIfAborted();
    const messages = `${stdout}\n${stderr}`;
    // A block that is not valid C# on its own, like a method without its class, makes CSharpier exit with 1 and format the rest.
    // After any other failure no file is trusted, since one may be half written.
    const syntaxErrorsOnly = error?.code === 1 && messages.split('\n').every(line =>
      !line.trim() || /^\s/.test(line) || /^Formatted \d+ files? in /.test(line) || /^Error .*\d+\.cs - Was not formatted due to syntax errors\.$/.test(line));
    if (error && !syntaxErrorsOnly) {
      log(error.code === 'ENOENT' ? 'CSharpier is not installed; C# blocks stay as they are.' : `csharpier: ${messages.trim() || error.message}`);
      return [];
    }
    const invalid = new Set([...messages.matchAll(/(\d+)\.cs - Was not formatted due to syntax errors/g)].map(([, index]) => Number(index)));
    // CSharpier writes a file only when it formatted it.
    return Promise.all(files.map(async (name, index) => invalid.has(index) ? { invalid: true } : { formatted: await fs.promises.readFile(name, 'utf8') }));
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

// Markdown formatters leave Python and C# blocks alone; this formats them with Ruff and CSharpier.
async function formatCodeBlocks(markdown, file, cwd, env, signal, log) {
  // Prettier parses without a byte order mark and with \n line breaks; a file mixing line breaks, or with a lone \r, stays as it is.
  const bom = markdown.startsWith('\uFEFF') ? '\uFEFF' : '';
  const parts = markdown.slice(bom.length).split('\r\n');
  const eol = parts.length > 1 ? '\r\n' : '\n';
  if (parts.some(part => part.includes('\r') || (eol === '\r\n' && part.includes('\n')))) return markdown;
  const text = parts.join('\n');
  if (!codeFence.test(text)) return markdown;
  let blocks;
  try {
    blocks = await codeBlocks(text);
  } catch (error) {
    log(`Python and C# blocks stay as they are: ${error.message}`);
    return markdown;
  }
  if (!blocks.length) return markdown;
  const python = blocks.filter(({ language }) => language === 'python');
  const csharp = blocks.filter(({ language }) => language === 'csharp');
  const [pythonResults, csharpResults] = await Promise.all([formatPython(python, file, cwd, env, signal, log), formatCSharp(csharp, file, cwd, env, signal, log)]);
  signal?.throwIfAborted();
  const results = new Map([...python.map((block, index) => [block, pythonResults[index]]), ...csharp.map((block, index) => [block, csharpResults[index]])]);
  let output = '';
  let last = 0;
  const invalid = { python: [], csharp: [] };
  for (const block of blocks) {
    output += text.slice(last, block.start);
    const { formatted: printed, invalid: unparsable } = results.get(block) ?? {};
    // A project's config may make a tool print CRLF; the file's own line breaks are set again at the end.
    const formatted = printed?.replace(/\r\n?/g, '\n');
    // The fence's line in the formatted file, the one the user sees.
    if (unparsable) invalid[block.language].push(output.split('\n').length - 1);
    // Ruff and CSharpier end their output with a line break, which keeps the closing fence on a line of its own.
    const changed = formatted?.endsWith('\n') && formatted.trim() && formatted !== `${block.code}\n`;
    output += changed ? `${formatted.slice(0, -1).split('\n').map(block.lineOf).join('\n')}\n` : text.slice(block.start, block.end);
    last = block.end;
  }
  if (invalid.python.length) log(`ruff: the Python blocks at lines ${invalid.python.join(', ')} are not valid Python on their own and stay as they are.`);
  if (invalid.csharp.length) log(`csharpier: the C# blocks at lines ${invalid.csharp.join(', ')} are not valid C# on their own and stay as they are.`);
  return bom + (output + text.slice(last)).split('\n').join(eol);
}

async function format(input, file, oxc = {}, signal, log = () => {}) {
  const env = toolEnv(oxc.nodePath);
  const command = invocation(file, oxc);
  let output;
  try {
    output = await run(command, input, file, env, signal, log);
  } catch (error) {
    // The project's formatter decides only for file types it can parse; the rest, like TOML under Prettier, go to Oxfmt.
    // shortcut: only Prettier's message is recognized; add Biome's and dprint's when a project needs them.
    // The whole message after any warnings, because syntax errors quote the source and file name, which can contain these words.
    if (!/^prettier: (?:\[warn\] .*\n)*(?:\[error\] )?No parser could be inferred for file:? .*$/.test(error.message)) throw error;
    const fallback = { tool: 'oxfmt', cwd: command.cwd, reason: 'Prettier has no parser for this file' };
    output = await run(invocation(file, oxc, fallback), input, file, env, signal, log);
  }
  // dprint hands code blocks to its own plugins.
  if (command.tool === 'dprint' || !/\.(?:md|markdown)$/i.test(file)) return output;
  return formatCodeBlocks(output, file, command.cwd, env, signal, log);
}

module.exports = { detect, documentPath, invocation, format, oxcPath, oxcRules, stopPrettier };
