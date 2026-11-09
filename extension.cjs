const vscode = require('vscode');
const { documentPath, format, oxcPath, oxcRules, stopPrettier } = require('./formatter.cjs');

exports.activate = context => {
  const output = vscode.window.createOutputChannel('Project Formatter');
  context.subscriptions.push(output, { dispose: stopPrettier });
  const oxc = vscode.extensions.getExtension('oxc.oxc-vscode');
  if (!oxc) {
    vscode.window.showErrorMessage('Project Formatter needs the Oxc extension (oxc.oxc-vscode).');
    return;
  }
  const rules = oxcRules(oxc);
  if (!rules.extensions.length) output.appendLine("Could not read the Oxc extension's file patterns; following only its languages.");
  context.subscriptions.push(vscode.languages.registerDocumentFormattingEditProvider(
    rules.selector,
    {
      async provideDocumentFormattingEdits(document, options, token) {
        if (!vscode.workspace.isTrusted || token.isCancellationRequested) return [];
        const abort = new AbortController();
        const cancellation = token.onCancellationRequested(() => abort.abort());
        try {
          const input = document.getText();
          const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          const languages = vscode.extensions.all.flatMap(extension => extension.packageJSON.contributes?.languages ?? []);
          const file = documentPath(document, root, languages, rules.extensions);
          // By the path, because notebook cells and untitled documents have addresses no workspace folder matches.
          const fileUri = vscode.Uri.file(file);
          const folder = vscode.workspace.getWorkspaceFolder(fileUri)?.uri.fsPath;
          const settings = vscode.workspace.getConfiguration('oxc', fileUri);
          const formatted = await format(input, file, {
            oxfmtPath: oxcPath(settings.get('path.oxfmt'), root),
            nodePath: oxcPath(settings.get('path.node'), root),
            // shortcut: Oxc resolves a relative path set in a .code-workspace file against that file; handle it if one is ever used.
            configPath: oxcPath(settings.get('fmt.configPath'), folder ?? root),
            disableNestedConfig: settings.get('fmt.disableNestedConfig'),
            folder,
          }, abort.signal, message => output.appendLine(message));
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
