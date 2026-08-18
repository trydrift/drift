/**
 * Where a human goes to read about a package.
 *
 * Not the API endpoint the evidence layer fetches — the page a developer would
 * open. A terminal that renders OSC 8 turns the package name in a scan into a
 * link straight to it, which removes the step every developer takes anyway
 * after reading a row: copying the name and searching for it.
 *
 * Returns `null` rather than guessing. Two of these ecosystems genuinely have
 * no canonical package page — SwiftPM resolves straight from a git host, and a
 * Maven coordinate is only a URL once it has been split on its colon — and a
 * link to a 404 is worse than a name that is simply not a link.
 */

import type { Ecosystem } from '../types.js';

export function registryUrl(ecosystem: Ecosystem, name: string): string | null {
  const encoded = encodeURIComponent(name);
  switch (ecosystem) {
    case 'npm':
      // Scoped names keep their slash: `npmjs.com/package/@scope/pkg` is the
      // real page, and the percent-encoded form redirects at best.
      return `https://www.npmjs.com/package/${encoded.replaceAll('%40', '@').replaceAll('%2F', '/')}`;
    case 'pypi':
      return `https://pypi.org/project/${encoded}/`;
    case 'cargo':
      return `https://crates.io/crates/${encoded}`;
    case 'go':
      // Module paths are already URL-shaped and must not be encoded as one
      // segment, or every slash in them becomes %2F.
      return `https://pkg.go.dev/${name}`;
    case 'rubygems':
      return `https://rubygems.org/gems/${encoded}`;
    case 'nuget':
      return `https://www.nuget.org/packages/${encoded}`;
    case 'packagist':
      return `https://packagist.org/packages/${name}`;
    case 'hex':
      return `https://hex.pm/packages/${encoded}`;
    case 'pub':
      return `https://pub.dev/packages/${encoded}`;
    case 'cocoapods':
      return `https://cocoapods.org/pods/${encoded}`;
    case 'conan':
      return `https://conan.io/center/recipes/${encoded}`;
    case 'vcpkg':
      return `https://vcpkg.io/en/package/${encoded}`;
    case 'opam':
      return `https://opam.ocaml.org/packages/${encoded}/`;
    case 'arduino':
      return `https://registry.platformio.org/search?q=${encoded}`;
    case 'maven': {
      // `group:artifact`, which Central's site takes as two path segments.
      const [group, artifact] = name.split(':');
      if (!group || !artifact) return null;
      return `https://central.sonatype.com/artifact/${encodeURIComponent(group)}/${encodeURIComponent(artifact)}`;
    }
    case 'swift':
      // A SwiftPM dependency is identified by its git URL, and the name Drift
      // carries is derived from it rather than registered anywhere.
      return null;
  }
}
