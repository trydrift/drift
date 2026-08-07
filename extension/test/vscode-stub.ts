import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';

/**
 * Minimal `vscode` stand-in for headless testing.
 *
 * The extension's rendering and state logic is ordinary TypeScript that merely
 * imports `vscode`. Stubbing the handful of constructors it touches lets that
 * logic run under plain Node, which means the report HTML, the tree items, and
 * the state machine can be tested without launching an editor.
 *
 * Only what the code under test actually uses is implemented — anything else
 * would be speculative surface with no test behind it.
 */

export class EventEmitter<T> {
  private listeners: ((value: T) => void)[] = [];
  readonly event = (listener: (value: T) => void) => {
    this.listeners.push(listener);
    return { dispose: () => (this.listeners = this.listeners.filter((l) => l !== listener)) };
  };
  fire(value: T): void {
    for (const l of this.listeners) l(value);
  }
  dispose(): void {
    this.listeners = [];
  }
}

export class ThemeIcon {
  constructor(
    readonly id: string,
    readonly color?: ThemeColor,
  ) {}
}

export class ThemeColor {
  constructor(readonly id: string) {}
}

export class MarkdownString {
  isTrusted = false;
  constructor(public value = '') {}
}

export class TreeItem {
  description?: string;
  tooltip?: unknown;
  iconPath?: unknown;
  command?: unknown;
  contextValue?: string;
  constructor(
    readonly label: string,
    readonly collapsibleState?: number,
  ) {}
}

export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 } as const;

export class Range {
  constructor(
    readonly startLine: number,
    readonly startChar: number,
    readonly endLine: number,
    readonly endChar: number,
  ) {}
  get start() {
    return { line: this.startLine, character: this.startChar };
  }
  get end() {
    return { line: this.endLine, character: this.endChar };
  }
}

export class Position {
  constructor(
    readonly line: number,
    readonly character: number,
  ) {}
}

export class Selection extends Range {
  constructor(anchor: { line: number; character: number }, active: { line: number; character: number }) {
    super(anchor.line, anchor.character, active.line, active.character);
  }
}

export class Diagnostic {
  source?: string;
  code?: unknown;
  relatedInformation?: unknown[];
  constructor(
    readonly range: Range,
    readonly message: string,
    readonly severity?: number,
  ) {}
}

export const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 } as const;

export class DiagnosticRelatedInformation {
  constructor(
    readonly location: unknown,
    readonly message: string,
  ) {}
}

export class Location {
  constructor(
    readonly uri: unknown,
    readonly range: Range,
  ) {}
}

export class CodeAction {
  command?: unknown;
  diagnostics?: unknown[];
  isPreferred?: boolean;
  constructor(
    readonly title: string,
    readonly kind?: unknown,
  ) {}
}

export const CodeActionKind = { QuickFix: 'quickfix' } as const;

export class CodeLens {
  constructor(
    readonly range: Range,
    readonly command?: unknown,
  ) {}
}

export class Hover {
  constructor(readonly contents: unknown) {}
}

export class WorkspaceEdit {
  readonly edits: { uri: { fsPath: string }; text: string }[] = [];
  replace(uri: { fsPath: string }, _range: Range, text: string): void {
    this.edits.push({ uri, text });
  }
}

export const Uri = {
  file: (path: string) => ({ fsPath: path, path, scheme: 'file', toString: () => `file://${path}` }),
  parse: (value: string) => ({ toString: () => value, fsPath: value, path: value }),
};

/** Settings the tests need; overridable per test. */
export const __settings = new Map<string, unknown>();

export const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 } as const;

export const workspace = {
  workspaceFolders: [] as { uri: { fsPath: string } }[],
  getConfiguration: (_section?: string) => ({
    get: <T>(key: string, fallback?: T): T =>
      (__settings.has(key) ? (__settings.get(key) as T) : (fallback as T)),
    update: async () => undefined,
  }),
  // Backed by the real filesystem: the code under test reads manifests and
  // lockfiles, and a fake tree would only test the fake. Tests point it at a
  // temporary directory they built themselves.
  fs: {
    readFile: async (uri: { fsPath: string }) => readFileSync(uri.fsPath),
    readDirectory: async (uri: { fsPath: string }) =>
      readdirSync(uri.fsPath, { withFileTypes: true }).map(
        (entry) => [entry.name, entry.isDirectory() ? FileType.Directory : FileType.File] as [string, number],
      ),
    stat: async (uri: { fsPath: string }) => ({
      type: statSync(uri.fsPath).isDirectory() ? FileType.Directory : FileType.File,
    }),
  },
  textDocuments: [] as { uri: { fsPath: string }; getText(): string }[],
  onDidChangeTextDocument: () => ({ dispose: () => undefined }),
  applyEdit: async (edit: WorkspaceEdit) => {
    for (const entry of edit.edits) writeFileSync(entry.uri.fsPath, entry.text);
    return true;
  },
  saveAll: async () => true,
  openTextDocument: async (uri: { fsPath: string }) => {
    const text = readFileSync(uri.fsPath, 'utf8');
    return {
      uri,
      getText: () => text,
      positionAt: (offset: number) => {
        const before = text.slice(0, offset).split('\n');
        return new Position(before.length - 1, before.at(-1)?.length ?? 0);
      },
      save: async () => true,
      lineCount: text.split('\n').length,
      lineAt: (line: number) => ({ text: text.split('\n')[line] ?? '' }),
    };
  },
};

export const window = {
  activeTextEditor: undefined as unknown,
  /** Test-only: set by `createWebviewPanel` so tests can read what it produced. */
  __lastWebviewPanel: undefined as { webview: { html: string } } | undefined,
  showInformationMessage: async () => undefined,
  showWarningMessage: async () => undefined,
  showErrorMessage: async () => undefined,
  createOutputChannel: () => ({
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    show: () => undefined,
    dispose: () => undefined,
  }),
  createStatusBarItem: () => ({
    text: '',
    tooltip: undefined as unknown,
    command: undefined as unknown,
    name: '',
    backgroundColor: undefined as unknown,
    show: () => undefined,
    hide: () => undefined,
    dispose: () => undefined,
  }),
  createTreeView: () => ({ dispose: () => undefined }),
  showTextDocument: async (document: unknown) => ({
    document,
    selection: undefined as unknown,
    revealRange: () => undefined,
  }),
  createWebviewPanel: (_viewType: string, _title: string, _showOptions: unknown, _options: unknown) => {
    let disposeListener: (() => void) | undefined;
    const messageListeners: ((message: unknown) => void)[] = [];
    const panel = {
      webview: {
        cspSource: 'vscode-webview://test',
        html: '',
        onDidReceiveMessage: (listener: (message: unknown) => void) => {
          messageListeners.push(listener);
          return { dispose: () => (messageListeners.length = 0) };
        },
        postMessage: async () => true,
        /** Test-only: simulate a message the webview's own script sent back. */
        __receive: (message: unknown) => {
          for (const l of messageListeners) l(message);
        },
      },
      reveal: () => undefined,
      onDidDispose: (listener: () => void) => {
        disposeListener = listener;
        return { dispose: () => (disposeListener = undefined) };
      },
      dispose: () => disposeListener?.(),
    };
    // Test-only: the extension keeps no external handle on the panel it creates,
    // so tests that need to inspect rendered output read it from here.
    window.__lastWebviewPanel = panel;
    return panel;
  },
  withProgress: async <T>(_options: unknown, task: (p: unknown, t: unknown) => Promise<T>) =>
    task({ report: () => undefined }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) }),
  showQuickPick: async () => undefined,
};

export const commands = {
  executeCommand: async () => undefined,
  registerCommand: () => ({ dispose: () => undefined }),
};

export const languages = {
  createDiagnosticCollection: () => {
    const store = new Map<string, unknown>();
    return {
      set: (uri: { toString(): string }, value: unknown) => store.set(uri.toString(), value),
      clear: () => store.clear(),
      dispose: () => store.clear(),
      /** Test-only accessor. */
      __store: store,
    };
  },
  registerCodeActionsProvider: () => ({ dispose: () => undefined }),
  registerCodeLensProvider: () => ({ dispose: () => undefined }),
  registerHoverProvider: () => ({ dispose: () => undefined }),
};

export const authentication = {
  getSession: async () => undefined,
  onDidChangeSessions: () => ({ dispose: () => undefined }),
};

export const lm = {
  selectChatModels: async () => [],
};

export const extensions = {
  all: [] as {
    id: string;
    extensionPath: string;
    packageJSON?: Record<string, unknown>;
  }[],
  getExtension: (id: string) => extensions.all.find((entry) => entry.id === id),
};

export class LanguageModelError extends Error {}

export const LanguageModelChatMessage = {
  User: (content: string) => ({ role: 'user', content }),
  Assistant: (content: string) => ({ role: 'assistant', content }),
};

export class CancellationTokenSource {
  token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) };
  cancel(): void {
    this.token.isCancellationRequested = true;
  }
  dispose(): void {}
}

export const ViewColumn = { One: 1, Two: 2 } as const;
export const TextEditorRevealType = { InCenterIfOutsideViewport: 2 } as const;
export const ProgressLocation = { Notification: 15, Window: 10 } as const;
export const ConfigurationTarget = { Global: 1, Workspace: 2 } as const;
export const env = { openExternal: async () => true };
export const version = '1.95.0-stub';
