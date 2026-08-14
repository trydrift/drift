/**
 * Who gets credit for a commit Drift made.
 *
 * Drift edits code, but it is not a contributor with its own GitHub account —
 * it acts for the org that publishes it. `Co-authored-by` is the wrong trailer
 * for that: GitHub resolves that email to whichever account happens to own it,
 * which once meant a stranger who had claimed the `drift` username got credited
 * on every commit this tool touched. `On-behalf-of` says the same thing without
 * asking GitHub to guess an identity — it is a real trailer convention (used by
 * Debian and Gerrit tooling), `git log`/`git interpret-trailers` read it like
 * any other trailer, GitHub just doesn't try to attach an avatar to it.
 *
 * Any coding agent that actually produced an edit is a different case — it has
 * no email a GitHub account could plausibly claim, so it still gets a normal
 * `Co-authored-by` trailer.
 *
 * The trailer is added, never substituted. The human stays the author: they
 * chose the upgrade, reviewed the diff, and pressed the button. Rewriting
 * authorship to a tool would misattribute a decision a person made.
 */

export interface Author {
  name: string;
  email: string;
}

/** The org this tool acts on behalf of, credited on every commit it makes. */
export const DRIFT_ATTRIBUTION: Author = {
  name: 'Drift',
  email: 'trydrift@outlook.com',
};

/** `Co-authored-by: Name <email>` for one author. */
export function coAuthorTrailer(author: Author): string {
  return `Co-authored-by: ${author.name} <${author.email}>`;
}

/** `On-behalf-of: Name <email>` — attribution GitHub will not try to link to an account. */
export function onBehalfOfTrailer(author: Author): string {
  return `On-behalf-of: ${author.name} <${author.email}>`;
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
 * A commit message with Drift credited on behalf of its org, plus anyone else
 * who contributed.
 *
 * The single entry point every surface uses — the CLI, the GitHub Action, and
 * the extension — so that attribution cannot be present in one and missing in
 * another. `coAuthors` carries anything a caller wants credited alongside
 * Drift, such as the coding agent that actually produced an edit; those get a
 * normal `Co-authored-by` trailer since, unlike Drift, they are not the org.
 */
export function attributedMessage(
  subject: string,
  body = '',
  options: { coAuthors?: readonly Author[]; enabled?: boolean } = {},
): string {
  const base = body.trim() ? `${subject.trim()}\n\n${body.trim()}` : subject.trim();
  if (options.enabled === false) return base;

  const trailers = [onBehalfOfTrailer(DRIFT_ATTRIBUTION), ...(options.coAuthors ?? []).map(coAuthorTrailer)];
  return withTrailers(base, trailers);
}
