import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ECOSYSTEM_CAPABILITIES } from "./capabilities.ts";
import { DEMOS, codespaceUrl, labelFor, upgradeLabel } from "./demos.ts";

describe("browser demos", () => {
  /*
   * The claim the landing page makes is "every ecosystem Drift supports, you can
   * try in a browser". That claim is only true while the two lists agree, and
   * the failure mode is silent: an ecosystem added to the core would simply be
   * missing from the demo grid and nobody would notice. So it fails the build.
   */
  test("the demo set and the supported ecosystems are the same set", () => {
    const supported = ECOSYSTEM_CAPABILITIES.map((c) => c.ecosystem).sort();
    const demoed = DEMOS.map((d) => d.ecosystem).sort();
    assert.deepEqual(demoed, supported);
  });

  test("every demo resolves a real label from the generated capability list", () => {
    for (const demo of DEMOS) {
      assert.notEqual(labelFor(demo.ecosystem), demo.ecosystem, `${demo.ecosystem} has a label`);
    }
  });

  test("a demo actually upgrades: the two versions differ", () => {
    for (const demo of DEMOS) {
      assert.notEqual(demo.from, demo.to, `${demo.ecosystem} moves version`);
    }
  });

  test("the Codespaces link selects that demo's own devcontainer", () => {
    // The encoded path is what stops the create page asking the visitor to pick
    // one of sixteen containers, so it is the part worth pinning.
    const url = codespaceUrl("npm");
    assert.match(url, /^https:\/\/codespaces\.new\/trydrift\/demo\?/);
    assert.match(url, /devcontainer_path=\.devcontainer%2Fnpm%2Fdevcontainer\.json/);
  });

  test("Go's pseudo-versions are shortened to something a card can show", () => {
    const go = DEMOS.find((d) => d.ecosystem === "go")!;
    const label = upgradeLabel(go);
    assert.match(label, /golang\.org\/x\/exp 20230522 → 20231006/);
  });

  test("an ordinary version is left alone", () => {
    const npm = DEMOS.find((d) => d.ecosystem === "npm")!;
    assert.equal(upgradeLabel(npm), "axios 0.21.4 → 1.7.7");
  });
});
