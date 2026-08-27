/**
 * The recording engine's analyzer-environment contract (#138).
 *
 * Most evidence surfaces only read repository text, so Drift's own source is
 * the whole story for what a recording contains. A few surfaces are
 * different: they hand the analysed package to an external interpreter or
 * toolchain and let *it* do the parsing — Python's own `ast` module reads
 * Python source in `src/evidence/surface/python.ts`, for instance. A
 * different installed version of that tool can read a different surface out
 * of the exact same package version (a syntax the running interpreter
 * cannot parse is silently unreadable to it), so the tool's version is real
 * analyzer identity, not incidental machine detail — and belongs in the
 * recording's freshness fingerprint the same way Drift's own source does.
 *
 * Reproducibility contract (Option B: semantic normalization, not exact
 * pinning — see #138):
 *
 *   - Only the **major.minor** version of a listed tool is semantically
 *     relevant here. A patch release does not change what syntax the tool
 *     can parse, so pinning to an exact patch would make a routine patch
 *     bump on a CI runner image falsely invalidate every recording, and a
 *     contributor whose local interpreter is one patch behind would never be
 *     able to produce a recording CI accepts as current.
 *   - `normalize()` reduces raw `--version` output to that major.minor
 *     string, and is the ONLY thing `engine-fingerprint.mjs` hashes — never
 *     the raw version string. Two environments are equivalent, and share a
 *     fingerprint, exactly when they normalize to the same value; anything
 *     that normalizes differently (a materially different interpreter) is
 *     guaranteed a different one.
 *   - `declared` documents the version this repository's CI pins (see
 *     `.github/workflows/refresh-recordings.yml`'s `actions/setup-python`
 *     step) so a reader can see the intended environment at a glance. It is
 *     not enforced against the actual interpreter at fingerprint time: doing
 *     so would make every context that computes a fingerprint (`npm test`,
 *     the site build) hard-fail in any environment that has not separately
 *     pinned that exact tool, which most do not. What every context *does*
 *     get is the actual normalized identity, applied identically wherever it
 *     runs — the reproducibility guarantee, without a new hard dependency.
 *   - A tool that cannot be run at all (missing, not just a different
 *     version) is never folded into a shared "unavailable" placeholder that
 *     every broken environment would collide on — `engine-fingerprint.mjs`
 *     fails loudly instead, because a recording captured without a required
 *     analyzer is not evidence of what Drift actually does.
 *
 * Go, Rust (`cargo public-api`), and Java (`japicmp`) evidence surfaces also
 * shell out to external tools, but are deliberately not enrolled here yet:
 * none of them is pinned by any workflow in this repository the way Python
 * is (there is no `actions/setup-go`, for instance), so making one of them a
 * hard analyzer-identity input would fail every environment that has not
 * separately pinned it — a repository-wide CI change this fix does not make.
 * Enrolling them is a natural follow-up once they are pinned the same way.
 */
export const RECORDING_ANALYZER_ENVIRONMENT = {
  python: {
    declared: '3.12',
    executable: 'python3',
    versionArgs: ['--version'],
    /** `"Python 3.12.7"` (or on stderr, on some builds) -> `"3.12"`. */
    normalize(rawVersionOutput) {
      const match = /Python\s+(\d+)\.(\d+)/.exec(rawVersionOutput);
      return match ? `${match[1]}.${match[2]}` : null;
    },
  },
};
