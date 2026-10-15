const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { detect, invocation, format } = require('./formatter.cjs');

test('detect every documented Prettier config in its documented precedence', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prettier-configs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
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
    assert.equal(detect(file, root).tool, 'prettier', name);
    fs.unlinkSync(path.join(root, name));
  }
  for (const [name, content] of configs) fs.writeFileSync(path.join(root, name), content);
  for (const [name] of configs) {
    const reason = name.startsWith('package.') ? `${name}: prettier` : name;
    assert.equal(detect(file, root).reason, reason, name);
    fs.unlinkSync(path.join(root, name));
  }
  assert.equal(detect(file, root).tool, 'oxfmt');
});

test('package.yaml requires a top-level Prettier config, including quoted keys and aliases', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prettier-package-yaml-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'example.ts');
  for (const content of [
    '---\nprettier:\n  singleQuote: true\n',
    '"prettier": {singleQuote: true}\n',
    '{prettier: {singleQuote: true}}',
    'defaults: &options {singleQuote: true}\nprettier: *options\n',
    '? prettier\n: {singleQuote: true}\n',
  ]) {
    fs.writeFileSync(path.join(root, 'package.yaml'), content);
    assert.equal(detect(file, root).reason, 'package.yaml: prettier', content);
  }
  for (const content of [
    '', 'name: example\n', '# prettier: {}\n', 'scripts:\n  prettier: format\n',
    'description: |\n  prettier: {}\n', 'prettier: null\n', 'prettier: false\n', 'prettier: [broken',
  ]) {
    fs.writeFileSync(path.join(root, 'package.yaml'), content);
    assert.equal(detect(file, root).tool, 'oxfmt', content);
    fs.writeFileSync(path.join(root, '.prettierrc'), '{}');
    assert.equal(detect(file, root).reason, '.prettierrc', content);
    fs.unlinkSync(path.join(root, '.prettierrc'));
  }
});

test('project detection, nested configs, explicit commands, fallback and safe execution', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-formatter-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'src', 'example.ts');
  fs.mkdirSync(path.dirname(file));
  const write = (name, contents = '{}') => fs.writeFileSync(path.join(root, name), contents);
  assert.equal(detect(file, root).tool, 'oxfmt');
  write('.prettierrc');
  assert.equal(detect(file, root).tool, 'prettier');
  fs.mkdirSync(path.join(root, 'src', 'nested'));
  fs.writeFileSync(path.join(root, 'src', '.oxfmtrc.json'), '{}');
  assert.equal(detect(path.join(root, 'src', 'nested', 'a.ts'), root).tool, 'oxfmt');
  fs.unlinkSync(path.join(root, 'src', '.oxfmtrc.json'));
  write('package.json', JSON.stringify({ scripts: { format: 'bun fmt .' } }));
  assert.equal(detect(file, root).tool, 'bun');
  write('package.json');
  write('bunfig.toml', '[install]\nexact = true\n');
  assert.equal(detect(file, root).tool, 'prettier');
  write('bunfig.toml', '[fmt]\nsemi = false\n');
  assert.equal(detect(file, root).tool, 'bun');
  fs.unlinkSync(path.join(root, 'bunfig.toml'));
  write('biome.jsonc');
  assert.equal(detect(file, root).tool, 'biome');
  fs.unlinkSync(path.join(root, 'biome.jsonc'));
  fs.unlinkSync(path.join(root, '.prettierrc'));
  write('package.json', JSON.stringify({ devDependencies: { prettier: '^3' } }));
  assert.equal(detect(file, root).tool, 'prettier');
  write('package.json', JSON.stringify({ prettier: {} }));
  assert.equal(detect(file, root).tool, 'prettier');
  write('package.json', '{broken');
  assert.throws(() => detect(file, root), SyntaxError);
  write('package.json');
  write('.prettierrc');
  const bin = path.join(root, 'node_modules', '.bin');
  fs.mkdirSync(bin, { recursive: true });
  const prettier = path.join(bin, 'prettier');
  fs.writeFileSync(prettier, '#!/usr/bin/env node\nprocess.stdin.pipe(process.stdout);\n', { mode: 0o755 });
  const unusual = path.join(root, 'src', 'space " $(touch NEVER) \' file.ts');
  assert.equal(invocation(unusual, root).executable, prettier);
  assert.deepEqual(invocation(unusual, root).args, ['--stdin-filepath', unusual]);
  assert.equal(await format('const a=1;', unusual, root), 'const a=1;');
  assert.equal(fs.existsSync(path.join(root, 'NEVER')), false);
  fs.writeFileSync(prettier, '#!/usr/bin/env node\nprocess.stdin.resume();\n');
  await assert.rejects(format('const a=1;', file, root), /empty output/);
  fs.writeFileSync(prettier, '#!/usr/bin/env node\nprocess.stderr.write("syntax error"); process.exitCode=2;\n');
  await assert.rejects(format('broken', file, root), /syntax error/);
  write('package.json', JSON.stringify({ scripts: { format: 'bun fmt .' } }));
  const bun = path.join(bin, 'bun');
  fs.writeFileSync(bun, '#!/usr/bin/env node\nconsole.log("  run   Run a script");\n', { mode: 0o755 });
  await assert.rejects(format('const a=1;', file, root), /does not include bun fmt/);
  fs.writeFileSync(bun, '#!/usr/bin/env node\nif (process.argv[2] === "--help") console.log("  fmt   Format code"); else process.stdin.pipe(process.stdout);\n');
  assert.equal(await format('const a=1;', file, root), 'const a=1;');
  write('package.json', JSON.stringify({ scripts: { fmt: 'bun fmt .' } }));
  await assert.rejects(format('const a=1;', file, root), /script overrides bun fmt/);
});
