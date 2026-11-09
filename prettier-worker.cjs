// Formats with the project's Prettier 3 (argv[2]) like `prettier --stdin-filepath`, but stays loaded between saves.
// Runs in the project folder, so plugins and ignore files resolve from there as they do for the CLI.
// With the result, it reports the parser and plugins it formatted with, from the same config it used.
process.on('message', async ({ id, text, file }) => {
  try {
    const prettier = require(process.argv[2]);
    // Config files are read afresh on every save, as by the CLI, nested .editorconfig files too; only JavaScript configs stay
    // cached by Node, so a change to one restarts this process.
    await prettier.clearConfigCache?.();
    const { ignored, inferredParser } = await prettier.getFileInfo(file, { ignorePath: ['.gitignore', '.prettierignore'] });
    if (ignored) return process.send({ id, formatted: text });
    const options = await prettier.resolveConfig(file, { editorconfig: true });
    const formatted = await prettier.format(text, { ...options, filepath: file });
    process.send({ id, formatted, parser: options?.parser ?? inferredParser, plugins: options?.plugins ?? [] });
  } catch (error) {
    process.send({ id, error: error.message });
  }
});
