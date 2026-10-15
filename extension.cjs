const vscode = require('vscode');
const { format, oxcPath } = require('./formatter.cjs');

exports.activate = context => {
  const output = vscode.window.createOutputChannel('Project Formatter');
  const languages = [
    'javascript', 'javascriptreact', 'typescript', 'typescriptreact', 'html', 'css', 'scss', 'less',
    'json', 'jsonc', 'json5', 'yaml', 'toml', 'markdown', 'mdx', 'graphql', 'handlebars', 'mjml', 'vue', 'svelte',
  ];
  context.subscriptions.push(output, vscode.languages.registerDocumentFormattingEditProvider(
    languages.map(language => ({ language, scheme: 'file' })),
    {
      async provideDocumentFormattingEdits(document, options, token) {
        if (!vscode.workspace.isTrusted || token.isCancellationRequested) return [];
        const abort = new AbortController();
        const cancellation = token.onCancellationRequested(() => abort.abort());
        try {
          const input = document.getText();
          const oxc = vscode.workspace.getConfiguration('oxc', document.uri);
          const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          const formatted = await format(input, document.fileName,
            oxcPath(oxc.get('path.oxfmt'), root), oxcPath(oxc.get('path.node'), root), abort.signal,
            message => output.appendLine(message));
          if (token.isCancellationRequested || formatted === input) return [];
          return [vscode.TextEdit.replace(new vscode.Range(document.positionAt(0), document.positionAt(input.length)), formatted)];
        } catch (error) {
          if (!token.isCancellationRequested) {
            output.appendLine(error.message);
            vscode.window.showErrorMessage(`Project Formatter: ${error.message}`);
          }
          return [];
        } finally {
          cancellation.dispose();
        }
      },
    },
  ));
};
