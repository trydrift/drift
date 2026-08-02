/**
 * Who gets credit for a commit Drift made.
 *
 * Drift edits code. Git's answer to "a change with more than one author" is the
 * `Co-authored-by` trailer, which GitHub renders on the commit and which
 * `git log` and `git shortlog` already understand — so a repository can see at
 * a glance which commits a tool participated in, without Drift inventing its
 * own convention or hiding behind the developer's name.
 *
 * The trailer is added, never substituted. The human stays the author: they
 * chose the upgrade, reviewed the diff, and pressed the button. Rewriting
 * authorship to a tool would misattribute a decision a person made.
 */

export interface Author {
  name: string;
  email: string;
}

/**
 * Drift's identity in a commit trailer.
 *
 * The `users.noreply.github.com` domain is the convention GitHub reserves for
 * addresses that must not receive mail, which is exactly right for a tool: the
 * trailer is an attribution, not a contact.
 */
export const DRIFT_COAUTHOR: Author = {
  name: 'Drift',
  email: 'drift@users.noreply.github.com',
};

/** `Co-authored-by: Name <email>` for one author. */
export function coAuthorTrailer(author: Author): string {
  return `Co-authored-by: ${author.name} <${author.email}>`;
}

/**
 * Append trailers to a commit message.
 *
 * Three things this gets right that string concatenation does not:
 *
 *   - Trailers must be the last paragraph, separated from the body by a blank
 *     line, or git does not recognise them as trailers at all.
 *   - A trailer already present is not added twice. Re-running an upgrade on a
 *     branch that already has one must not accumulate them.
 *   - A message that is only a subject line still gets the blank line, rather
 *     than a trailer glued to the subject where it would become part of it.
 *
 * Comparison is case-insensitive on the token and exact on the value, matching
 * how git itself treats trailer keys.
 */
export function withTrailers(message: string, trailers: readonly string[]): string {
  const trimmed = message.replace(/\s+$/, '');
  if (trailers.length === 0) return trimmed;

  const existing = new Set(
    trimmed
      .split('\n')
      .map((line) => line.trim().toLowerCase())
      .filter(Boolean),
  );

  const additions = trailers
    .map((trailer) => trailer.trim())
    .filter((trailer) => trailer && !existing.has(trailer.toLowerCase()));

  if (additions.length === 0) return trimmed;
  if (!trimmed) return additions.join('\n');

  // If the message already ends in a trailer block, join it rather than opening
  // a second one — two trailer paragraphs mean git only reads the last.
  const lines = trimmed.split('\n');
  const lastLine = lines[lines.length - 1] ?? '';
  const endsWithTrailer = /^[A-Za-z-]+:\s.+$/.test(lastLine.trim());

  return `${trimmed}${endsWithTrailer ? '\n' : '\n\n'}${additions.join('\n')}`;
}

/**
 * A commit message with Drift credited as a co-author.
 *
 * The single entry point every surface uses — the CLI, the GitHub Action, and
 * the extension — so that attribution cannot be present in one and missing in
 * another. `extra` carries anything a caller wants alongside it, such as the
 * coding agent that actually produced an edit.
 */
export function attributedMessage(
  subject: string,
  body = '',
  options: { coAuthors?: readonly Author[]; enabled?: boolean } = {},
): string {
  const base = body.trim() ? `${subject.trim()}\n\n${body.trim()}` : subject.trim();
  if (options.enabled === false) return base;

  const authors = options.coAuthors ?? [DRIFT_COAUTHOR];
  return withTrailers(base, authors.map(coAuthorTrailer));
}
