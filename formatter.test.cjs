const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { detect, invocation, format, oxcPath } = require('./formatter.cjs');

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
  fs.unlinkSync(path.join(root, '.prettierrc'));
  write('package.json', JSON.stringify({ devDependencies: { prettier: '^3' } }));
  assert.equal(detect(file).tool, 'prettier');
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

test('monorepo packages, Biome arguments and oxc.path settings', t => {
  const root = repo(t, 'project-formatter-monorepo-');
  const app = path.join(root, 'packages', 'app');
  const file = path.join(app, 'src', 'a.ts');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(path.join(app, 'package.json'), '{"name": "app"}');
  fs.writeFileSync(path.join(root, '.prettierrc'), '{}');
  assert.deepEqual(detect(file), { tool: 'prettier', reason: '.prettierrc', cwd: root });
  fs.writeFileSync(path.join(app, 'biome.json'), '{}');
  assert.deepEqual(invocation(file).args, ['format', '--stdin-file-path', file]);
  fs.renameSync(path.join(app, 'biome.json'), path.join(app, '.oxfmtrc.json'));
  const bin = path.join(root, 'node_modules', '.bin');
  fs.mkdirSync(bin, { recursive: true });
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
