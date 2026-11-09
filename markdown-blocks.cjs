// Prints the code blocks of the Markdown on stdin as JSON, found by the Markdown parser in the module argv[2]: Prettier's
// plugin, or the copy Oxfmt bundles. A process of its own, so an updated formatter's parser is the one loaded.
const { pathToFileURL } = require('node:url');

// As in Prettier: `<!-- prettier-ignore -->` keeps the next node as it is, `-start` and `-end` everything between them.
const ignoreComment = /^<!--\s*prettier-ignore(?:-(start|end))?\s*-->$/;

(async () => {
  const module = await import(pathToFileURL(process.argv[2]).href);
  const parser = module.parsers?.markdown ?? module.default?.parsers?.markdown;
  if (typeof parser?.parse !== 'function') throw new Error(`${process.argv[2]} has no Markdown parser.`);
  let text = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) text += chunk;
  const blocks = [];
  const visit = (node, ignored) => {
    if (node.type === 'code') {
      blocks.push({ lang: node.lang, value: node.value, start: node.position.start.offset, end: node.position.end.offset, ignored });
    }
    let next = false;
    let range = false;
    for (const child of node.children ?? []) {
      const marker = child.type === 'html' ? child.value.trim().match(ignoreComment) : null;
      visit(child, ignored || next || range);
      next = Boolean(marker) && !marker[1];
      if (marker?.[1]) range = marker[1] === 'start';
    }
  };
  visit(await parser.parse(text, {}), false);
  process.stdout.write(JSON.stringify(blocks));
})().catch(error => {
  process.stderr.write(error.message);
  process.exitCode = 1;
});
