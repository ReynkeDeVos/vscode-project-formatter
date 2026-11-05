# Project Formatter

Automatically chooses your project's **Prettier, Oxfmt, Bun fmt, Biome or dprint**. Falls back to Oxfmt. Leaves linting alone.

1. Download the `.vsix` from [Releases](https://github.com/ReynkeDeVos/vscode-project-formatter/releases/latest) and install it with **Extensions: Install from VSIX…**.
2. Make it your default formatter with `"editor.defaultFormatter": "kawa.project-formatter"`. It handles the same documents as the Oxc extension: JS/TS, CSS/SCSS/Less, HTML, JSON, YAML, TOML, Markdown/MDX, GraphQL, Handlebars, MJML, Vue and Svelte. Give every other language with a formatter its own block, such as `"[python]": { "editor.defaultFormatter": "charliermarsh.ruff" }`.
3. Enable **Editor: Format On Save**.

Searches from the file up to the repository root; the nearest folder that declares a formatter wins. Within a folder: a `format`/`fmt` script, `bunfig.toml` `[fmt]`, Oxfmt config, Biome config, dprint config, Prettier config, then dependencies. Uses `oxc.path.oxfmt` if set, then local binaries, then global tools; `oxc.path.node` selects Node.js for all of them. A local Prettier 3 stays loaded in one background process per project, so saves skip its startup; it restarts when a config or ignore file changes and exits after 15 minutes unused. Local Biome and dprint run their native program directly instead of through the npm launcher. Each formatter reads the project's own config, as on the command line. File types the project's Prettier has no parser for, like TOML, go to Oxfmt. Install the formatters yourself.

Linux/macOS. Documents without a file of their own (settings.json, untitled, notebook cells) use the formatter of their location or the workspace root. Custom script wrappers/flags aren't interpreted. Bun needs native `bun fmt` and no overriding `fmt` script.

Test: `npm ci && npm test`. Package: `npx @vscode/vsce package`.
