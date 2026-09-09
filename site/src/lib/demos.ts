import { ECOSYSTEM_CAPABILITIES } from "./capabilities.ts";

/**
 * The browser demos: every ecosystem Drift supports has a fixture here.
 *
 * Each entry mirrors `demos/<ecosystem>/demo.json` in `trydrift/demo`, which is
 * the source of truth: that repository holds the fixture, pins the dependency
 * at the *old* version, and lets Codespace creation apply the upgrade. What is
 * duplicated here is only what the page has to render — the package and the two
 * versions — and `demos.test.ts` pins the set of ecosystems against the core's
 * own capability list, so adding an ecosystem to Drift fails this build until a
 * demo for it exists.
 *
 * Labels are deliberately *not* repeated. They are read from
 * `ECOSYSTEM_CAPABILITIES`, which is generated from the core, so an ecosystem
 * renamed there renames itself here too.
 */
export interface Demo {
  /** Ecosystem id, matching `EcosystemCapability.ecosystem`. */
  ecosystem: string;
  /** The package the demo upgrades. */
  dependency: string;
  /** The version the fixture is committed at. */
  from: string;
  /** The version Codespace creation moves it to. */
  to: string;
}

/** The demo repository that hosts the fixtures and devcontainers. */
export const DEMO_REPO = "trydrift/demo";

export const DEMOS: readonly Demo[] = [
  { ecosystem: "npm", dependency: "axios", from: "0.21.4", to: "1.7.7" },
  { ecosystem: "pypi", dependency: "werkzeug", from: "2.0.3", to: "2.1.0" },
  {
    ecosystem: "go",
    dependency: "golang.org/x/exp",
    from: "v0.0.0-20230522175609-2e198f4a06a1",
    to: "v0.0.0-20231006140011-7918f672742d",
  },
  { ecosystem: "cargo", dependency: "clap", from: "2.34.0", to: "4.5.4" },
  { ecosystem: "maven", dependency: "com.google.guava:guava", from: "20.0", to: "21.0" },
  { ecosystem: "rubygems", dependency: "rack", from: "3.0.0", to: "3.1.0" },
  { ecosystem: "nuget", dependency: "AutoMapper", from: "8.1.1", to: "9.0.0" },
  { ecosystem: "packagist", dependency: "monolog/monolog", from: "2.9.3", to: "3.5.0" },
  { ecosystem: "hex", dependency: "plug", from: "1.13.6", to: "1.15.0" },
  { ecosystem: "pub", dependency: "dio", from: "4.0.6", to: "5.0.0" },
  { ecosystem: "swift", dependency: "Alamofire", from: "4.9.1", to: "5.9.1" },
  { ecosystem: "cocoapods", dependency: "Alamofire", from: "4.9.1", to: "5.9.1" },
  { ecosystem: "opam", dependency: "lwt", from: "4.5.0", to: "5.7.0" },
  { ecosystem: "conan", dependency: "fmt", from: "9.1.0", to: "10.2.1" },
  { ecosystem: "vcpkg", dependency: "catch2", from: "2.13.9", to: "3.5.2" },
  { ecosystem: "arduino", dependency: "bblanchon/ArduinoJson", from: "5.13.5", to: "6.21.3" },
];

/** The human label for a demo, read from the generated capability list. */
export function labelFor(ecosystem: string): string {
  return ECOSYSTEM_CAPABILITIES.find((c) => c.ecosystem === ecosystem)?.label ?? ecosystem;
}

/**
 * GitHub's Codespaces deep link for one demo's devcontainer.
 *
 * `devcontainer_path` is what selects the per-ecosystem container: without it
 * the create page asks the visitor to choose between sixteen, which is exactly
 * the decision the landing page already made for them.
 */
export function codespaceUrl(ecosystem: string): string {
  const path = encodeURIComponent(`.devcontainer/${ecosystem}/devcontainer.json`);
  return `https://codespaces.new/${DEMO_REPO}?quickstart=1&devcontainer_path=${path}`;
}

/** A short "axios 0.21.4 → 1.7.7" for the card. */
export function upgradeLabel(demo: Demo): string {
  // Go pseudo-versions (v0.0.0-20230522175609-2e198f4a06a1) carry the only part
  // a reader can compare — the date — buried between a zero version and a hash.
  const short = (v: string) => /^v0\.0\.0-(\d{8})\d*-/.exec(v)?.[1] ?? v;
  return `${demo.dependency} ${short(demo.from)} → ${short(demo.to)}`;
}
