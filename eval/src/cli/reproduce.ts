import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import YAML from 'yaml';
import { loadPublicCase, loadPublicCases, publicCaseDir } from '../case/load.ts';
import { loadPrivateTruth, privateCaseDir } from '../case/private.ts';
import { materializeCase } from '../case/materialize.ts';
import { checkReproducibility } from '../oracle/reproducibility.ts';
import { privateTruthSchema, publicCaseSchema } from '../case/schema.ts';

/**
 * `eval:cases:reproduce` — the only command entitled to promote a case to
 * `benchmark-ready`, and the only one entitled to write a trigger signature.
 *
 * Both restrictions are deliberate. A trigger signature is a *measurement* of
 * the bump-only state; anything else writing one would be recording a
 * plausible-looking guess as benchmark evidence. And promotion has to be the
 * output of running the checks, never a field someone can set.
 *
 * `--write` is opt-in. Without it the command reports what it observed and
 * changes nothing, which is what you want when checking whether a case still
 * reproduces on a new machine.
 */

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const write = argv.includes('--write');
  const repetitions = Number(argv[argv.indexOf('--repetitions') + 1]) || 3;
  const ids = argv.filter((arg) => !arg.startsWith('--') && !/^\d+$/.test(arg));

  const cases = ids.length > 0 ? await Promise.all(ids.map((id) => loadPublicCase(id))) : await loadPublicCases();
  let failures = 0;

  for (const publicCase of cases) {
    const workspace = await materializeCase(publicCase);
    try {
      const truth = await loadPrivateTruth(publicCase.id).catch(() => null);
      const report = await checkReproducibility(publicCase, workspace, {
        repetitions,
        // The gold patch is applied as the third stage where one exists: a
        // recorded repair that does not actually repair cannot serve as
        // evidence of a valid one.
        ...(truth?.developerPatch ? { goldRepair: (dir: string) => applyGold(dir, truth.developerPatch!) } : {}),
      });

      console.log(`\n${publicCase.id}: ${report.verdict}`);
      console.log(`  ${report.reason}`);
      console.log(`  platform ${report.platform}/${report.arch} · ${report.repetitions} repetition(s)`);
      console.log(`  observed failure category: ${report.observedFailureCategory} (case declares ${publicCase.failureCategory})`);
      console.log(`  trigger signature (${report.triggerSignature.length}): ${JSON.stringify(report.triggerSignature)}`);

      if (report.observedFailureCategory !== publicCase.failureCategory) {
        // Reported, never silently corrected. A mismatch is usually a real
        // authoring error and deserves a person or a reviewer looking at it.
        console.log(`  NOTE: declared failure category disagrees with what was observed.`);
      }

      if (report.verdict !== 'benchmark-ready') failures += 1;

      if (write) {
        await writeStatus(publicCase.id, report.verdict, report.verdict === 'benchmark-ready' ? undefined : report.reason);
        await writeSignatures(publicCase.id, report.triggerSignature, report.baselineSignature);
        console.log(`  written: status=${report.verdict}, trigger signature recorded in private truth.`);
      }
    } finally {
      await workspace.teardown();
    }
  }

  return failures > 0 && argv.includes('--strict') ? 1 : 0;
}

/**
 * Applies the recorded developer/gold patch.
 *
 * A patch that will not apply is a defect in the *case*, not an error in the
 * run, so it surfaces as a failed gold-repaired stage — which the gate reads
 * as `oracle-insufficient` — rather than as a crash. Crashing loses every
 * other case in the sweep to one bad record.
 */
async function applyGold(consumerDir: string, patch: string): Promise<void> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const run = promisify(execFile);
  const temp = await mkdtemp(join(tmpdir(), 'drift-gold-'));
  try {
    const path = join(temp, 'gold.patch');
    await writeFile(path, patch.endsWith('\n') ? patch : `${patch}\n`, 'utf8');
    await run('git', ['apply', '-p1', '--whitespace=nowarn', path], { cwd: consumerDir }).catch((err: Error) => {
      throw new Error(`the recorded gold patch does not apply to this case: ${err.message}`);
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function writeStatus(caseId: string, status: string, reason?: string): Promise<void> {
  const path = join(publicCaseDir(caseId), 'case.yml');
  const parsed = YAML.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  parsed['status'] = status;
  if (reason) parsed['statusReason'] = reason;
  else delete parsed['statusReason'];
  await writeFile(path, YAML.stringify(publicCaseSchema.parse(parsed)), 'utf8');
}

async function writeSignatures(caseId: string, trigger: string[], baseline: string[]): Promise<void> {
  const path = join(privateCaseDir(caseId), 'truth.yml');
  const parsed = YAML.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  parsed['triggerSignature'] = trigger;
  parsed['baselineSignature'] = baseline;
  await writeFile(path, YAML.stringify(privateTruthSchema.parse(parsed)), 'utf8');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main();
}
