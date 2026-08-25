/** Host-side code rendering deliberately does no tokenisation. */
export function highlightCode(code: string, lang: string = 'typescript'): string {
  return `<span class="drift-highlight" data-drift-highlight data-language="${escapeHtml(normaliseLanguage(lang))}">${escapeHtml(code)}</span>`;
}

/** Fixed VS Code-like light/dark token colours. Theme changes are CSS-only. */
export const HIGHLIGHT_STYLES = `
.drift-highlight { color: var(--vscode-editor-foreground); }
.vscode-light .hljs-keyword, .vscode-light .hljs-selector-tag, .vscode-light .hljs-literal { color: #0000ff; }
.vscode-light .hljs-string, .vscode-light .hljs-attr { color: #a31515; }
.vscode-light .hljs-comment, .vscode-light .hljs-quote { color: #008000; }
.vscode-light .hljs-number, .vscode-light .hljs-built_in, .vscode-light .hljs-type { color: #098658; }
.vscode-light .hljs-title, .vscode-light .hljs-function { color: #795e26; }
.vscode-dark .hljs-keyword, .vscode-dark .hljs-selector-tag, .vscode-dark .hljs-literal { color: #569cd6; }
.vscode-dark .hljs-string, .vscode-dark .hljs-attr { color: #ce9178; }
.vscode-dark .hljs-comment, .vscode-dark .hljs-quote { color: #6a9955; }
.vscode-dark .hljs-number, .vscode-dark .hljs-built_in, .vscode-dark .hljs-type { color: #b5cea8; }
.vscode-dark .hljs-title, .vscode-dark .hljs-function { color: #dcdcaa; }
.hljs-emphasis { font-style: italic; }
.hljs-strong { font-weight: 700; }
`;

export function languageForEcosystem(ecosystem: string | undefined): string {
  switch (ecosystem) {
    case 'pypi': return 'python';
    case 'go': return 'go';
    case 'cargo': return 'rust';
    case 'maven':
    case 'gradle': return 'java';
    case 'nuget': return 'csharp';
    case 'rubygems': return 'ruby';
    case 'packagist': return 'php';
    case 'pub': return 'dart';
    case 'hex': return 'elixir';
    case 'swiftpm':
    case 'cocoapods': return 'swift';
    case 'conan':
    case 'vcpkg': return 'cpp';
    default: return 'typescript';
  }
}

export function extensionForLanguage(lang: string): string {
  switch (lang) {
    case 'python': return 'py';
    case 'rust': return 'rs';
    case 'csharp': return 'cs';
    case 'ruby': return 'rb';
    case 'elixir': return 'ex';
    case 'typescript': return 'ts';
    default: return lang;
  }
}

function normaliseLanguage(lang: string): string {
  return /^[a-z0-9_+-]{1,24}$/i.test(lang) ? lang.toLowerCase() : 'plaintext';
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
