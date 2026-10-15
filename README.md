# Project Formatter

Automatically chooses your project's **Prettier, Oxfmt, Bun fmt or Biome**. Falls back to Oxfmt. Leaves linting alone.

1. Download the `.vsix` from [Releases](https://github.com/ReynkeDeVos/vscode-project-formatter/releases/latest) and install it with **Extensions: Install from VSIX…**.
2. Choose **Format Document With… → Configure Default Formatter → Project Formatter** for each language you want: JS/TS, CSS/SCSS/Less, HTML, JSON, YAML, TOML, Markdown/MDX, GraphQL, Handlebars, MJML, Vue or Svelte.
3. Enable **Editor: Format On Save**.

Searches from the file up to the repository root; the nearest folder that declares a formatter wins. Within a folder: a `format`/`fmt` script, `bunfig.toml` `[fmt]`, Oxfmt config, Biome config, Prettier config, then dependencies. Uses `oxc.path.oxfmt` if set, then local binaries, then global tools; `oxc.path.node` selects Node.js for all of them. Install the formatters yourself.

Linux/macOS; saved files only. Custom script wrappers/flags aren't interpreted. Bun needs native `bun fmt` and no overriding `fmt` script.

Test: `npm ci && npm test`. Package: `npx @vscode/vsce package`.
