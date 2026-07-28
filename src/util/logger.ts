export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
  /** Emits GitHub Actions group markers when running in Actions. */
  group<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const inActions = process.env.GITHUB_ACTIONS === 'true';

/**
 * Console logger that speaks GitHub Actions' workflow-command dialect when it
 * detects one, and plain text otherwise. Warnings and errors become annotations
 * so they surface in the Actions summary rather than being buried in the log.
 */
export function createLogger(level: LogLevel = 'info'): Logger {
  const enabled = (l: LogLevel) => ORDER[l] >= ORDER[level];

  const emit = (l: LogLevel, msg: string, meta?: unknown) => {
    if (!enabled(l)) return;
    const suffix = meta === undefined ? '' : ` ${safeJson(meta)}`;
    const line = `${msg}${suffix}`;
    if (inActions && (l === 'warn' || l === 'error')) {
      // eslint-disable-next-line no-console
      console.log(`::${l === 'warn' ? 'warning' : 'error'}::${line.replace(/\n/g, '%0A')}`);
      return;
    }
    const stream = l === 'error' ? console.error : console.log;
    stream(`[drift:${l}] ${line}`);
  };

  return {
    debug: (m, meta) => emit('debug', m, meta),
    info: (m, meta) => emit('info', m, meta),
    warn: (m, meta) => emit('warn', m, meta),
    error: (m, meta) => emit('error', m, meta),
    async group(name, fn) {
      if (inActions) console.log(`::group::${name}`);
      else console.log(`[drift] ── ${name}`);
      try {
        return await fn();
      } finally {
        if (inActions) console.log('::endgroup::');
      }
    },
  };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
