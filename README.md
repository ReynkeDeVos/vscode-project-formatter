# Project Formatter

Automatically chooses your project's **Prettier, Oxfmt, Bun fmt or Biome**. Falls back to Oxfmt. Leaves linting alone.

1. Download the `.vsix` from [Releases](https://github.com/ReynkeDeVos/vscode-project-formatter/releases/latest) and install it with **Extensions: Install from VSIX…**.
2. Choose **Format Document With… → Configure Default Formatter → Project Formatter** for each language you want.
3. Enable **Editor: Format On Save**.

Detects nearby configs, `format`/`fmt` scripts and dependencies. Uses local binaries first, then global tools. Install the formatters yourself.

Linux/macOS; saved files only. Custom script wrappers/flags aren't interpreted. Bun needs native `bun fmt` and no overriding `fmt` script.

Test: `npm test`. Package: `npx @vscode/vsce package --no-dependencies`.
