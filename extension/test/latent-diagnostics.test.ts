import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { DriftDiagnostics } from '../src/ui/diagnostics.js';
import { DriftState } from '../src/state.js';
import type { AuditResult, LatentFinding } from '../../src/audit/types.js';
import type { RemediationPlan } from '../../src/types.js';

/**
 * The editor's present tense.
 *
 * Drift's markers had only ever meant "this would break if you took the
 * upgrade in front of you". These are the other kind: the dependency named is
 * the one in `node_modules` right now, and the code under the squiggle is
 * wrong today. The two have to coexist in the same file without either one
 * erasing the other, and they have to *read* differently, or the distinction
 * that makes the new ones worth acting on is lost.
 */

const ROOT = '/tmp/drift-latent-test';

type Store = Map<string, vscode.Diagnostic[]>;

const collectionStore = (diagnostics: DriftDiagnostics): Store =>
  (diagnostics as unknown as { collection: { __store: Store } }).collection.__store;

function stateWith(options: { audit?: AuditResult; plan?: RemediationPlan }): DriftState {
  const state = new DriftState();
  state.setRoots([{ path: ROOT, label: 'app', repo: null, gitRoot: ROOT, subprojects: [] }]);
  if (options.plan) state.set({ kind: 'findings', plan: options.plan, at: Date.now() });
  if (options.audit) state.setAudit(options.audit);
  return state;
}

const finding = (over: Partial<LatentFinding> = {}): LatentFinding => ({
  id: 'latent_1',
  kind: 'unreviewed-drift',
  dependency: 'phaser',
  ecosystem: 'npm',
  manifestPath: 'package.json',
  declaredRange: '^3.60.0',
  installedVersion: '3.90.0',
  breakingChange: {
    id: 'bc_1',
    dependency: 'phaser',
    kind: 'removed-export',
    summary: '`Phaser.Sound.HTML5AudioSound.setMute` was removed in 3.80.0.',
    remediation: 'Set `mute` on the sound instance directly.',
    symbols: ['setMute'],
    confidence: 'high',
    citations: ['ev_1'],
  },
  sites: [
    {
      breakingChangeId: 'bc_1',
      file: 'src/audio.ts',
      line: 42,
      excerpt: 'this.sound.setMute(true);',
      matchedSymbol: 'setMute',
      confidence: 'high',
    },
  ],
  summary: 'phaser 3.90.0 is installed: `setMute` was removed in 3.80.0.',
  ...over,
});

const auditOf = (findings: LatentFinding[]): AuditResult => ({
  findings,
  checked: 8,
  analysed: 3,
  gaps: [],
  checkedSurfaces: [],
});

describe('inline markers for already-installed breakage', () => {
  test('a latent finding becomes a marker on its own line', () => {
    const diagnostics = new DriftDiagnostics(stateWith({ audit: auditOf([finding()]) }));
    diagnostics.render();

    const entries = [...collectionStore(diagnostics).values()].flat();
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.range.start.line, 41, 'site lines are 1-indexed, ranges are 0-indexed');
    diagnostics.dispose();
  });

  test('the message names the installed version, in the present tense', () => {
    const diagnostics = new DriftDiagnostics(stateWith({ audit: auditOf([finding()]) }));
    diagnostics.render();

    const [entry] = [...collectionStore(diagnostics).values()].flat();
    // The distinction the whole feature rests on. "This breaks in 3.90.0" is a
    // problem for later; "3.90.0 is installed" is a problem for now.
    assert.match(entry!.message, /phaser 3\.90\.0 is installed/);
    assert.doesNotMatch(entry!.message, /would break|if you upgrade/i);
    diagnostics.dispose();
  });

  test('a high-confidence latent site is an error, because the code is broken now', () => {
    // Severity tracks certainty, not age. A high-confidence latent finding
    // means this file binds the symbol from that dependency's import and the
    // symbol is not in the version on disk. That it has been true for months
    // is not evidence it is harmless — it usually means nobody has run that
    // path lately.
    const diagnostics = new DriftDiagnostics(stateWith({ audit: auditOf([finding()]) }));
    diagnostics.render();

    const [entry] = [...collectionStore(diagnostics).values()].flat();
    assert.equal(entry!.severity, vscode.DiagnosticSeverity.Error);
    diagnostics.dispose();
  });

  test('a medium-confidence latent site is a warning', () => {
    const unsure = finding({
      sites: [
        {
          breakingChangeId: 'bc_1',
          file: 'src/audio.ts',
          line: 7,
          excerpt: 'setMute(true);',
          matchedSymbol: 'setMute',
          confidence: 'medium',
        },
      ],
    });

    const diagnostics = new DriftDiagnostics(stateWith({ audit: auditOf([unsure]) }));
    diagnostics.render();

    const [entry] = [...collectionStore(diagnostics).values()].flat();
    assert.equal(entry!.severity, vscode.DiagnosticSeverity.Warning);
    diagnostics.dispose();
  });

  test('a low-confidence latent site is downgraded to information', () => {
    const quiet = finding({
      sites: [
        {
          breakingChangeId: 'bc_1',
          file: 'src/audio.ts',
          line: 7,
          excerpt: 'setMute(true);',
          matchedSymbol: 'setMute',
          confidence: 'low',
        },
      ],
    });

    const diagnostics = new DriftDiagnostics(stateWith({ audit: auditOf([quiet]) }));
    diagnostics.render();

    const [entry] = [...collectionStore(diagnostics).values()].flat();
    assert.equal(entry!.severity, vscode.DiagnosticSeverity.Information);
    diagnostics.dispose();
  });

  test('the marker explains it was checked against the real installed package', () => {
    const diagnostics = new DriftDiagnostics(stateWith({ audit: auditOf([finding()]) }));
    diagnostics.render();

    const [entry] = [...collectionStore(diagnostics).values()].flat();
    const related = (entry!.relatedInformation ?? []) as { message: string }[];
    assert.match(related[0]!.message, /phaser@3\.90\.0/);
    assert.match(related[0]!.message, /node_modules/);
    diagnostics.dispose();
  });

  test('markers survive an idle status, because the findings do', () => {
    // A latent finding is not tied to any one analysis. Clearing it when the
    // status went back to idle would erase real, unaddressed problems every
    // time the developer dismissed a report.
    const state = stateWith({ audit: auditOf([finding()]) });
    const diagnostics = new DriftDiagnostics(state);

    state.set({ kind: 'idle' });
    diagnostics.render();

    assert.equal([...collectionStore(diagnostics).values()].flat().length, 1);
    diagnostics.dispose();
  });

  test('an audit with no findings publishes nothing', () => {
    const diagnostics = new DriftDiagnostics(stateWith({ audit: auditOf([]) }));
    diagnostics.render();
    assert.equal([...collectionStore(diagnostics).values()].flat().length, 0);
    diagnostics.dispose();
  });
});

describe('coexisting with plan markers', () => {
  const plan = {
    schemaVersion: 1,
    id: 'plan_1',
    branchName: 'drift/x',
    baseBranch: 'main',
    headSha: 'abc',
    changes: [],
    evidence: [],
    breakingChanges: [
      {
        id: 'bc_plan',
        dependency: 'left-pad',
        kind: 'removed-export' as const,
        summary: '`leftPad` was removed.',
        remediation: 'Use `String.prototype.padStart`.',
        symbols: ['leftPad'],
        confidence: 'high' as const,
        citations: [],
      },
    ],
    impactSites: [
      {
        breakingChangeId: 'bc_plan',
        file: 'src/audio.ts',
        line: 9,
        excerpt: 'leftPad(x, 2);',
        matchedSymbol: 'leftPad',
        confidence: 'high' as const,
      },
    ],
    commits: [],
    planEdges: [],
    upgradeCohorts: [],
    risk: 'medium' as const,
    gaps: [],
    checkedSurfaces: [],
    blockers: [],
    warnings: [],
    createdAt: new Date(0).toISOString(),
  } satisfies RemediationPlan;

  test('a file with both kinds keeps both', () => {
    // `DiagnosticCollection.set` replaces a file's markers outright, so the two
    // passes have to be merged before publishing — otherwise the file a
    // developer most needs to see completely is the one that shows half.
    const diagnostics = new DriftDiagnostics(stateWith({ plan, audit: auditOf([finding()]) }));
    diagnostics.render();

    const entries = [...collectionStore(diagnostics).values()].flat();
    assert.equal(entries.length, 2, 'the plan site and the latent site are both in src/audio.ts');
    assert.ok(entries.some((d) => /leftPad/.test(d.message)));
    assert.ok(entries.some((d) => /phaser 3\.90\.0 is installed/.test(d.message)));
    diagnostics.dispose();
  });
});
