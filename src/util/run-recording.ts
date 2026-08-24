/**
 * Decide whether this CLI invocation should create a repo-local run log.
 * Recording is off by default; explicit CLI flags override the machine-level
 * environment preference.
 */
export function shouldRecordRun(
  flags: Readonly<Record<string, string | boolean>>,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (flags['no-record-run'] === true) return false;
  if (flags['record-run'] === true) return true;
  const value = env.DRIFT_RECORD_RUNS?.trim().toLowerCase();
  return value === '1' || value === 'true';
}
