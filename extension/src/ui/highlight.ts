/**
 * Safe code markup produced by the Extension Host. Syntax decoration happens
 * later, in the webview, so rendering a transcript never tokenises source.
 */
export function renderHighlightedCode(
  code: string,
  language: string | undefined = 'typescript',
  className?: string,
): string {
  const classes = ['hljs'];
  if (className) classes.push(className);
  return `<code class="${escapeAttr(classes.join(' '))}" data-drift-highlight data-lang="${escapeAttr(language ?? 'typescript')}">${escapeHtml(code)}</code>`;
}

/** The shared, VS Code-native palette for highlight.js semantic classes. */
export const HIGHLIGHT_STYLES = `
code.hljs { color: var(--vscode-editor-foreground); background: transparent; }
.hljs-comment, .hljs-quote { color: var(--vscode-descriptionForeground, var(--vscode-editor-foreground)); font-style: italic; }
.hljs-keyword, .hljs-selector-tag, .hljs-doctag, .hljs-meta .hljs-keyword { color: var(--vscode-symbolIcon-keywordForeground, var(--vscode-editor-foreground)); }
.hljs-string, .hljs-regexp, .hljs-meta .hljs-string, .hljs-symbol, .hljs-bullet { color: var(--vscode-symbolIcon-stringForeground, var(--vscode-editor-foreground)); }
.hljs-number, .hljs-literal { color: var(--vscode-symbolIcon-numberForeground, var(--vscode-editor-foreground)); }
.hljs-title.function_, .hljs-built_in, .hljs-builtin-name { color: var(--vscode-symbolIcon-functionForeground, var(--vscode-editor-foreground)); }
.hljs-title.class_, .hljs-title.class_.inherited__, .hljs-type, .hljs-section { color: var(--vscode-symbolIcon-classForeground, var(--vscode-editor-foreground)); }
.hljs-variable, .hljs-template-variable, .hljs-params { color: var(--vscode-symbolIcon-variableForeground, var(--vscode-editor-foreground)); }
.hljs-attr, .hljs-attribute, .hljs-property { color: var(--vscode-symbolIcon-propertyForeground, var(--vscode-editor-foreground)); }
.hljs-name, .hljs-tag { color: var(--vscode-symbolIcon-keyForeground, var(--vscode-editor-foreground)); }
.hljs-addition { color: var(--vscode-gitDecoration-addedResourceForeground, var(--vscode-editor-foreground)); }
.hljs-deletion { color: var(--vscode-gitDecoration-deletedResourceForeground, var(--vscode-editor-foreground)); }
.hljs-emphasis { font-style: italic; }
.hljs-strong { font-weight: 700; }
.hljs-subst, .hljs-punctuation { color: var(--vscode-editor-foreground); }
`;

export function languageForEcosystem(ecosystem: string | undefined): string {
  switch (ecosystem) {
    case 'pypi': return 'python';
    case 'go': return 'go';
    case 'cargo': return 'rust';
    case 'maven': case 'gradle': return 'java';
    case 'nuget': return 'csharp';
    case 'rubygems': return 'ruby';
    case 'packagist': return 'php';
    case 'pub': return 'dart';
    case 'hex': return 'elixir';
    case 'swiftpm': case 'cocoapods': return 'swift';
    case 'conan': case 'vcpkg': return 'cpp';
    default: return 'typescript';
  }
}

export function extensionForLanguage(lang: string): string {
  switch (lang) {
    case 'python': return 'py'; case 'go': return 'go'; case 'rust': return 'rs';
    case 'java': return 'java'; case 'csharp': return 'cs'; case 'ruby': return 'rb';
    case 'php': return 'php'; case 'dart': return 'dart'; case 'elixir': return 'ex';
    case 'swift': return 'swift'; case 'cpp': return 'cpp'; case 'json': return 'json';
    case 'yaml': return 'yaml'; default: return 'ts';
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/'/g, '&#39;');
}
