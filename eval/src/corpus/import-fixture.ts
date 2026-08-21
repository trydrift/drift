import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import YAML from 'yaml';
import { hashTree } from '../hash.ts';
import { loadFixtures, loadFixtureYamlBody, type EvalFixture } from '../load.ts';
import { CASE_SCHEMA_VERSION, publicCaseSchema, privateTruthSchema, validateCase } from '../case/schema.ts';
import { publicCaseDir } from '../case/load.ts';
import { privateCaseDir } from '../case/private.ts';
import { loadAdjudication } from '../review.ts';

/**
 * Converts a legacy `eval/fixtures/<id>` fixture into the public/private case
 * layout, without inventing a single fact.
 *
 * Every field this writes is either copied from the fixture, copied from its
 * accepted adjudication, or recorded as the literal string `unavailable`. The
 * one *derived* field is the trigger signature, and it is deliberately left
 * empty here rather than guessed: it is a measurement, and the reproducibility
 * gate (`eval:cases:reproduce`) is the only thing entitled to write it.
 *
 * Two structural changes happen during the move, and both exist to make
 * detection genuinely measurable rather than assumed:
 *
 *   1. The consumer manifest declares REAL VERSIONS (`"fixture-lib": "2.0.0"`)
 *      instead of a `file:` path. A `file:` specifier carries no version, so
 *      `detectChanges` has nothing to diff and the end-to-end adapter would
 *      score a manifest-detection miss caused entirely by fixture authoring.
 *      The oracle repoints the manifest at the frozen local tree at install
 *      time, exactly as the previous harness already did.
 *   2. A `before/` directory is written holding the manifest as it read
 *      pre-bump. That is what turns "a fixture that is already broken" into "a
 *      dependency update with two sides", which is what production diffs.
 *
 * Ground truth moves wholesale into `eval/cases/private/<id>/` — reviews,
 * adjudication and gold patch together — so the public case directory can be
 * handed to a coding agent without further filtering.
 */

export const IMPORTER_VERSION = 'fixture-import-v1';

export interface ImportResult {
  caseId: string;
  publicDir: string;
  privateDir: string;
  warnings: string[];
}

export async function importFixtureAsCase(fixture: EvalFixture, root = process.cwd()): Promise<ImportResult> {
  const warnings: string[] = [];
  const fixtureDir = join(root, 'eval', 'fixtures', fixture.id);
  const publicDir = publicCaseDir(fixture.id, root);
  const privateDir = privateCaseDir(fixture.id, root);

  await mkdir(publicDir, { recursive: true });
  await mkdir(privateDir, { recursive: true });

  await cp(join(fixtureDir, 'consumer'), join(publicDir, 'consumer'), { recursive: true });
  await cp(join(fixtureDir, 'upstream', 'old'), join(publicDir, 'upstream', 'old'), { recursive: true });
  await cp(join(fixtureDir, 'upstream', 'new'), join(publicDir, 'upstream', 'new'), { recursive: true });
  // Frozen upstream prose, when the fixture has any. Public by construction:
  // it is what a networked run would have fetched, so a prediction must see it.
  await rm(join(publicDir, 'evidence'), { recursive: true, force: true });
  await cp(join(fixtureDir, 'evidence'), join(publicDir, 'evidence'), { recursive: true }).catch(() => undefined);

  const manifestPath = join(publicDir, 'consumer', 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  if (!manifest.dependencies?.[fixture.dependency]) {
    throw new Error(`${fixture.id}: consumer manifest does not declare ${fixture.dependency}.`);
  }

  // After: the bump-only state, declaring the real new version.
  manifest.dependencies[fixture.dependency] = fixture.toVersion;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  // Before: the same manifest declaring the real old version, and nothing else.
  await mkdir(join(publicDir, 'before'), { recursive: true });
  const beforeManifest = { ...manifest, dependencies: { ...manifest.dependencies, [fixture.dependency]: fixture.fromVersion } };
  await writeFile(join(publicDir, 'before', 'package.json'), `${JSON.stringify(beforeManifest, null, 2)}\n`, 'utf8');

  const adjudication = await loadAdjudication(fixture.id, join(root, 'eval', 'fixtures'));
  if (!adjudication) warnings.push(`${fixture.id}: no adjudication found; the case is imported as a candidate.`);

  const [consumerTree, upstreamOld, upstreamNew] = await Promise.all([
    hashTree(join(publicDir, 'consumer')),
    hashTree(join(publicDir, 'upstream', 'old')),
    hashTree(join(publicDir, 'upstream', 'new')),
  ]);

  const publicCase = publicCaseSchema.parse({
    schemaVersion: CASE_SCHEMA_VERSION,
    id: fixture.id,
    provenanceKind: fixture.provenance.kind,
    ecosystem: fixture.ecosystem,
    // Imported fixtures keep whatever readiness they had earned under the old
    // harness, but only if they still have an accepted adjudication behind it.
    status: adjudication?.status === 'accepted' && fixture.readiness === 'benchmark-ready' ? 'benchmark-ready' : 'candidate',
    ...(adjudication?.status === 'accepted' && fixture.readiness === 'benchmark-ready'
      ? {}
      : { statusReason: 'Imported from a legacy fixture without an accepted adjudication.' }),
    consumer: {
      repository: fixture.source.repository,
      licence: fixture.source.licence,
      // A synthetic case has no upstream commit to pin; recorded as such
      // rather than filled with a plausible-looking hash.
      baseCommit: fixture.provenance.kind === 'synthetic' ? 'synthetic' : 'unavailable',
      migrationCommit: null,
      manifestPaths: ['package.json'],
      lockfilePaths: [],
      workspaceDir: '',
    },
    dependency: {
      name: fixture.dependency,
      fromVersion: fixture.fromVersion,
      toVersion: fixture.toVersion,
      updateClass: updateClassOf(fixture.fromVersion, fixture.toVersion),
      section: 'dependencies',
      exposure: fixture.exposure,
      upstreamRepository: 'unavailable',
      upstreamFromRef: 'unavailable',
      upstreamToRef: 'unavailable',
    },
    graph: {
      // A local synthetic package has exactly one node and no transitive
      // closure to resolve, so this is a complete statement rather than a
      // partial one — worth saying explicitly, because for a historical case
      // an incomplete graph would be a serious omission.
      before: [{ name: fixture.dependency, version: fixture.fromVersion }],
      after: [{ name: fixture.dependency, version: fixture.toVersion }],
      effectiveChanges: [{ name: fixture.dependency, from: fixture.fromVersion, to: fixture.toVersion }],
    },
    environment: {
      runtimeVersion: process.version,
      packageManager: 'npm',
      packageManagerVersion: 'unavailable',
      containerDigest: 'unavailable',
      platform: process.platform,
      arch: process.arch,
      timezone: 'UTC',
      locale: 'C',
    },
    oracles: {
      install: 'npm install --package-lock=false --ignore-scripts',
      baseline: { ...fixture.oracles.baseline, provenance: 'project-native' },
      broken: { ...fixture.oracles.broken, provenance: 'project-native' },
      repaired: { ...fixture.oracles.repaired, provenance: 'project-native' },
    },
    networkPolicy: fixture.network === 'disabled' ? 'disabled' : 'allowed',
    discovery: {
      source: 'synthetic',
      reference: `eval/fixtures/${fixture.id}`,
      minedAt: fixture.provenance.createdAt,
      minerVersion: IMPORTER_VERSION,
      importedFrom: '',
    },
    failureCategory: fixture.oracles.broken.expect === 'fail' ? 'runtime-failure' : 'none',
    migrationComplexity: complexityFor(fixture, adjudication?.decision.repair.expectedAction),
    artifactHashes: {
      consumerTree,
      upstreamOld,
      upstreamNew,
      lockfileBefore: 'unavailable',
      lockfileAfter: 'unavailable',
      evidenceBundle: 'unavailable',
    },
  });

  const problems = validateCase(publicCase);
  if (problems.length > 0) throw new Error(problems.join('\n'));
  await writeFile(join(publicDir, 'case.yml'), YAML.stringify(publicCase), 'utf8');

  // Private half: reviews, adjudication and the gold patch move together, so
  // the public directory needs no further filtering before an agent sees it.
  await cp(join(fixtureDir, 'reviews'), join(privateDir, 'reviews'), { recursive: true }).catch(() => undefined);
  await cp(join(fixtureDir, 'adjudication.yml'), join(privateDir, 'adjudication.yml')).catch(() => undefined);
  await cp(join(fixtureDir, 'expected'), join(privateDir, 'expected'), { recursive: true }).catch(() => undefined);

  const goldPatch = await readFile(join(fixtureDir, 'expected', 'gold.patch'), 'utf8').catch(() => null);

  // Hidden behavioural checks are authored in the fixture tree, where a
  // reviewer sees them and where `hashFixtureRevision` hashes them. The
  // declarations move into private truth and the check sources move alongside
  // them as real files. One source, one review, one hash.
  const hiddenChecksBody = await readFile(join(fixtureDir, 'hidden', 'checks.yml'), 'utf8').catch(() => null);
  const hiddenChecks = hiddenChecksBody ? (YAML.parse(hiddenChecksBody) as unknown[]) : [];
  await rm(join(privateDir, 'hidden'), { recursive: true, force: true });
  if (hiddenChecksBody) await cp(join(fixtureDir, 'hidden'), join(privateDir, 'hidden'), { recursive: true });

  // Measurements already recorded against this case are carried forward, never
  // re-derived. `triggerSignature` and `baselineSignature` are outputs of the
  // reproducibility gate; an importer that reset them would silently delete
  // benchmark evidence every time a fixture was re-imported, and the case
  // would then look un-measured rather than measured.
  const existing = await readFile(join(privateDir, 'truth.yml'), 'utf8')
    .then((body) => privateTruthSchema.parse(YAML.parse(body)))
    .catch(() => null);

  const truth = privateTruthSchema.parse({
    schemaVersion: CASE_SCHEMA_VERSION,
    caseId: fixture.id,
    adjudicationRef: 'adjudication.yml',
    developerPatch: goldPatch,
    developerPatchFiles: adjudication?.decision.repair.expectedChangedFiles ?? [],
    hiddenChecks,
    // Only the reproducibility gate may *record* a trigger signature, because
    // it is a measurement of the bump-only state; the importer may only carry
    // an existing one across, never invent one.
    triggerSignature: existing?.triggerSignature ?? [],
    baselineSignature: existing?.baselineSignature ?? [],
    notes: `Imported from eval/fixtures/${fixture.id} by ${IMPORTER_VERSION}.`,
  });
  await writeFile(join(privateDir, 'truth.yml'), YAML.stringify(truth), 'utf8');

  const fixtureBody = await loadFixtureYamlBody(fixture.id, join(root, 'eval', 'fixtures'));
  if (/expected:/m.test(fixtureBody)) warnings.push(`${fixture.id}: legacy fixture body mentioned an expected block.`);

  return { caseId: fixture.id, publicDir, privateDir, warnings };
}

function updateClassOf(from: string, to: string): 'major' | 'minor' | 'patch' | 'other' {
  const parse = (value: string): number[] | null => {
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
  };
  const a = parse(from);
  const b = parse(to);
  if (!a || !b) return 'other';
  if (a[0] !== b[0]) return 'major';
  if (a[1] !== b[1]) return 'minor';
  if (a[2] !== b[2]) return 'patch';
  return 'other';
}

/**
 * Migration complexity, from adjudicated facts only.
 *
 * `none` when accepted truth says no repair is needed. `direct` only for the
 * rename shapes, whose gold patches are a one-identifier substitution. Anything
 * else is `compound` rather than a more specific guess — this dimension exists
 * for stratification, and a wrong stratum is worse than a coarse one.
 */
function complexityFor(fixture: EvalFixture, expectedAction: string | undefined): 'direct' | 'compound' | 'none' {
  if (expectedAction === 'no-repair-needed') return 'none';
  return /rename/.test(fixture.scenarioLabel) ? 'direct' : 'compound';
}

export async function importAllFixtures(root = process.cwd()): Promise<ImportResult[]> {
  const fixtures = await loadFixtures(join(root, 'eval', 'fixtures'));
  const results: ImportResult[] = [];
  for (const fixture of fixtures) results.push(await importFixtureAsCase(fixture, root));
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const results = await importAllFixtures();
  for (const result of results) {
    console.log(`imported ${result.caseId} -> ${result.publicDir}`);
    for (const warning of result.warnings) console.log(`  warning: ${warning}`);
  }
}
