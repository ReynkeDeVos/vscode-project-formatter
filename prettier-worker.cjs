// Formats with the project's Prettier 3 (argv[2]) like `prettier --stdin-filepath`, but stays loaded between saves.
// Runs in the project folder, so plugins and ignore files resolve from there as they do for the CLI.
process.on('message', async ({ id, text, file }) => {
  try {
    const prettier = require(process.argv[2]);
    const { ignored } = await prettier.getFileInfo(file, { ignorePath: ['.gitignore', '.prettierignore'] });
    if (ignored) return process.send({ id, formatted: text });
    const options = await prettier.resolveConfig(file, { editorconfig: true });
    process.send({ id, formatted: await prettier.format(text, { ...options, filepath: file }) });
  } catch (error) {
    process.send({ id, error: error.message });
  }
});
