import * as vscode from 'vscode';

/**
 * GitHub authentication, via VS Code's built-in provider.
 *
 * There is no token to create, paste, store, or remember. VS Code owns the
 * OAuth flow, the token, and its refresh; Drift asks for a session and gets one
 * back. The user clicks "Allow" once, and can revoke it from the Accounts menu
 * or from GitHub's settings at any time.
 *
 * Drift never writes the token to disk, never puts it in settings, and never
 * sends it anywhere except api.github.com.
 *
 * **Nothing in the analysis path needs this.** Detection, evidence gathering,
 * localization, and local fixes all work signed out. Auth is requested only for
 * the two things that genuinely need an identity: dispatching GitHub's cloud
 * agent, and pushing a branch.
 */

/**
 * `repo` covers reading and pushing branches; `workflow` is required to push a
 * branch that touches `.github/workflows`, which a runtime-version fix often
 * does. Asking for it up front avoids a confusing mid-push failure.
 */
export const GITHUB_SCOPES = ['repo', 'workflow'] as const;

export interface SessionOptions {
  /** `true` prompts the user to sign in; `false` checks silently. */
  createIfNone: boolean;
}

export async function getGitHubSession(
  options: SessionOptions,
): Promise<vscode.AuthenticationSession | null> {
  try {
    const session = await vscode.authentication.getSession('github', [...GITHUB_SCOPES], {
      createIfNone: options.createIfNone,
    });
    return session ?? null;
  } catch {
    // Thrown when the user dismisses the sign-in dialog. That is a decision,
    // not an error, so callers get `null` and carry on.
    return null;
  }
}

/** True when a session already exists. Never prompts. */
export async function isSignedIn(): Promise<boolean> {
  return (await getGitHubSession({ createIfNone: false })) !== null;
}

/**
 * A token for raising public API rate limits during evidence gathering.
 *
 * Returns `undefined` when signed out — evidence gathering works fine
 * unauthenticated, just with a lower rate limit, so this must never prompt.
 */
export async function getRateLimitToken(): Promise<string | undefined> {
  const session = await getGitHubSession({ createIfNone: false });
  return session?.accessToken;
}

/** Fires when the user signs in or out, so the UI can re-evaluate. */
export function onDidChangeGitHubAuth(listener: () => void): vscode.Disposable {
  return vscode.authentication.onDidChangeSessions((event) => {
    if (event.provider.id === 'github') listener();
  });
}
