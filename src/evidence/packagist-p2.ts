/** A Packagist p2 release. Later entries may omit fields inherited from the entry before them. */
export interface PackagistP2Release {
  version?: string;
}

/**
 * Expand Composer's minified p2 representation into self-contained releases.
 *
 * Packagist returns newest first. The first entry is complete; each following
 * entry contains only values that differ from the preceding effective entry.
 * Explicit null is retained because it means a field was removed, whereas an
 * omitted field inherits. Version identity is always taken from the current
 * entry and is never normalized.
 */
export function expandPackagistP2<T extends PackagistP2Release>(releases: readonly T[]): T[] {
  let inherited: Record<string, unknown> = {};
  return releases.map((release) => {
    const effective = { ...inherited, ...release } as T;
    inherited = effective as Record<string, unknown>;
    return effective;
  });
}

/** Select exact raw identity from already-expanded metadata. */
export function exactPackagistRelease<T extends PackagistP2Release>(
  releases: readonly T[],
  version: string,
): T | undefined {
  return releases.find((release) => release.version === version);
}
