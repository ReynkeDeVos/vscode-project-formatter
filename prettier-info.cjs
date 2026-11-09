// Prints, as JSON, how the Prettier package at argv[2] treats the file argv[3]: the parser it picks, from overrides too, and the
// plugins its config adds, which can replace any parser. Resolved as Prettier resolves them when it formats the file.
(async () => {
  const prettier = require(process.argv[2]);
  const file = process.argv[3];
  const { inferredParser } = await prettier.getFileInfo(file, { resolveConfig: true });
  const options = await prettier.resolveConfig(file, { editorconfig: true });
  process.stdout.write(JSON.stringify({ parser: inferredParser, plugins: options?.plugins ?? [] }));
})().catch(error => {
  process.stderr.write(error.message);
  process.exitCode = 1;
});
