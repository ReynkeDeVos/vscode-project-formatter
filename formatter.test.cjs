const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { detect, documentPath, invocation, format, oxcPath, oxcRules, stopPrettier } = require('./formatter.cjs');

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
  assert.equal(invocation(file, { oxfmtPath: '/opt/oxfmt' }).executable, '/opt/oxfmt');
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
  await assert.rejects(format('x', file, undefined, abort.signal), /aborted/);
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

test('documents without a file of their own keep their location and name their syntax', () => {
  const doc = (scheme, fileName, languageId) => ({ uri: { scheme }, fileName, languageId });
  // In the order VS Code lists them: another extension adds to jsonc before its own contribution.
  const languages = [
    { id: 'jsonc', extensions: ['.code-workspace'] },
    { id: 'jsonc', filenames: ['.eslintrc.json'] },
    { id: 'jsonc', extensions: ['.jsonc', '.eslintrc'] },
    { id: 'javascript', extensions: ['.pac', '.js'] },
    { id: 'typescript', extensions: ['.ts', '.cts'] },
    { id: 'json', extensions: ['.json', '.ipynb'] },
    { id: 'markdown', extensions: ['.md', '.markdown', '.mdtext'] },
    { id: 'future', extensions: ['.ftr'] },
  ];
  const place = (document, root) => documentPath(document, root, languages, ['code-workspace', 'jsonc', 'json', 'cts', 'ts', 'js', 'md', 'markdown']);
  assert.equal(place(doc('file', '/p/tsconfig.json', 'jsonc'), '/root'), '/p/tsconfig.json');
  assert.equal(place(doc('vscode-userdata', '/u/settings.json', 'jsonc'), '/root'), '/u/settings.json.jsonc');
  assert.equal(place(doc('vscode-userdata', '/u/mcp.jsonc', 'jsonc'), '/root'), '/u/mcp.jsonc');
  assert.equal(place(doc('untitled', 'Untitled-1', 'typescript'), '/root'), '/root/Untitled-1.ts');
  assert.equal(place(doc('untitled', 'Untitled-1', 'javascript'), '/root'), '/root/Untitled-1.js');
  assert.equal(place(doc('untitled', 'Untitled-1', 'markdown'), undefined), path.join(os.homedir(), 'Untitled-1.md'));
  assert.equal(place(doc('vscode-notebook-cell', '/p/a.ipynb', 'markdown'), '/root'), '/p/a.ipynb.md');
  // A name that already fits stays, so config overrides for it still apply.
  assert.equal(place(doc('untitled', '/p/new.md', 'markdown'), '/root'), '/p/new.md');
  assert.equal(place(doc('untitled', '/p/new.markdown', 'markdown'), '/root'), '/p/new.markdown');
  // A name Oxfmt cannot read gets one it can.
  assert.equal(place(doc('vscode-notebook-cell', '/p/a.ipynb', 'json'), '/root'), '/p/a.ipynb.json');
  assert.equal(place(doc('untitled', '/p/x.mdtext', 'markdown'), '/root'), '/p/x.mdtext.md');
  // A language Oxc adds later works without a change here, and one nothing contributes stays as named.
  assert.equal(place(doc('untitled', 'Untitled-1', 'future'), '/root'), '/root/Untitled-1.ftr');
  assert.equal(place(doc('untitled', 'Untitled-1', 'unknown'), '/root'), '/root/Untitled-1');
});

test('the Oxc rules come from its installed copy', t => {
  const root = repo(t, 'project-formatter-oxc-rules-');
  fs.mkdirSync(path.join(root, 'out'));
  const packageJSON = { main: './out/main.js', activationEvents: ['onLanguage:json', 'onCommand:x', 'onLanguage:yaml'] };
  const rules = bundle => {
    fs.writeFileSync(path.join(root, 'out', 'main.js'), bundle);
    return oxcRules({ extensionPath: root, packageJSON });
  };
  const languages = [{ language: 'json' }, { language: 'yaml' }];
  const selector = '{this.documentSelectors=[{pattern:`**/*.{${yi.join(`,`)}}`,scheme:`file`},...$b.map(e=>({pattern:`**/${e}`,scheme:`file`})),...xi.map(e=>({language:e}))]}';
  // Both minified list forms.
  const found = rules(`const yi=/* @__PURE__ */ \`ts,json.example\`.split(\`,\`),$b=[\`README\`,\`.babelrc\`];class S${selector}`);
  assert.deepEqual(found.extensions, ['ts', 'json.example']);
  assert.deepEqual(found.selector, [
    { pattern: '**/*.{ts,json.example}', scheme: 'file' },
    { pattern: '**/README', scheme: 'file' },
    { pattern: '**/.babelrc', scheme: 'file' },
    ...languages,
  ]);
  // A bundle of another shape, or none, or a name used for two lists, leaves only the languages.
  for (const shadowed of ['yi', '$b']) {
    assert.deepEqual(rules(`function f(){const ${shadowed}=[\`other\`]}const yi=[\`ts\`],$b=[\`README\`];class S${selector}`), { extensions: [], selector: languages });
  }
  assert.deepEqual(rules('this.documentSelectors=somethingElse'), { extensions: [], selector: languages });
  assert.deepEqual(rules(`class S${selector}`), { extensions: [], selector: languages });
  fs.rmSync(path.join(root, 'out', 'main.js'));
  assert.deepEqual(oxcRules({ extensionPath: root, packageJSON }), { extensions: [], selector: languages });
});

// Fails when an Oxc update changes its bundle's shape, and on a machine without Oxc there is nothing to read.
const extensionsDir = path.join(os.homedir(), '.vscode', 'extensions');
const installedOxc = fs.existsSync(extensionsDir) && fs.readdirSync(extensionsDir).filter(name => name.startsWith('oxc.oxc-vscode-')).sort().at(-1);
test('the installed Oxc extension can still be read', { skip: !installedOxc }, () => {
  const extensionPath = path.join(extensionsDir, installedOxc);
  const { extensions, selector } = oxcRules({ extensionPath, packageJSON: JSON.parse(fs.readFileSync(path.join(extensionPath, 'package.json'), 'utf8')) });
  assert.ok(extensions.includes('ts') && extensions.includes('json'));
  assert.ok(selector.some(({ pattern }) => pattern === '**/.prettierrc'));
  assert.ok(selector.some(({ language }) => language === 'jsonc'));
  assert.ok(!selector.some(({ pattern }) => pattern === '**/.eslintrc'));
});

test('Oxfmt runs with the Oxc settings from the workspace folder, other formatters as before', t => {
  const root = repo(t, 'project-formatter-oxfmt-settings-');
  const file = path.join(root, 'a.ts');
  const oxc = { oxfmtPath: '/opt/oxfmt', configPath: '/c/custom.json', disableNestedConfig: true, folder: '/workspace' };
  const flags = ['--config=/c/custom.json', '--disable-nested-config', '--stdin-filepath', file];
  const command = invocation(file, oxc);
  assert.equal(command.cwd, '/workspace');
  assert.deepEqual(command.args, flags);
  assert.deepEqual(invocation(file).args, ['--stdin-filepath', file]);
  assert.equal(invocation(file).cwd, root);
  fs.writeFileSync(path.join(root, '.prettierrc'), '{}');
  const prettier = invocation(file, oxc);
  assert.equal(prettier.cwd, root);
  assert.deepEqual(prettier.args, ['--stdin-filepath', file]);
  // The hand-over from Prettier counts as Oxfmt too.
  const fallback = invocation(file, oxc, { tool: 'oxfmt', cwd: root, reason: 'Prettier has no parser for this file' });
  assert.equal(fallback.cwd, '/workspace');
  assert.deepEqual(fallback.args, flags);
});

test('Oxfmt takes file types Prettier cannot parse and skips names it does not know', async t => {
  const root = repo(t, 'project-formatter-fallback-');
  const script = (name, body) => {
    const file = path.join(root, name);
    fs.writeFileSync(file, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
    return file;
  };
  fs.writeFileSync(path.join(root, '.prettierrc'), '{}');
  fs.mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true });
  script('node_modules/.bin/prettier', 'console.error("[error] No parser could be inferred for file \\"a.toml\\"."); process.exitCode = 2;');
  const oxfmt = { oxfmtPath: script('oxfmt', 'console.log("from oxfmt");') };
  const file = path.join(root, 'a.toml');
  const log = [];
  assert.equal(await format('a=1\n', file, oxfmt, undefined, message => log.push(message)), 'from oxfmt\n');
  assert.ok(log.some(message => message.includes('oxfmt (Prettier has no parser for this file)')));
  script('oxfmt', 'console.error("Unsupported file type for stdin-filepath"); process.exitCode = 1;');
  assert.equal(await format('a=1\n', file, oxfmt), 'a=1\n');
  // Syntax errors quote the source, which can contain the same words as the diagnostics above.
  script('oxfmt', 'console.error("  x Unexpected token\\n 1 | Unsupported file type for stdin-filepath"); process.exitCode = 2;');
  await assert.rejects(format('a=1\n', file, oxfmt), /Unexpected token/);
  script('oxfmt', 'console.log("from oxfmt");');
  script('node_modules/.bin/prettier', 'console.error("[warn] Ignored unknown option\\n[error] No parser could be inferred for file \\"a.toml\\"."); process.exitCode = 2;');
  assert.equal(await format('a=1\n', file, oxfmt), 'from oxfmt\n');
  script('node_modules/.bin/prettier', 'console.error("[error] a.js: SyntaxError: Unexpected token (1:1)\\n[error] > 1 | No parser could be inferred for file \\"x\\""); process.exitCode = 2;');
  await assert.rejects(format('a=1\n', file, oxfmt), /prettier: .*SyntaxError/);
  // A file name can hold a newline followed by the same words.
  for (const error of [
    '[error] /p/a\\n[error] No parser could be inferred for file x.js: SyntaxError: Unexpected token (1:1)',
    '[error] /p/a\\n[error] No parser could be inferred for file \\"x\\".\\n[error] b.js: SyntaxError: Unexpected token (1:1)',
  ]) {
    script('node_modules/.bin/prettier', `console.error('${error}'); process.exitCode = 2;`);
    await assert.rejects(format('a=1\n', file, oxfmt), /prettier: .*\/p\/a/);
  }
  // Prettier 2 words it differently.
  script('node_modules/.bin/prettier', 'console.error("[error] No parser could be inferred for file: /p/a.toml"); process.exitCode = 2;');
  assert.equal(await format('a=1\n', file, oxfmt), 'from oxfmt\n');
});

test('the kept-loaded Prettier also hands file types it cannot parse to Oxfmt', async t => {
  const root = repo(t, 'project-formatter-worker-');
  t.after(stopPrettier);
  const modules = path.join(root, 'node_modules');
  fs.mkdirSync(path.join(modules, '.bin'), { recursive: true });
  fs.mkdirSync(path.join(modules, 'prettier'));
  fs.writeFileSync(path.join(modules, '.bin', 'prettier'), '');
  fs.writeFileSync(path.join(root, '.prettierrc'), '{}');
  // Real Prettier 3 messages: the first has no parser, the second is a syntax error quoting the source.
  fs.writeFileSync(path.join(modules, 'prettier', 'index.cjs'), `
    exports.getFileInfo = async () => ({ ignored: false });
    exports.resolveConfig = async () => ({});
    exports.format = async (text, { filepath }) => {
      if (filepath.endsWith('.toml')) throw new Error('No parser could be inferred for file "a.toml".');
      throw new Error('Unexpected token (1:1)\\n> 1 | No parser could be inferred for file "x"\\n    | ^');
    };
  `);
  const oxfmt = { oxfmtPath: path.join(root, 'oxfmt') };
  fs.writeFileSync(oxfmt.oxfmtPath, '#!/usr/bin/env node\nconsole.log("from oxfmt");\n', { mode: 0o755 });
  assert.equal(await format('a=1\n', path.join(root, 'a.toml'), oxfmt), 'from oxfmt\n');
  await assert.rejects(format('a=1\n', path.join(root, 'a.js'), oxfmt), /prettier: Unexpected token/);
});

// Stand-ins for Ruff and CSharpier on a PATH without the real ones, so their work is easy to see: Ruff's spaces out `=`,
// CSharpier's capitalizes. A block with `broken` is not valid code on its own.
function codeBlockTools(t, root) {
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const { PATH, MISE_DATA_DIR } = process.env;
  process.env.PATH = [bin, path.dirname(process.execPath)].join(path.delimiter);
  process.env.MISE_DATA_DIR = root; // No mise shims either.
  t.after(() => {
    process.env.PATH = PATH;
    if (MISE_DATA_DIR === undefined) delete process.env.MISE_DATA_DIR; else process.env.MISE_DATA_DIR = MISE_DATA_DIR;
  });
  const calls = path.join(root, 'calls');
  const script = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify([path.basename(__filename), ...process.argv.slice(2)]) + '\\n');
${body}\n`, { mode: 0o755 });
  script('ruff', `let text = '';
process.stdin.on('data', data => text += data).on('end', () => {
  if (text.includes('broken')) { console.error('error: Failed to parse snippet.py:1:1: Expected an expression'); process.exitCode = 2; }
  else process.stdout.write(text.includes('dedent') ? text.replace(/^ +/gm, '') : text.replaceAll('=', ' = '));
});`);
  script('csharpier', `const dir = process.argv.at(-1);
for (const name of fs.readdirSync(dir)) {
  const file = path.join(dir, name), code = fs.readFileSync(file, 'utf8');
  if (code.includes('broken')) { console.log('Error ' + file + ' - Was not formatted due to syntax errors.'); process.exitCode = 1; }
  else if (code.includes('crash')) { fs.writeFileSync(file, 'VAR'); console.error('Unhandled exception: disk full'); process.exitCode = 2; }
  else fs.writeFileSync(file, code.includes('no break') ? code.toUpperCase().trimEnd() : code.toUpperCase());
}`);
  return {
    calls: () => fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [],
    remove: name => fs.rmSync(path.join(bin, name)),
  };
}

// A stand-in for a Markdown formatter: it fixes a heading's spacing, which tells it apart from one ignoring the file, and, as
// Prettier, names the Markdown parser for `--file-info`.
const markdownFormatter = `#!/usr/bin/env node
if (process.argv[2] === '--file-info') console.log('{ "ignored": false, "inferredParser": "markdown" }');
else {
  let text = '';
  process.stdin.on('data', data => text += data).on('end', () => process.stdout.write(text.replace(/^#  /gm, '# ')));
}
`;

// That formatter as Oxfmt, in a package laid out as npm installs it: its own command file, linked into `node_modules/.bin`, and a
// Markdown chunk shaped like Oxfmt's, made of the Prettier in node_modules.
function fakeOxfmt(root) {
  const modules = path.join(root, 'tools', 'node_modules');
  const plugin = path.join(path.dirname(require.resolve('prettier/package.json')), 'plugins', 'markdown.mjs');
  fs.mkdirSync(path.join(modules, 'oxfmt', 'dist'), { recursive: true });
  fs.mkdirSync(path.join(modules, 'oxfmt', 'bin'));
  fs.mkdirSync(path.join(modules, '.bin'), { recursive: true });
  fs.writeFileSync(path.join(modules, 'oxfmt', 'package.json'), '{"name": "oxfmt", "type": "module", "bin": {"oxfmt": "bin/oxfmt"}}');
  fs.writeFileSync(path.join(modules, 'oxfmt', 'dist', 'markdown-Ab12_c.js'), `export { parsers } from ${JSON.stringify(pathToFileURL(plugin).href)};\n`);
  fs.writeFileSync(path.join(modules, 'oxfmt', 'bin', 'oxfmt'), markdownFormatter, { mode: 0o755 });
  const bin = path.join(modules, '.bin', 'oxfmt');
  fs.symlinkSync(path.join('..', 'oxfmt', 'bin', 'oxfmt'), bin);
  return bin;
}

// A fake Prettier 3 package in `node_modules`: its API, its command linked into `.bin`, and this repository's Markdown plugin.
function fakePrettier(modules) {
  const prettier = path.join(modules, 'prettier');
  fs.mkdirSync(path.join(prettier, 'plugins'), { recursive: true });
  fs.mkdirSync(path.join(prettier, 'bin'));
  fs.mkdirSync(path.join(modules, '.bin'), { recursive: true });
  fs.writeFileSync(path.join(prettier, 'package.json'), '{"name": "prettier", "main": "index.cjs", "bin": "./bin/prettier.cjs"}');
  fs.writeFileSync(path.join(prettier, 'index.cjs'), `exports.getFileInfo = async () => ({ ignored: false, inferredParser: 'markdown' });
exports.resolveConfig = async () => ({});
exports.format = async text => text.replace(/^#  /gm, '# ');`);
  fs.writeFileSync(path.join(prettier, 'plugins', 'markdown.js'), `module.exports = require(${JSON.stringify(require.resolve('prettier/plugins/markdown'))});`);
  fs.writeFileSync(path.join(prettier, 'bin', 'prettier.cjs'), markdownFormatter, { mode: 0o755 });
  fs.symlinkSync(path.join('..', 'prettier', 'bin', 'prettier.cjs'), path.join(modules, '.bin', 'prettier'));
}

test('Markdown: Ruff formats the Python blocks and CSharpier the C# blocks the parser finds', async t => {
  const root = repo(t, 'project-formatter-code-blocks-');
  const tools = codeBlockTools(t, root);
  const oxfmt = { oxfmtPath: fakeOxfmt(root) };
  const file = path.join(root, 'docs', 'lesson.md');
  fs.mkdirSync(path.dirname(file));
  const log = [];
  const run = (input, name = file) => format(input, name, oxfmt, undefined, message => log.push(message));
  // At the top, in a list and in a blockquote: each line keeps its prefix, a blank line its own.
  const input = [
    '# Lesson', '',
    '```py title="a.py"', 'x=1', '```', '',
    '1. Step', '', '   ```csharp', '   var a;', '', '   var b;', '   ```', '',
    '> ```cs', '> var q;', '>', '> var r;', '> ```', '',
    '~~~C#', 'var t;', '~~~', '',
  ].join('\n');
  assert.equal(await run(input), input.replace('x=1', 'x = 1').replace('var a;\n\n   var b;', 'VAR A;\n\n   VAR B;')
    .replace('var q;\n>\n> var r;', 'VAR Q;\n>\n> VAR R;').replace('var t;', 'VAR T;'));
  // Ruff once per block, named for the document's folder; CSharpier once for all blocks, in a temporary folder it leaves behind.
  const calls = tools.calls();
  assert.deepEqual(calls.filter(([name]) => name === 'ruff'), [['ruff', 'format', '--stdin-filename', path.join(root, 'docs', 'snippet.py'), '-']]);
  const csharpier = calls.filter(([name]) => name === 'csharpier');
  assert.equal(csharpier.length, 1);
  assert.deepEqual(csharpier[0].slice(1, -1), ['format', '--no-cache', '--no-msbuild-check']);
  assert.equal(fs.existsSync(csharpier[0].at(-1)), false);
  // With a byte order mark and CRLF line breaks, which stay; a file mixing line breaks stays as it is.
  assert.equal(await run('﻿```py\r\nx=1\r\n```\r\n'), '﻿```py\r\nx = 1\r\n```\r\n');
  for (const mixed of ['```py\r\nx=1\n```\r\n', '```py\rx=1\r```\r']) assert.equal(await run(mixed), mixed);
  // Fences that are text as Prettier reads them: in front matter (YAML ending with `---` or `...`, TOML, after a byte order mark),
  // an indented code block, HTML, math, a list's longer fence and a definition's indented code; and a block without its closing fence.
  const runs = tools.calls().length;
  for (const literal of [
    '---\na: |\n  ```py\n  x=1\n  ```\n---\n',
    '---\na: 1\n...\n```py\nx=1\n```\n---\n',
    "+++\na = '''\n...\n```py\nx=1\n```\n'''\n+++\n",
    '﻿---\na: |\n  ```py\n  x=1\n  ```\n---\n',
    '    ```py\n    x=1\n\nprose=1\n',
    '<!--\n```py\nx=1\n```\n-->\n',
    '<div>\n\f\n```py\nx=1\n```\n</div>\n',
    '$$\n```py\nx=1\n```\n$$\n',
    '- ````text\n  ```py\n  x=1\n  ```\n  ````\n',
    'Term\n: intro\n\n    ```py\n    x=1\n    ```\n',
    '```py\nx=1\n',
  ]) assert.equal(await run(literal), literal);
  assert.equal(tools.calls().length, runs);
  // Code whose lines carry different prefixes, here a fence indented beyond its list item, stays as it is.
  const indented = '1. a\n\n    ```py\n    x=1\n   y=2\n    ```\n';
  assert.equal(await run(indented), indented);
  // Code a `prettier-ignore` comment covers stays as it is, as Prettier keeps it.
  const ignoredCode = '<!-- prettier-ignore -->\n```py\nx=1\n```\n\n<!-- prettier-ignore-start -->\n\n```py\nx=1\n```\n\n<!-- prettier-ignore-end -->\n\n```py\ny=1\n```\n';
  assert.equal(await run(ignoredCode), ignoredCode.replace('y=1', 'y = 1'));
  // Formatted code that would close its block early, like a fence in a dedented string, leaves the block as it is.
  log.length = 0;
  const dedent = '```py\n"""dedent\n    ```\n"""\n```\n\nOutside.\n';
  assert.equal(await run(dedent), dedent);
  assert.ok(log.includes('The Python block at line 1 stays as it is: its formatted code would close it early.'), log.join('\n'));
  // A file the formatter ignores, it returns unchanged; its blocks stay too.
  const formatter = fs.readFileSync(oxfmt.oxfmtPath, 'utf8');
  fs.writeFileSync(oxfmt.oxfmtPath, '#!/usr/bin/env node\nprocess.stdin.pipe(process.stdout);\n');
  log.length = 0;
  assert.equal(await run('```py\nx=1\n```\n'), '```py\nx=1\n```\n');
  assert.ok(log.includes('Python and C# blocks stay as they are: oxfmt does not format this file as Markdown (it is ignored, has a pragma or another parser).'), log.join('\n'));
  fs.writeFileSync(oxfmt.oxfmtPath, formatter);
  // A block that is not valid code on its own is reported at its fence's line.
  log.length = 0;
  await run('```cs\nvar a;\nvar b;\n```\n\n```cs\nbroken\n```\n\n```py\nbroken\n```\n');
  assert.ok(log.includes('csharpier: the C# blocks at lines 6 are not valid C# on their own and stay as they are.'), log.join('\n'));
  assert.ok(log.includes('ruff: the Python blocks at lines 10 are not valid Python on their own and stay as they are.'), log.join('\n'));
  // After a crash, even the files CSharpier formatted are not trusted; a result without its final line break is not either.
  log.length = 0;
  const crash = '```cs\nvar a;\n```\n\n```cs\ncrash\n```\n';
  assert.equal(await run(crash), crash);
  assert.ok(log.includes('csharpier: Unhandled exception: disk full'), log.join('\n'));
  assert.equal(await run('```cs\nno break\n```\n'), '```cs\nno break\n```\n');
  // A tool printing CRLF, as a project's config can make it, still gives the file's own line breaks.
  fs.writeFileSync(path.join(root, 'bin', 'ruff'), fs.readFileSync(path.join(root, 'bin', 'ruff'), 'utf8').replace("text.replaceAll('=', ' = ')", "text.replaceAll('=', ' = ').replaceAll('\\n', '\\r\\n')"));
  assert.equal(await run('```py\nx=1\ny=2\n```\n'), '```py\nx = 1\ny = 2\n```\n');
  assert.equal(await run('```py\r\nx=1\r\n```\r\n'), '```py\r\nx = 1\r\n```\r\n');
  // The nearest CSharpier config applies.
  fs.writeFileSync(path.join(root, '.editorconfig'), 'root = true\n');
  fs.writeFileSync(path.join(root, 'docs', '.csharpierrc.yaml'), 'printWidth: 120\n');
  await run('```cs\nvar a;\n```\n');
  assert.deepEqual(tools.calls().at(-1).slice(4, 6), ['--config-path', path.join(root, 'docs', '.csharpierrc.yaml')]);
  // Only Markdown with a Python or C# fence, and never under dprint, whose plugins format code blocks.
  const before = tools.calls().length;
  assert.equal(await run('x=1\n', path.join(root, 'a.ts')), 'x=1\n');
  assert.equal(await run('```ts\nx=1\n```\n'), '```ts\nx=1\n```\n');
  fs.writeFileSync(path.join(root, 'dprint.json'), '{}');
  fs.mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', '.bin', 'dprint'), '#!/usr/bin/env node\nprocess.stdin.pipe(process.stdout);\n', { mode: 0o755 });
  assert.equal(await run('```py\nx=1\n```\n'), '```py\nx=1\n```\n');
  assert.equal(tools.calls().length, before);
  fs.rmSync(path.join(root, 'dprint.json'));
  // Without the tools, the blocks stay as they are.
  tools.remove('ruff');
  tools.remove('csharpier');
  log.length = 0;
  const both = '```py\nx=1\n```\n\n```cs\nvar a;\n```\n';
  assert.equal(await run(both), both);
  assert.ok(log.includes('Ruff is not installed; Python blocks stay as they are.'), log.join('\n'));
  assert.ok(log.includes('CSharpier is not installed; C# blocks stay as they are.'), log.join('\n'));
});

test('the Markdown parser is the one of the formatter that ran', async t => {
  const root = repo(t, 'project-formatter-markdown-parser-');
  codeBlockTools(t, root);
  const file = path.join(root, 'a.md');
  const log = [];
  const run = (oxc = {}) => format('```py\nx=1\n```\n', file, oxc, undefined, message => log.push(message));
  const formatted = '```py\nx = 1\n```\n';
  // An Oxfmt without a package has no parser to find the blocks with.
  const lone = path.join(root, 'oxfmt');
  fs.writeFileSync(lone, markdownFormatter, { mode: 0o755 });
  assert.equal(await run({ oxfmtPath: lone }), '```py\nx=1\n```\n');
  assert.ok(log.includes("Python and C# blocks stay as they are: no Markdown parser found in oxfmt's package."), log.join('\n'));
  // Oxfmt on the PATH through a mise shim.
  const bin = fakeOxfmt(root);
  const mise = path.join(root, 'bin', 'mise');
  fs.writeFileSync(mise, markdownFormatter.replace('if (', `if (process.argv[2] === 'which') console.log(${JSON.stringify(bin)});\nelse if (`), { mode: 0o755 });
  fs.symlinkSync(mise, path.join(root, 'bin', 'oxfmt'));
  assert.equal(await run(), formatted);
  // The project's Prettier 3, kept loaded, with its plugin.
  t.after(stopPrettier);
  fs.writeFileSync(path.join(root, '.prettierrc'), '{}');
  fakePrettier(path.join(root, 'node_modules'));
  assert.equal(await run(), formatted);
  // A global Prettier on the PATH, run through its package's command.
  stopPrettier();
  fs.rmSync(path.join(root, 'node_modules'), { recursive: true });
  fakePrettier(path.join(root, 'global', 'node_modules'));
  process.env.PATH = [path.join(root, 'global', 'node_modules', '.bin'), process.env.PATH].join(path.delimiter);
  log.length = 0;
  assert.equal(await run(), formatted);
  assert.ok(log.some(message => message.endsWith('prettier (.prettierrc)')), log.join('\n'));
  // A shim script in `node_modules/.bin`, as pnpm and aube write them, that runs the package next to it.
  fs.rmSync(path.join(root, 'global', 'node_modules', '.bin', 'prettier'));
  fs.writeFileSync(path.join(root, 'global', 'node_modules', '.bin', 'prettier'), `#!/bin/sh\nbasedir=$(dirname "$0")\nexec node "$basedir/../prettier/bin/prettier.cjs" "$@"\n`, { mode: 0o755 });
  assert.equal(await run(), formatted);
  // Prettier 2 loads plugins by itself, so its blocks stay.
  fs.renameSync(path.join(root, 'global', 'node_modules', 'prettier', 'plugins', 'markdown.js'), path.join(root, 'global', 'node_modules', 'prettier', 'parser-markdown.js'));
  log.length = 0;
  assert.equal(await run(), '```py\nx=1\n```\n');
  assert.ok(log.some(message => message.includes('Prettier 2 loads plugins by itself')), log.join('\n'));
});

const shims = path.join(process.env.MISE_DATA_DIR || path.join(os.homedir(), '.local/share/mise'), 'shims');
const shellPath = `${process.env.PATH}${path.delimiter}${shims}`;
const installed = name => spawnSync(name, ['--version'], { env: { ...process.env, PATH: shellPath } }).status === 0;
// The installed program's path, also behind a mise shim.
const which = name => {
  const found = spawnSync('sh', ['-c', `command -v ${name}`], { env: { ...process.env, PATH: shellPath }, encoding: 'utf8' }).stdout.trim();
  return found && path.basename(fs.realpathSync(found)) === 'mise' ? spawnSync('mise', ['which', name], { encoding: 'utf8' }).stdout.trim() : found;
};

// Fails when an Oxfmt update renames or reshapes the Markdown chunk in its package, as the Oxc test above does for Oxc.
test('the installed Oxfmt still has a Markdown parser to find, and its ignore patterns count', { skip: !installed('oxfmt') }, async t => {
  const oxfmtPath = which('oxfmt');
  const root = repo(t, 'project-formatter-installed-oxfmt-');
  codeBlockTools(t, root);
  const run = (input, name = 'a.md') => format(input, path.join(root, name), { oxfmtPath });
  const block = '```py\nx=1\n```\n';
  assert.equal(await run(block), '```py\nx = 1\n```\n');
  fs.writeFileSync(path.join(root, '.oxfmtrc.json'), '{ "ignorePatterns": ["b.md"] }');
  assert.equal(await run(block, 'b.md'), block);
});

// This repository's Prettier, installed into a project, so it runs kept loaded and answers `--file-info`.
function realPrettier(root) {
  const modules = path.join(root, 'node_modules');
  fs.mkdirSync(path.join(modules, '.bin'), { recursive: true });
  fs.symlinkSync(path.dirname(require.resolve('prettier/package.json')), path.join(modules, 'prettier'), 'junction');
  fs.symlinkSync(path.join('..', 'prettier', 'bin', 'prettier.cjs'), path.join(modules, '.bin', 'prettier'));
}

test('Prettier: only a file it prints as Markdown, as its config, pragmas and ignore file say', async t => {
  const root = repo(t, 'project-formatter-prettier-markdown-');
  codeBlockTools(t, root);
  t.after(stopPrettier);
  realPrettier(root);
  let version = 0;
  // A later time each time, so the kept-loaded Prettier restarts with the new config.
  const config = (name, contents) => {
    fs.writeFileSync(path.join(root, name), contents);
    fs.utimesSync(path.join(root, name), new Date(), new Date(Date.now() + ++version * 1000));
  };
  const run = input => format(input, path.join(root, 'a.md'));
  const block = '```py\nx=1\n```\n';
  config('.prettierrc', '{}');
  assert.equal(await run(block), '```py\nx = 1\n```\n');
  // Another parser for Markdown files: Babel reads this one as JavaScript, whose string holds a fence; MDX reads JSX and
  // exports as code blocks too.
  config('.prettierrc', '{ "overrides": [{ "files": "*.md", "options": { "parser": "babel" } }] }');
  assert.match(await run('const lesson=`\n~~~py\nx=1\n~~~\n`;\n'), /\nx=1\n/);
  config('.prettierrc', '{ "parser": "mdx" }');
  assert.match(await run('<Lesson text={`\n\n~~~py\nx=1\n~~~\n\n`} />\n'), /\nx=1\n/);
  // A plugin can replace the Markdown parser itself, here with MDX's.
  fs.writeFileSync(path.join(root, 'plugin.cjs'), "const markdown = require('prettier/plugins/markdown'); module.exports = { parsers: { markdown: markdown.parsers.mdx } };");
  config('.prettierrc', '{ "plugins": ["./plugin.cjs"] }');
  assert.match(await run('<Lesson text={`\n\n~~~py\nx=1\n~~~\n\n`} />\n'), /\nx=1\n/);
  // A pragma: the blocks of a file with the required one are formatted; an ignore pragma keeps them.
  config('.prettierrc', '{ "requirePragma": true }');
  assert.equal(await run(`<!-- @format -->\n\n${block}`), '<!-- @format -->\n\n```py\nx = 1\n```\n');
  assert.equal(await run(block), block);
  config('.prettierrc', '{ "checkIgnorePragma": true }');
  assert.equal(await run(`<!-- @noformat -->\n\n${block}`), `<!-- @noformat -->\n\n${block}`);
  config('.prettierrc', '{}');
  config('.prettierignore', 'a.md\n');
  assert.equal(await run(block), block);
});

test('the parser comes only from the package the formatter runs from', async t => {
  const root = repo(t, 'project-formatter-parser-trust-');
  codeBlockTools(t, root);
  const loaded = path.join(root, 'loaded');
  // A package named oxfmt whose Markdown chunk must never load.
  const trap = (dir, manifest = '{"name": "oxfmt"}') => {
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), manifest);
    fs.writeFileSync(path.join(dir, 'dist', 'markdown-Trap.js'), `require('node:fs').writeFileSync(${JSON.stringify(loaded)}, '');`);
  };
  const file = path.join(root, 'a.md');
  const run = oxc => format('```py\nx=1\n```\n', file, oxc);
  const own = fs.realpathSync(fakeOxfmt(root));
  // An Oxfmt linked from elsewhere: the package it runs from counts, not an `oxfmt` folder next to the link.
  fs.mkdirSync(path.join(root, 'links', 'bin'), { recursive: true });
  fs.symlinkSync(own, path.join(root, 'links', 'bin', 'oxfmt'));
  trap(path.join(root, 'links', 'oxfmt'));
  assert.equal(await run({ oxfmtPath: path.join(root, 'links', 'bin', 'oxfmt') }), '```py\nx = 1\n```\n');
  // A file on the PATH that spawn skips, since it is not executable, is skipped here too.
  fs.mkdirSync(path.join(root, 'shadow', 'bin'), { recursive: true });
  trap(path.join(root, 'shadow'), '{"name": "oxfmt", "bin": {"oxfmt": "bin/oxfmt"}}');
  fs.writeFileSync(path.join(root, 'shadow', 'bin', 'oxfmt'), markdownFormatter);
  fs.mkdirSync(path.join(root, 'real'));
  fs.symlinkSync(own, path.join(root, 'real', 'oxfmt'));
  const { PATH } = process.env;
  process.env.PATH = [path.join(root, 'shadow', 'bin'), path.join(root, 'real'), PATH].join(path.delimiter);
  assert.equal(await run({}), '```py\nx = 1\n```\n');
  process.env.PATH = PATH;
  // A launcher inside a package named oxfmt that declares another file as its command, like a hard link into an unrelated folder.
  fs.mkdirSync(path.join(root, 'unrelated', 'tools'), { recursive: true });
  trap(path.join(root, 'unrelated'), '{"name": "oxfmt", "bin": {"oxfmt": "tools/other"}}');
  fs.writeFileSync(path.join(root, 'unrelated', 'tools', 'other'), markdownFormatter, { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'launcher'), `#!/bin/sh\nexec ${JSON.stringify(own)} "$@"\n`, { mode: 0o755 });
  fs.linkSync(path.join(root, 'launcher'), path.join(root, 'unrelated', 'tools', 'oxfmt'));
  assert.equal(await run({ oxfmtPath: path.join(root, 'unrelated', 'tools', 'oxfmt') }), '```py\nx=1\n```\n');
  // A shim in `node_modules/.bin` that runs another Oxfmt than the package next to it.
  const shim = path.join(root, 'shimmed', 'node_modules', '.bin', 'oxfmt');
  fs.mkdirSync(path.dirname(shim), { recursive: true });
  trap(path.join(root, 'shimmed', 'node_modules', 'oxfmt'), '{"name": "oxfmt", "bin": {"oxfmt": "bin/oxfmt"}}');
  fs.mkdirSync(path.join(root, 'shimmed', 'node_modules', 'oxfmt', 'bin'));
  fs.writeFileSync(path.join(root, 'shimmed', 'node_modules', 'oxfmt', 'bin', 'oxfmt'), markdownFormatter, { mode: 0o755 });
  fs.writeFileSync(shim, `#!/bin/sh\nexec ${JSON.stringify(own)} "$@"\n`, { mode: 0o755 });
  assert.equal(await run({ oxfmtPath: shim }), '```py\nx=1\n```\n');
  // An Oxfmt in no package has no parser; nothing is looked up from the working folder, where Oxfmt and the parser run.
  const lone = path.join(root, 'lone', 'oxfmt');
  fs.mkdirSync(path.dirname(lone));
  fs.writeFileSync(lone, markdownFormatter, { mode: 0o755 });
  fs.mkdirSync(path.join(root, 'dist'));
  fs.writeFileSync(path.join(root, 'dist', 'markdown-Trap.js'), `require('node:fs').writeFileSync(${JSON.stringify(loaded)}, '');`);
  const cwd = process.cwd();
  process.chdir(root);
  t.after(() => process.chdir(cwd));
  assert.equal(await run({ oxfmtPath: lone }), '```py\nx=1\n```\n');
  assert.equal(fs.existsSync(loaded), false);
});

test('a tool that ignores SIGTERM still ends with a cancelled save', async t => {
  const root = repo(t, 'project-formatter-sigterm-');
  const pids = path.join(root, 'pids');
  const tool = path.join(root, 'tool');
  fs.writeFileSync(tool, `#!/usr/bin/env node
process.on('SIGTERM', () => {});
require('node:fs').writeFileSync(${JSON.stringify(pids)}, String(process.pid));
setTimeout(() => {}, 60000);
`, { mode: 0o755 });
  fs.writeFileSync(path.join(root, '.oxfmtrc.json'), '{}');
  const abort = new AbortController();
  const formatting = format('x\n', path.join(root, 'a.ts'), { oxfmtPath: tool }, abort.signal);
  const wait = () => new Promise(resolve => setTimeout(resolve, 10));
  while (!(fs.existsSync(pids) && fs.readFileSync(pids, 'utf8'))) await wait();
  const aborted = Date.now();
  abort.abort();
  await assert.rejects(formatting, /aborted/);
  assert.ok(Date.now() - aborted < 5000, `${Date.now() - aborted} ms`);
  const alive = pid => { try { return process.kill(pid, 0); } catch { return false; } };
  const pid = Number(fs.readFileSync(pids, 'utf8'));
  for (let tries = 0; alive(pid) && tries < 200; tries++) await wait();
  assert.equal(alive(pid), false);
});

test('a cancelled save also ends looking up the parser through mise', async t => {
  const root = repo(t, 'project-formatter-cancel-lookup-');
  codeBlockTools(t, root);
  const pids = path.join(root, 'pids');
  // `oxfmt` on the PATH is a mise shim, and `mise which` hangs.
  const mise = path.join(root, 'bin', 'mise');
  fs.writeFileSync(mise, `#!/usr/bin/env node
if (process.argv[2] === 'which') { require('node:fs').writeFileSync(${JSON.stringify(pids)}, String(process.pid)); setTimeout(() => {}, 30000); }
else { let text = ''; process.stdin.on('data', data => text += data).on('end', () => process.stdout.write(text)); }
`, { mode: 0o755 });
  fs.symlinkSync(mise, path.join(root, 'bin', 'oxfmt'));
  const abort = new AbortController();
  const formatting = format('```py\nx=1\n```\n', path.join(root, 'a.md'), {}, abort.signal);
  const wait = () => new Promise(resolve => setTimeout(resolve, 10));
  while (!(fs.existsSync(pids) && fs.readFileSync(pids, 'utf8'))) await wait();
  const aborted = Date.now();
  abort.abort();
  await assert.rejects(formatting, /aborted/);
  // At once, not after the 15 second timeout.
  assert.ok(Date.now() - aborted < 5000, `${Date.now() - aborted} ms`);
  const alive = pid => { try { return process.kill(pid, 0); } catch { return false; } };
  const lookup = Number(fs.readFileSync(pids, 'utf8'));
  for (let tries = 0; alive(lookup) && tries < 200; tries++) await wait();
  assert.equal(alive(lookup), false);
});

// Fails when an update of Oxfmt, Ruff or CSharpier changes its output or how it reports a block it cannot format.
test('Markdown with the installed Oxfmt, Ruff and CSharpier', { skip: !['oxfmt', 'ruff', 'csharpier'].every(installed) }, async t => {
  const root = repo(t, 'project-formatter-code-blocks-real-');
  const oxfmt = { oxfmtPath: which('oxfmt') };
  const log = [];
  const run = input => format(input, path.join(root, 'a.md'), oxfmt, undefined, message => log.push(message));
  // In a list and a blockquote too; a method without its class stays.
  assert.equal(await run('```python\ndef f( a ):\n  return a\n```\n\n- C#:\n\n  ```csharp\n  if(x){y();}\n  ```\n\n> ```cs\n> var q=1;\n> ```\n\n```cs\npublic int Add(int a,int b){return a+b;}\n```\n'),
    '```python\ndef f(a):\n    return a\n```\n\n- C#:\n\n  ```csharp\n  if (x)\n  {\n      y();\n  }\n  ```\n\n> ```cs\n> var q = 1;\n> ```\n\n```cs\npublic int Add(int a,int b){return a+b;}\n```\n');
  assert.ok(log.includes('csharpier: the C# blocks at lines 19 are not valid C# on their own and stay as they are.'), log.join('\n'));
  // Ruff dedents a docstring with a fence in it; Oxfmt has lengthened the block's own fence, so that line stays code.
  const docstring = '```python\n"""\n    ```\n    x=1\n"""\n```\n\nOutside prose.\n';
  assert.equal(await run(docstring), '````python\n"""\n```\nx=1\n"""\n````\n\nOutside prose.\n');
  // Under `prettier-ignore`, Oxfmt keeps the short fence, and the block stays as it is.
  assert.equal(await run(`<!-- prettier-ignore -->\n${docstring}`), `<!-- prettier-ignore -->\n${docstring}`);
});

test('a cancelled tool ends together with the programs it started', async t => {
  const root = repo(t, 'project-formatter-process-group-');
  const pids = path.join(root, 'pids');
  // A stand-in for an npm launcher that starts a slow formatter and waits for it.
  const tool = path.join(root, 'tool');
  fs.writeFileSync(tool, `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
require('node:fs').writeFileSync(${JSON.stringify(pids)}, String(child.pid));
child.on('exit', () => process.exit());
`, { mode: 0o755 });
  fs.writeFileSync(path.join(root, '.oxfmtrc.json'), '{}');
  const abort = new AbortController();
  const formatting = format('x\n', path.join(root, 'a.ts'), { oxfmtPath: tool }, abort.signal);
  const wait = () => new Promise(resolve => setTimeout(resolve, 10));
  while (!(fs.existsSync(pids) && fs.readFileSync(pids, 'utf8'))) await wait();
  abort.abort();
  await assert.rejects(formatting, /aborted/);
  const alive = pid => { try { return process.kill(pid, 0); } catch { return false; } };
  const formatter = Number(fs.readFileSync(pids, 'utf8'));
  for (let tries = 0; alive(formatter) && tries < 200; tries++) await wait();
  assert.equal(alive(formatter), false);
});

test('a tool printing more than 16 MB on either stream fails, as with execFile', async t => {
  const root = repo(t, 'project-formatter-output-limit-');
  fs.writeFileSync(path.join(root, '.oxfmtrc.json'), '{}');
  const oxfmt = { oxfmtPath: path.join(root, 'oxfmt') };
  // 18 MB in 6 million characters, so the limit counts bytes.
  for (const [stream, text] of [['stdout', '€'.repeat(6e6)], ['stderr', 'x'.repeat(17 * 1024 * 1024)]]) {
    fs.writeFileSync(oxfmt.oxfmtPath, `#!/usr/bin/env node\nprocess.${stream}.write(${JSON.stringify(text.slice(0, 1))}.repeat(${text.length}));\n`, { mode: 0o755 });
    // With stderr as the message, as before; the limit is the cause.
    await assert.rejects(format('x\n', path.join(root, 'a.ts'), oxfmt), error => (error.cause ?? error).message.endsWith(`${stream} larger than 16 MB`));
  }
});
