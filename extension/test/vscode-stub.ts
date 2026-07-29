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

export const Uri = {
  file: (path: string) => ({ fsPath: path, path, scheme: 'file', toString: () => `file://${path}` }),
  parse: (value: string) => ({ toString: () => value, fsPath: value, path: value }),
};

/** Settings the tests need; overridable per test. */
export const __settings = new Map<string, unknown>();

export const workspace = {
  workspaceFolders: [] as { uri: { fsPath: string } }[],
  getConfiguration: (_section?: string) => ({
    get: <T>(key: string, fallback?: T): T =>
      (__settings.has(key) ? (__settings.get(key) as T) : (fallback as T)),
    update: async () => undefined,
  }),
  fs: {
    readFile: async () => {
      throw new Error('not found');
    },
  },
  applyEdit: async () => true,
  saveAll: async () => true,
  openTextDocument: async () => {
    throw new Error('not implemented');
  },
};

export const window = {
  activeTextEditor: undefined as unknown,
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
  createWebviewPanel: () => {
    throw new Error('not implemented in the stub');
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
};

export const authentication = {
  getSession: async () => undefined,
  onDidChangeSessions: () => ({ dispose: () => undefined }),
};

export const lm = {
  selectChatModels: async () => [],
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
export const ProgressLocation = { Notification: 15, Window: 10 } as const;
export const ConfigurationTarget = { Global: 1, Workspace: 2 } as const;
export const env = { openExternal: async () => true };
export const version = '1.95.0-stub';
