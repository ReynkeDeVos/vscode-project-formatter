# Project Formatter

One default formatter for VS Code that formats every file the way its project does.

- **Your project's formatter.** Prettier, Oxfmt, Biome, dprint or Bun fmt, whichever the project uses. Otherwise Oxfmt.
- **Code in Markdown too.** Python blocks with Ruff, C# blocks with CSharpier. Only real code blocks, as your Markdown formatter sees them.
- **Fast saves.** A project's Prettier stays loaded; Biome and dprint run natively.
- **Follows Oxc.** Formats the files the [Oxc extension](https://marketplace.visualstudio.com/items?itemName=oxc.oxc-vscode) formats, with its Oxfmt settings.

## Setup

1. Install the Oxc extension, then the `.vsix` from [Releases](https://github.com/ReynkeDeVos/vscode-project-formatter/releases/latest) with **Extensions: Install from VSIX…**.
2. Add to your settings:

   ```jsonc
   "editor.defaultFormatter": "kawa.project-formatter",
   "editor.formatOnSave": true,
   // Languages Oxc does not format keep their own formatter:
   "[python]": { "editor.defaultFormatter": "charliermarsh.ruff" }
   ```

3. Install the formatters you use, in the project or globally (mise works). For code in Markdown: Ruff and CSharpier.

If something stays unformatted, the **Project Formatter** output says why.

<details>
<summary>How it decides</summary>

- The nearest folder from the file up to the repository root that declares a formatter wins: a `format`/`fmt` script, `bunfig.toml` `[fmt]`, an Oxfmt, Biome, dprint or Prettier config, then a dependency. File types the project's Prettier cannot parse, like TOML, go to Oxfmt.
- Oxfmt runs as under the Oxc extension, with `oxc.path.oxfmt`, `oxc.fmt.configPath` and `oxc.fmt.disableNestedConfig`; `oxc.path.node` picks Node.js for every formatter.
- Markdown code blocks are found with the Markdown parser of the formatter that ran, so both stay in agreement after updates. They stay as they are in an ignored file, under `<!-- prettier-ignore -->`, with Prettier plugins or a non-Markdown parser, with a global Prettier or Prettier 2, when the code is not valid on its own (a C# method without its class), or when formatting it would change the Markdown around it. Under dprint, its own plugins format code blocks.
- A cancelled save or the 15 second timeout ends the formatter processes the save started.
- Linux and macOS. Bun needs a native `bun fmt` and no `fmt` script of its own.

</details>

Develop with `npm ci && npm test`; package with `npx @vscode/vsce package`.
