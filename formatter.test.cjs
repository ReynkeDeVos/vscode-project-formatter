const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { detect, invocation, format, oxcPath, stopPrettier } = require('./formatter.cjs');

// A throwaway repository root, so detection stops there instead of walking into the real temp directory.
function repo(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.git'));
  return root;
}

test('detect every documented Prettier config in its documented precedence', t => {
  const root = repo(t, 'prettier-configs-');
  const file = path.join(root, 'example.ts');
  const configs = [
    ['package.json', '{"prettier": {"singleQuote": true}}'],
    ['package.yaml', 'prettier:\n  singleQuote: true\n'],
    ['.prettierrc', 'singleQuote: true\n'],
    ['.prettierrc.json', '{"singleQuote": true}'],
    ['.prettierrc.yml', 'singleQuote: true\n'],
    ['.prettierrc.yaml', 'singleQuote: true\n'],
    ['.prettierrc.json5', '{singleQuote: true}'],
    ['.prettierrc.js', 'module.exports = {singleQuote: true};'],
    ['prettier.config.js', 'module.exports = {singleQuote: true};'],
    ['.prettierrc.ts', 'module.exports = {singleQuote: true};'],
    ['prettier.config.ts', 'module.exports = {singleQuote: true};'],
    ['.prettierrc.mjs', 'export default {singleQuote: true};'],
    ['prettier.config.mjs', 'export default {singleQuote: true};'],
    ['.prettierrc.mts', 'export default {singleQuote: true};'],
    ['prettier.config.mts', 'export default {singleQuote: true};'],
    ['.prettierrc.cjs', 'module.exports = {singleQuote: true};'],
    ['prettier.config.cjs', 'module.exports = {singleQuote: true};'],
    ['.prettierrc.cts', 'module.exports = {singleQuote: true};'],
    ['prettier.config.cts', 'module.exports = {singleQuote: true};'],
    ['.prettierrc.toml', 'singleQuote = true\n'],
  ];
  for (const [name, content] of configs) {
    fs.writeFileSync(path.join(root, name), content);
    assert.equal(detect(file).tool, 'prettier', name);
    fs.unlinkSync(path.join(root, name));
  }
  for (const [name, content] of configs) fs.writeFileSync(path.join(root, name), content);
  for (const [name] of configs) {
    const reason = name.startsWith('package.') ? `${name}: prettier` : name;
    assert.equal(detect(file).reason, reason, name);
    fs.unlinkSync(path.join(root, name));
  }
  assert.equal(detect(file).tool, 'oxfmt');
});

test('package.yaml requires a top-level Prettier config, including quoted keys and aliases', t => {
  const root = repo(t, 'prettier-package-yaml-');
  const file = path.join(root, 'example.ts');
  for (const content of [
    '---\nprettier:\n  singleQuote: true\n',
    '"prettier": {singleQuote: true}\n',
    '{prettier: {singleQuote: true}}',
    'defaults: &options {singleQuote: true}\nprettier: *options\n',
    '? prettier\n: {singleQuote: true}\n',
  ]) {
    fs.writeFileSync(path.join(root, 'package.yaml'), content);
    assert.equal(detect(file).reason, 'package.yaml: prettier', content);
  }
  for (const content of [
    '', 'name: example\n', '# prettier: {}\n', 'scripts:\n  prettier: format\n',
    'description: |\n  prettier: {}\n', 'prettier: null\n', 'prettier: false\n', 'prettier: [broken',
  ]) {
    fs.writeFileSync(path.join(root, 'package.yaml'), content);
    assert.equal(detect(file).tool, 'oxfmt', content);
    fs.writeFileSync(path.join(root, '.prettierrc'), '{}');
    assert.equal(detect(file).reason, '.prettierrc', content);
    fs.unlinkSync(path.join(root, '.prettierrc'));
  }
});

test('project detection, nested configs, explicit commands, fallback and safe execution', async t => {
  const root = repo(t, 'project-formatter-');
  const file = path.join(root, 'src', 'example.ts');
  fs.mkdirSync(path.dirname(file));
  const write = (name, contents = '{}') => fs.writeFileSync(path.join(root, name), contents);
  assert.equal(detect(file).tool, 'oxfmt');
  write('.prettierrc');
  assert.equal(detect(file).tool, 'prettier');
  fs.mkdirSync(path.join(root, 'src', 'nested'));
  fs.writeFileSync(path.join(root, 'src', '.oxfmtrc.json'), '{}');
  assert.equal(detect(path.join(root, 'src', 'nested', 'a.ts')).tool, 'oxfmt');
  fs.unlinkSync(path.join(root, 'src', '.oxfmtrc.json'));
  write('package.json', JSON.stringify({ scripts: { format: 'bun fmt .' } }));
  assert.equal(detect(file).tool, 'bun');
  write('package.json');
  write('bunfig.toml', '[install]\nexact = true\n');
  assert.equal(detect(file).tool, 'prettier');
  write('bunfig.toml', '[fmt]\nsemi = false\n');
  assert.equal(detect(file).tool, 'bun');
  fs.unlinkSync(path.join(root, 'bunfig.toml'));
  write('biome.jsonc');
  assert.equal(detect(file).tool, 'biome');
  fs.unlinkSync(path.join(root, 'biome.jsonc'));
  write('.dprint.jsonc');
  assert.equal(detect(file).tool, 'dprint');
  fs.unlinkSync(path.join(root, '.dprint.jsonc'));
  write('package.json', JSON.stringify({ scripts: { 'fmt:check': 'dprint check' } }));
  assert.equal(detect(file).tool, 'dprint');
  write('package.json');
  fs.unlinkSync(path.join(root, '.prettierrc'));
  write('package.json', JSON.stringify({ devDependencies: { prettier: '^3' } }));
  assert.equal(detect(file).tool, 'prettier');
  write('package.json', JSON.stringify({ devDependencies: { prettier: '^3', dprint: '^0.50' } }));
  assert.equal(detect(file).tool, 'dprint');
  write('package.json', JSON.stringify({ prettier: {} }));
  assert.equal(detect(file).tool, 'prettier');
  write('package.json', '{broken');
  assert.throws(() => detect(file), SyntaxError);
  write('package.json');
  write('.prettierrc');
  const bin = path.join(root, 'node_modules', '.bin');
  fs.mkdirSync(bin, { recursive: true });
  const prettier = path.join(bin, 'prettier');
  fs.writeFileSync(prettier, '#!/usr/bin/env node\nprocess.stdin.pipe(process.stdout);\n', { mode: 0o755 });
  const unusual = path.join(root, 'src', 'space " $(touch NEVER) \' file.ts');
  write('.prettierignore', 'dist/\n'); // Prettier reads it, and .gitignore, from cwd itself.
  assert.equal(invocation(unusual).executable, prettier);
  assert.deepEqual(invocation(unusual).args, ['--stdin-filepath', unusual]);
  assert.equal(await format('const a=1;', unusual), 'const a=1;');
  assert.equal(fs.existsSync(path.join(root, 'NEVER')), false);
  fs.writeFileSync(prettier, '#!/usr/bin/env node\nprocess.stdin.resume();\n');
  await assert.rejects(format('const a=1;', file), /empty output/);
  fs.writeFileSync(prettier, '#!/usr/bin/env node\nprocess.stderr.write("syntax error"); process.exitCode=2;\n');
  await assert.rejects(format('broken', file), /syntax error/);
  write('package.json', JSON.stringify({ scripts: { format: 'bun fmt .' } }));
  const bun = path.join(bin, 'bun');
  fs.writeFileSync(bun, '#!/usr/bin/env node\nconsole.log("  run   Run a script");\n', { mode: 0o755 });
  await assert.rejects(format('const a=1;', file), /does not include bun fmt/);
  fs.writeFileSync(bun, '#!/usr/bin/env node\nif (process.argv[2] === "--help") console.log("  fmt   Format code"); else process.stdin.pipe(process.stdout);\n');
  assert.equal(await format('const a=1;', file), 'const a=1;');
  write('package.json', JSON.stringify({ scripts: { fmt: 'bun fmt .' } }));
  await assert.rejects(format('const a=1;', file), /script overrides bun fmt/);
});

test('monorepo packages, Biome and dprint programs, and oxc.path settings', t => {
  const root = repo(t, 'project-formatter-monorepo-');
  const app = path.join(root, 'packages', 'app');
  const file = path.join(app, 'src', 'a.ts');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(path.join(app, 'package.json'), '{"name": "app"}');
  fs.writeFileSync(path.join(root, '.prettierrc'), '{}');
  assert.deepEqual(detect(file), { tool: 'prettier', reason: '.prettierrc', cwd: root });
  fs.writeFileSync(path.join(app, 'biome.json'), '{}');
  assert.deepEqual(invocation(file).args, ['format', '--stdin-file-path', file]);
  // Biome and dprint skip their Node launcher once their native program is installed.
  const modules = path.join(root, 'node_modules');
  const bin = path.join(modules, '.bin');
  const exe = process.platform === 'win32' ? '.exe' : '';
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'biome'), '');
  assert.equal(invocation(file).executable, path.join(bin, 'biome'));
  const store = path.join(modules, '.pnpm', 'node_modules', '@biomejs'); // pnpm links @biomejs/biome next to its platform package.
  const biome = path.join(store, `cli-${process.platform}-${process.arch}-musl`, `biome${exe}`);
  fs.mkdirSync(path.dirname(biome), { recursive: true });
  fs.mkdirSync(path.join(store, 'biome'));
  fs.mkdirSync(path.join(modules, '@biomejs'));
  fs.symlinkSync(path.join(store, 'biome'), path.join(modules, '@biomejs', 'biome'), 'junction');
  fs.writeFileSync(biome, '');
  assert.equal(invocation(file).executable, fs.realpathSync(biome));
  fs.renameSync(path.join(app, 'biome.json'), path.join(app, 'dprint.json'));
  assert.deepEqual(invocation(file).args, ['fmt', '--stdin', file]);
  fs.writeFileSync(path.join(bin, 'dprint'), '');
  assert.equal(invocation(file).executable, path.join(bin, 'dprint'));
  fs.mkdirSync(path.join(modules, 'dprint'));
  fs.writeFileSync(path.join(modules, 'dprint', `dprint${exe}`), '');
  assert.equal(invocation(file).executable, path.join(modules, 'dprint', `dprint${exe}`));
  fs.renameSync(path.join(app, 'dprint.json'), path.join(app, '.oxfmtrc.json'));
  fs.writeFileSync(path.join(bin, 'oxfmt'), '');
  assert.equal(invocation(file).executable, path.join(bin, 'oxfmt'));
  assert.equal(invocation(file, '/opt/oxfmt').executable, '/opt/oxfmt');
  process.env.PROJECT_FORMATTER_TEST = '/env';
  t.after(() => delete process.env.PROJECT_FORMATTER_TEST);
  assert.equal(oxcPath('${env:PROJECT_FORMATTER_TEST}/oxfmt', root), '/env/oxfmt');
  assert.equal(oxcPath('${userHome}/bin/oxfmt'), path.join(os.homedir(), 'bin', 'oxfmt'));
  assert.equal(oxcPath('bin/oxfmt', root), path.join(root, 'bin', 'oxfmt'));
  assert.equal(oxcPath('${workspaceFolder}/oxfmt', root), path.join(root, '${workspaceFolder}', 'oxfmt'));
  for (const unset of [undefined, '', '${env:PROJECT_FORMATTER_UNSET}', 'bin/oxfmt']) assert.ok(!oxcPath(unset), unset);
});

test('Prettier 3 stays loaded per project, restarts when its config changes and exits when unused', async t => {
  const root = repo(t, 'prettier-process-');
  t.after(stopPrettier);
  const file = path.join(root, 'a.ts');
  const modules = path.join(root, 'node_modules');
  fs.mkdirSync(path.join(modules, '.bin'), { recursive: true });
  fs.mkdirSync(path.join(modules, 'prettier'));
  fs.writeFileSync(path.join(modules, '.bin', 'prettier'), '');
  // A stand-in for Prettier's API; require caches the config, so only a fresh process sees an edit.
  fs.writeFileSync(path.join(modules, 'prettier', 'index.cjs'), `
    exports.getFileInfo = async (file, { ignorePath }) => ({ ignored: ignorePath.includes('.prettierignore') && file.endsWith('ignored.ts') });
    exports.resolveConfig = async () => require(process.cwd() + '/.prettierrc.cjs');
    exports.format = async (text, options) => {
      if (text === 'broken') throw new Error('syntax error');
      return text === 'empty' ? '' : options.prefix + process.pid;
    };
  `);
  const config = path.join(root, '.prettierrc.cjs');
  fs.writeFileSync(config, 'module.exports = { prefix: "a" };');
  assert.equal(invocation(file).prettier, path.join(modules, 'prettier', 'index.cjs'));
  const first = await format('x', file);
  assert.match(first, /^a\d+$/);
  assert.equal(await format('y', file), first);
  assert.equal(await format('keep', path.join(root, 'ignored.ts')), 'keep');
  await assert.rejects(format('broken', file), /prettier: syntax error/);
  await assert.rejects(format('empty', file), /empty output/);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(format('x', file, undefined, undefined, abort.signal), /aborted/);
  fs.writeFileSync(config, 'module.exports = { prefix: "b" };');
  fs.utimesSync(config, new Date(), new Date(Date.now() + 1000));
  const second = await format('x', file);
  assert.match(second, /^b\d+$/);
  assert.notEqual(second.slice(1), first.slice(1));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  assert.equal(await format('x', file), second);
  t.mock.timers.tick(15 * 60 * 1000);
  const third = await format('x', file);
  assert.match(third, /^b\d+$/);
  assert.notEqual(third, second);
  const alive = pid => { try { return process.kill(pid, 0); } catch { return false; } };
  while (alive(Number(second.slice(1)))) await new Promise(setImmediate);
  fs.rmSync(path.join(modules, 'prettier', 'index.cjs'));
  assert.equal(invocation(file).prettier, undefined);
});
