const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { parse: parseYaml } = require('yaml');

// Each formatter's npm package and the arguments that format stdin as a named file. Order is dependency precedence.
const tools = {
  oxfmt: { pkg: 'oxfmt', args: ['--stdin-filepath'] },
  biome: { pkg: '@biomejs/biome', args: ['format', '--stdin-file-path'] },
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

// The formatter one folder declares: script, bunfig, Oxfmt config, Biome config, Prettier config, then dependency.
function declared(dir, pkg) {
  // shortcut: recognize standard formatter commands; custom wrappers need an explicit VSCode formatter override.
  for (const [name, command] of Object.entries(pkg.scripts || {})) {
    if (!/^(?:format|fmt)(?::.*)?$/.test(name) || typeof command !== 'string') continue;
    const match = command.match(/(?:^|[\s;&|])(?:(bun)\s+fmt\b|(prettier|oxfmt|biome)\b)/);
    if (match) return { tool: match[1] || match[2], reason: `package.json: ${name}` };
  }
  if (/^\s*\[\[?fmt(?:\.|\])/m.test(readIfExists(path.join(dir, 'bunfig.toml')))) return { tool: 'bun', reason: 'bunfig.toml: fmt' };
  for (const [tool, names] of [
    ['oxfmt', oxfmtConfigs], ['biome', ['biome.json', 'biome.jsonc']],
  ]) {
    const config = names.find(name => fs.existsSync(path.join(dir, name)));
    if (config) return { tool, reason: config };
  }
  if (pkg.prettier) return { tool: 'prettier', reason: 'package.json: prettier' };
  let yamlPkg;
  try { yamlPkg = parseYaml(readIfExists(path.join(dir, 'package.yaml'))); }
  catch { /* Prettier skips invalid package.yaml files when searching for a config. */ }
  if (yamlPkg?.prettier) return { tool: 'prettier', reason: 'package.yaml: prettier' };
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

function invocation(file, oxfmtPath) {
  const selection = detect(file);
  const local = projectDirs(file).map(dir => path.join(dir, 'node_modules', '.bin', selection.tool))
    .find(candidate => fs.existsSync(candidate));
  // An explicit oxc.path.oxfmt beats node_modules, as in the Oxc extension.
  const executable = (selection.tool === 'oxfmt' && oxfmtPath) || local || selection.tool;
  return { ...selection, executable, args: [...tools[selection.tool].args, file] };
}

async function format(input, file, oxfmtPath, nodePath, signal, log = () => {}) {
  const command = invocation(file, oxfmtPath);
  log(`${file}: ${command.tool} (${command.reason})`);
  const env = { ...process.env, PATH: [
    nodePath && path.dirname(nodePath), process.env.PATH,
    // shortcut: only mise shims are added for editors started without the shell PATH; add other version managers when asked.
    path.join(process.env.MISE_DATA_DIR || path.join(os.homedir(), '.local/share/mise'), 'shims'),
  ].filter(Boolean).join(path.delimiter) };
  if (command.tool === 'bun') {
    const { stdout } = await promisify(execFile)(command.executable, ['--help'], { cwd: command.cwd, env, encoding: 'utf8', timeout: 5000, signal });
    if (!/^\s+fmt\s/m.test(stdout)) throw new Error('This Bun installation does not include bun fmt. File kept unchanged.');
  }
  return new Promise((resolve, reject) => {
    const child = execFile(command.executable, command.args, {
      cwd: command.cwd, env, encoding: 'utf8', timeout: 15000, maxBuffer: 16 * 1024 * 1024, signal,
    }, (error, stdout, stderr) => {
      if (stderr) log(stderr.trim());
      if (error) return reject(new Error(`${command.tool}: ${stderr.trim() || error.message}`, { cause: error }));
      if (input.trim() && !stdout.trim()) return reject(new Error(`${command.tool} returned empty output; file kept unchanged.`));
      resolve(stdout);
    });
    child.stdin.on('error', () => {}); // Process failures are reported by execFile's callback.
    child.stdin.end(input);
  });
}

module.exports = { detect, invocation, format, oxcPath };
