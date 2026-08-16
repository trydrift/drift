import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DriftConfig } from '../../config/schema.js';
import type { Logger } from '../../util/logger.js';
import { execCommand, type Exec } from '../../util/exec.js';
import { openapiSpecProvider } from './openapi.js';
import { protobufSpecProvider } from './protobuf.js';
import { graphqlSpecProvider } from './graphql.js';
import type { SpecFindingCode, SpecOutcome, SpecProvider } from './types.js';
import type { SpecEvidenceSource } from './sources.js';

/**
 * Contract-document diffs, one provider per format.
 *
 * The registry the rest of the pipeline reads. `WEIGHTS` in `evidence/`,
 * `ORIGIN_CLASS` in `confidence/calibrate.ts`, `BY_FINDING_CODE` in
 * `confidence/taxonomy.ts` and the two switch statements in `analyze/rules.ts`
 * all derive their contract-format entries from here, so adding a format is
 * writing one provider file and adding it to this array — not editing five
 * files that each know one fifth of the answer.
 */

export const SPEC_PROVIDERS: readonly SpecProvider[] = [
  openapiSpecProvider,
  protobufSpecProvider,
  graphqlSpecProvider,
];

export function specProviderFor(source: string): SpecProvider | undefined {
  return SPEC_PROVIDERS.find((provider) => provider.source === source);
}

/** Evidence weight per contract-diff source, for the `WEIGHTS` table. */
export const SPEC_WEIGHTS = Object.fromEntries(
  SPEC_PROVIDERS.map((provider) => [provider.source, provider.weight]),
) as Record<SpecEvidenceSource, number>;

/** Corroboration class per contract-diff source, for `ORIGIN_CLASS`. */
export const SPEC_ORIGIN_CLASSES = Object.fromEntries(
  SPEC_PROVIDERS.map((provider) => [provider.source, provider.originClass]),
) as Record<SpecEvidenceSource, string>;

/**
 * Every finding code every provider can emit.
 *
 * Built once. A code claimed by two providers would be a genuine ambiguity —
 * two different meanings for one string in a shared table — so the first
 * registration wins and the duplicate is reported by the registry test rather
 * than silently overwriting a classification.
 */
const CODES: Record<string, SpecFindingCode> = Object.fromEntries(
  SPEC_PROVIDERS.flatMap((provider) => Object.entries(provider.codes)),
);

/** What a contract-diff finding code means, or `undefined` if it is not one. */
export function specCodeFor(code: string): SpecFindingCode | undefined {
  return CODES[code];
}

/** Whether this provider is switched on in the configuration. */
export function specEnabled(provider: SpecProvider, config: DriftConfig): boolean {
  return config.evidence[provider.config.enabled] === true;
}

/** The repo-relative document paths configured for this provider. */
export function specPaths(provider: SpecProvider, config: DriftConfig): readonly string[] {
  const configured = config.evidence[provider.config.paths];
  return Array.isArray(configured) ? (configured as string[]) : [];
}

export interface ComputeSpecOptions {
  logger: Logger;
  exec?: Exec;
  /** Environment to use for local toolchain commands. */
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Diff two revisions of one contract document.
 *
 * Always resolves, for the same reason `computeSurfaceDiff` does: a missing
 * `buf` and an unparseable document lead a developer to different actions, and
 * collapsing both into "no evidence" throws that difference away.
 */
export async function computeSpecDiff(
  provider: SpecProvider,
  document: { path: string; before: string; after: string },
  options: ComputeSpecOptions,
): Promise<SpecOutcome> {
  const workdir = await mkdtemp(join(tmpdir(), 'drift-spec-'));
  try {
    return await provider.compute({
      path: document.path,
      before: document.before,
      after: document.after,
      workdir,
      exec: options.exec ?? execCommand,
      logger: options.logger,
      ...(options.env ? { env: options.env } : {}),
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
  } catch (err) {
    // A provider throwing is a bug in Drift, not a fact about the document —
    // but it still must not take down the rest of the run.
    options.logger.debug(`Spec diff crashed for ${document.path}: ${(err as Error).message}`);
    return {
      available: false,
      reason: 'toolchain-failed',
      detail: `Drift could not compare ${document.path}: ${(err as Error).message}`,
      tool: provider.tool,
    };
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export * from './types.js';
export * from './sources.js';
export { parseSpec, diffSpecs, openapiSpecProvider } from './openapi.js';
export type { OpenApiFinding, OpenApiChangeKind } from './openapi.js';
export { protobufSpecProvider, parseBufBreaking, codeForBufRule, symbolFromBufMessage } from './protobuf.js';
export { graphqlSpecProvider, codeForChangeType } from './graphql.js';
