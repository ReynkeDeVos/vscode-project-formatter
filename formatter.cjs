const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const prettierConfigs = [
  '.prettierrc',
  ...['json', 'json5', 'yml', 'yaml', 'toml', 'js', 'mjs', 'cjs', 'ts', 'mts', 'cts'].map(ext => `.prettierrc.${ext}`),
  ...['js', 'mjs', 'cjs', 'ts', 'mts', 'cts'].map(ext => `prettier.config.${ext}`),
];
const oxfmtConfigs = [
  '.oxfmtrc.json', '.oxfmtrc.jsonc',
  ...['js', 'mjs', 'cjs', 'ts', 'mts', 'cts'].map(ext => `oxfmt.config.${ext}`),
];

function directories(file, workspace) {
  const result = [];
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    result.push(dir);
    if (dir === workspace || dir === os.homedir() || dir === path.dirname(dir) || fs.existsSync(path.join(dir, '.git'))) break;
  }
  return result;
}

function read(file) {
  try { return fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}

function detect(file, workspace) {
  const dirs = directories(file, workspace);
  const fallback = dirs.find(dir => fs.existsSync(path.join(dir, 'package.json'))) || dirs.at(-1);
  for (const dir of dirs) {
    // Home contains personal Oxfmt defaults, not a project formatter declaration.
    if (dir === os.homedir()) break;
    const source = read(path.join(dir, 'package.json'));
    const pkg = source ? JSON.parse(source) : {};
    // shortcut: recognize standard formatter commands; custom wrappers need an explicit VSCode formatter override.
    for (const [name, command] of Object.entries(pkg.scripts || {})) {
      if (!/^(?:format|fmt)(?::.*)?$/.test(name) || typeof command !== 'string') continue;
      const match = command.match(/(?:^|[\s;&|])(?:(bun)\s+fmt\b|(prettier|oxfmt|biome)\b)/);
      if (match) return { tool: match[1] || match[2], cwd: dir, reason: `package.json: ${name}` };
    }
    const bunfig = read(path.join(dir, 'bunfig.toml'));
    if (/^\s*\[\[?fmt(?:\.|\])/m.test(bunfig)) return { tool: 'bun', cwd: dir, reason: 'bunfig.toml: fmt' };
    for (const [tool, names] of [
      ['oxfmt', oxfmtConfigs], ['biome', ['biome.json', 'biome.jsonc']], ['prettier', prettierConfigs],
    ]) {
      const config = names.find(name => fs.existsSync(path.join(dir, name)));
      if (config) return { tool, cwd: dir, reason: config };
    }
    if (pkg.prettier !== undefined) return { tool: 'prettier', cwd: dir, reason: 'package.json: prettier' };
    const dependencies = { ...pkg.dependencies, ...pkg.devDependencies };
    const tool = ['oxfmt', '@biomejs/biome', 'prettier'].find(name => dependencies[name]);
    if (tool) return { tool: tool === '@biomejs/biome' ? 'biome' : tool, cwd: dir, reason: `dependency: ${tool}` };
  }
  return { tool: 'oxfmt', cwd: fallback, reason: 'Oxfmt fallback' };
}

function invocation(file, workspace, oxfmtPath) {
  const selection = detect(file, workspace);
  const local = directories(file).map(dir => path.join(dir, 'node_modules', '.bin', selection.tool))
    .find(candidate => fs.existsSync(candidate));
  const executable = local || (selection.tool === 'oxfmt' && oxfmtPath) || selection.tool;
  const args = selection.tool === 'bun' ? ['fmt'] : selection.tool === 'biome' ? ['format'] : [];
  args.push('--stdin-filepath', file);
  if (selection.tool === 'prettier') {
    const ignoreDir = directories(file).find(dir => fs.existsSync(path.join(dir, '.prettierignore')));
    if (ignoreDir) args.push('--ignore-path', path.join(ignoreDir, '.prettierignore'));
  }
  return { ...selection, executable, args };
}

async function format(input, file, workspace, oxfmtPath, nodePath, signal, log = () => {}) {
  const command = invocation(file, workspace, oxfmtPath);
  log(`${file}: ${command.tool} (${command.reason})`);
  const env = { ...process.env, PATH: [
    nodePath && path.dirname(nodePath), path.join(os.homedir(), '.local/share/mise/shims'), process.env.PATH,
  ].filter(Boolean).join(path.delimiter) };
  if (command.tool === 'bun') {
    const { stdout } = await promisify(execFile)(command.executable, ['--help'], { cwd: command.cwd, env, encoding: 'utf8', timeout: 5000, signal });
    if (!/^\s+fmt\s/m.test(stdout)) throw new Error('This Bun installation does not include bun fmt. File kept unchanged.');
    const source = read(path.join(command.cwd, 'package.json'));
    // shortcut: Bun dispatches a fmt package script before its formatter; refuse it until Bun exposes a direct native invocation.
    if (source && JSON.parse(source).scripts?.fmt) throw new Error('A package.json fmt script overrides bun fmt; configure this project formatter explicitly.');
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

module.exports = { detect, invocation, format };
