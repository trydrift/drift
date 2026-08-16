import * as vscode from 'vscode';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * The colour theme the editor is actually using, read from disk.
 *
 * A webview gets VS Code's *workbench* colours for free as `--vscode-*` CSS
 * variables, but not its *token* colours: nothing in the extension API exposes
 * how the active theme paints a keyword, a string, or a type. Which is why a
 * code block in a panel ends up either unstyled or painted in colours someone
 * picked by hand — neither of which is what the developer chose.
 *
 * A theme is a file, though, and the extension that contributes it is right
 * there in `vscode.extensions.all`. This module finds that file, resolves its
 * `include` chain, and hands back the raw TextMate theme — the exact same
 * object the editor tokenises with, which is what lets the panel paint a
 * snippet the way the editor two tabs over would paint the same lines.
 */

export interface RawTextMateTheme {
  name: string;
  type: 'light' | 'dark';
  colors: Record<string, string>;
  /** TextMate rules, in `include`-first order so later rules override earlier ones. */
  settings: unknown[];
}

/**
 * Read the active theme, or `null` when it cannot be resolved.
 *
 * Every failure path here is ordinary rather than exceptional — a theme
 * shipped as a compiled colour registry contribution with no file, a theme
 * extension that has been uninstalled since the setting was written, a JSON
 * file that no longer parses. The caller falls back to VS Code's own default
 * theme, which is the right answer in every one of those cases.
 */
export async function readActiveTextMateTheme(): Promise<RawTextMateTheme | null> {
  const label = vscode.workspace.getConfiguration('workbench').get<string>('colorTheme');
  if (!label) return null;

  const located = locateTheme(label);
  if (!located) return null;

  try {
    const theme = await loadThemeFile(located.path, 0);
    if (!theme) return null;
    return {
      name: 'drift-active-theme',
      type: themeKind(theme, located.uiTheme),
      colors: (theme.colors as Record<string, string>) ?? {},
      settings: Array.isArray(theme.settings) ? theme.settings : [],
    };
  } catch {
    return null;
  }
}

/** Which contributed theme the `workbench.colorTheme` setting names. */
function locateTheme(label: string): { path: string; uiTheme?: string } | null {
  for (const extension of vscode.extensions.all) {
    const themes = extension.packageJSON?.contributes?.themes;
    if (!Array.isArray(themes)) continue;
    for (const theme of themes) {
      // `id` wins where a theme declares one, but most themes have only a
      // `label`, and that label is what the setting stores.
      if (theme?.id !== label && theme?.label !== label) continue;
      if (typeof theme.path !== 'string') continue;
      return { path: join(extension.extensionPath, theme.path), uiTheme: theme.uiTheme };
    }
  }
  return null;
}

/**
 * A theme file with its `include` chain flattened.
 *
 * Themes routinely define themselves as "the default dark theme, with these
 * twelve rules changed" — reading only the top file would drop everything the
 * base defines, which is most of the theme. Depth is bounded because an
 * `include` cycle in a third-party theme should not hang the editor.
 */
async function loadThemeFile(
  path: string,
  depth: number,
): Promise<{ colors?: unknown; settings?: unknown[]; tokenColors?: unknown[]; type?: unknown; include?: unknown } | null> {
  if (depth > 8) return null;

  const parsed = parseJsonc(await readFile(path, 'utf8'));
  if (!parsed || typeof parsed !== 'object') return null;
  const theme = parsed as Record<string, unknown>;

  // A theme may spell its rules `tokenColors` (the VS Code form) or `settings`
  // (the raw TextMate form). Both mean the same thing to the tokenizer.
  const own = Array.isArray(theme.tokenColors)
    ? theme.tokenColors
    : Array.isArray(theme.settings)
      ? theme.settings
      : [];

  if (typeof theme.include !== 'string') {
    return { colors: theme.colors, settings: own, type: theme.type };
  }

  const base = await loadThemeFile(join(dirname(path), theme.include), depth + 1).catch(() => null);
  return {
    colors: { ...((base?.colors as object) ?? {}), ...((theme.colors as object) ?? {}) },
    // Base first: in TextMate, the last matching rule wins, so the including
    // theme's own rules have to come after the ones it is overriding.
    settings: [...(base?.settings ?? []), ...own],
    type: theme.type ?? base?.type,
  };
}

function themeKind(theme: { type?: unknown }, uiTheme: string | undefined): 'light' | 'dark' {
  if (theme.type === 'light' || theme.type === 'dark') return theme.type;
  if (uiTheme === 'vs' || uiTheme === 'hc-light') return 'light';
  if (uiTheme) return 'dark';
  return vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light ||
    vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrastLight
    ? 'light'
    : 'dark';
}

/**
 * JSON with comments and trailing commas — what VS Code themes are actually
 * written in, and what `JSON.parse` refuses.
 *
 * String-aware on purpose: a colour theme is mostly string values, and a naive
 * comment strip would cut a `//` out of the middle of one.
 */
export function parseJsonc(text: string): unknown {
  let out = '';
  let i = 0;
  let inString = false;

  while (i < text.length) {
    const ch = text[i]!;

    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += text[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }

    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }

    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }

    out += ch;
    i += 1;
  }

  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}
