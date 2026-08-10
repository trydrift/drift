import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rangeFloor, satisfiesRange } from '../dist/audit/range.js';
import { auditCurrentUsage, summarizeAudit } from '../dist/audit/index.js';
import { renderAudit, auditHeadline } from '../dist/report/audit.js';
import { alphaEquivalent } from '../dist/evidence/type-surface.js';
import { DriftConfigSchema } from '../dist/config/schema.js';
import { createLogger } from '../dist/util/logger.js';
import type { AuditResult, LatentFinding } from '../dist/audit/types.js';

const logger = createLogger('error');
const config = DriftConfigSchema.parse({});

const repo = {
  owner: 'acme',
  repo: 'app',
  baseBranch: 'main',
  beforeSha: 'HEAD',
  afterSha: 'HEAD',
};

/**
 * The floor is the whole feature: it decides which window gets analysed, so a
 * wrong answer here either invents findings out of a window that was never
 * unreviewed, or silently reports nothing on a project that has real drift.
 */
describe('range floors', () => {
  test('npm caret and tilde ranges floor at their lowest admitted version', () => {
    assert.equal(rangeFloor('^4.0.0', 'npm'), '4.0.0');
    assert.equal(rangeFloor('~4.1.2', 'npm'), '4.1.2');
    assert.equal(rangeFloor('>=2.1.0 <5', 'npm'), '2.1.0');
    assert.equal(rangeFloor('4.x', 'npm'), '4.0.0');
  });

  test('an exact pin floors at itself, which leaves no window', () => {
    assert.equal(rangeFloor('4.2.0', 'npm'), '4.2.0');
    assert.equal(rangeFloor('=1.4.2', 'rubygems'), '1.4.2');
    assert.equal(rangeFloor('==1.2.3', 'pypi'), '1.2.3');
  });

  test('a wildcard states no lower bound and is refused rather than guessed', () => {
    // Treating `*` as 0.0.0 would open a window spanning the package's entire
    // history and report every change it ever made as unreviewed drift.
    assert.equal(rangeFloor('*', 'npm'), null);
    assert.equal(rangeFloor('latest', 'npm'), null);
    assert.equal(rangeFloor('', 'npm'), null);
  });

  test('PEP 440 specifier sets take the highest lower bound', () => {
    assert.equal(rangeFloor('>=2.0,<3', 'pypi'), '2.0.0');
    assert.equal(rangeFloor('~=1.4.2', 'pypi'), '1.4.2');
    assert.equal(rangeFloor('>=1.0,>=2.5,<4', 'pypi'), '2.5.0');
    assert.equal(rangeFloor('==1.2.*', 'pypi'), '1.2.0');
  });

  test('upper bounds and exclusions never contribute a floor', () => {
    assert.equal(rangeFloor('<3.0', 'pypi'), null);
    assert.equal(rangeFloor('!=1.5', 'pypi'), null);
    assert.equal(rangeFloor('<= 4.0', 'rubygems'), null);
  });

  test("Ruby's pessimistic operator is a lower bound", () => {
    assert.equal(rangeFloor('~> 3.0', 'rubygems'), '3.0.0');
    assert.equal(rangeFloor('>= 2.1, < 4', 'rubygems'), '2.1.0');
  });

  test('Maven and NuGet interval notation reads its lower bracket', () => {
    assert.equal(rangeFloor('[1.0,2.0)', 'maven'), '1.0.0');
    assert.equal(rangeFloor('(1.5,]', 'nuget'), '1.5.0');
    assert.equal(rangeFloor('3.4.1', 'maven'), '3.4.1');
  });

  test('an unbounded lower bracket yields no floor', () => {
    assert.equal(rangeFloor('[,2.0)', 'maven'), null);
  });

  test('Go and Swift coordinates are exact versions', () => {
    assert.equal(rangeFloor('v1.9.3', 'go'), '1.9.3');
  });
});

describe('range satisfaction', () => {
  test('reports a lockfile that contradicts its own manifest', () => {
    assert.equal(satisfiesRange('5.1.0', '^4.0.0', 'npm'), false);
    assert.equal(satisfiesRange('4.9.0', '^4.0.0', 'npm'), true);
  });

  test('declines to answer where the notation is not unambiguous', () => {
    // `null` means "not checked". A caller that rendered it as `false` would
    // report a violation that was really a parser limitation.
    assert.equal(satisfiesRange('2.0.0', '~> 1.0', 'rubygems'), null);
    assert.equal(satisfiesRange('2.0.0', '>=1.0', 'pypi'), null);
  });

  test('a wildcard is satisfied by anything', () => {
    assert.equal(satisfiesRange('9.9.9', '*', 'npm'), true);
  });
});

/**
 * End-to-end over a temporary checkout.
 *
 * `evidence.githubReleases`/`changelog` are off so nothing here reaches the
 * network: the audit must still do its own job — read the manifest and
 * lockfile, compute the window, walk the code — and reach an honest, empty
 * conclusion rather than throwing or inventing one.
 */
describe('auditing a checkout', () => {
  const offline = DriftConfigSchema.parse({
    evidence: { githubReleases: false, changelog: false, typeSurface: false, openapi: false },
    rationale: { security: false, maintenance: false, summary: false },
  });

  const scaffold = async (files: Record<string, string>) => {
    const root = await mkdtemp(join(tmpdir(), 'drift-audit-'));
    for (const [path, content] of Object.entries(files)) {
      const full = join(root, path);
      await mkdir(join(full, '..'), { recursive: true });
      await writeFile(full, content, 'utf8');
    }
    return root;
  };

  test('flags an installed version that does not satisfy the declared range', async () => {
    const root = await scaffold({
      'package.json': JSON.stringify({
        name: 'app',
        dependencies: { 'acme-sdk': '^4.0.0' },
      }),
      'package-lock.json': JSON.stringify({
        name: 'app',
        lockfileVersion: 3,
        packages: { 'node_modules/acme-sdk': { version: '5.1.0' } },
      }),
      'src/index.js': "const acme = require('acme-sdk');\n",
    });

    try {
      const result = await auditCurrentUsage({ root, repo, config: offline, logger });
      const violation = result.findings.find((f) => f.kind === 'range-violation');

      assert.ok(violation, 'expected the 5.1.0 install under ^4.0.0 to be reported');
      assert.equal(violation.dependency, 'acme-sdk');
      assert.equal(violation.installedVersion, '5.1.0');
      assert.equal(violation.declaredRange, '^4.0.0');
      assert.equal(violation.sites.length, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('an exact pin has no unreviewed window and is not analysed', async () => {
    const root = await scaffold({
      'package.json': JSON.stringify({ name: 'app', dependencies: { 'acme-sdk': '4.2.0' } }),
      'src/index.js': "const acme = require('acme-sdk');\n",
    });

    try {
      const result = await auditCurrentUsage({ root, repo, config: offline, logger });
      assert.equal(result.findings.length, 0);
      assert.equal(result.analysed, 0, 'a pinned dependency has nothing to audit');
      assert.equal(result.checked, 1, 'but it was still examined, and the summary must say so');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('a repository with no manifest audits to an empty result rather than throwing', async () => {
    const root = await scaffold({ 'README.md': '# nothing here\n' });
    try {
      const result = await auditCurrentUsage({ root, repo, config: offline, logger });
      assert.deepEqual(result.findings, []);
      assert.equal(result.checked, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('dev dependencies are excluded unless asked for', async () => {
    const root = await scaffold({
      'package.json': JSON.stringify({
        name: 'app',
        devDependencies: { 'test-kit': '^1.0.0' },
      }),
      'package-lock.json': JSON.stringify({
        lockfileVersion: 3,
        packages: { 'node_modules/test-kit': { version: '9.9.9' } },
      }),
    });

    try {
      const runtimeOnly = await auditCurrentUsage({ root, repo, config: offline, logger });
      assert.equal(runtimeOnly.checked, 0);

      const withDev = await auditCurrentUsage({ root, repo, config: offline, logger, includeDev: true });
      assert.equal(withDev.checked, 1);
      assert.equal(
        withDev.findings.filter((f) => f.kind === 'range-violation').length,
        1,
        '9.9.9 does not satisfy ^1.0.0',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('audit summaries', () => {
  const emptyResult = (over: Partial<AuditResult> = {}): AuditResult => ({
    findings: [],
    checked: 0,
    analysed: 0,
    gaps: [],
    checkedSurfaces: [],
    ...over,
  });

  test('distinguishes "nothing to check" from "checked and clean"', () => {
    // These read identically in a naive summary and mean opposite things: one
    // is a clean bill of health, the other is a tool that never got to look.
    assert.match(summarizeAudit(emptyResult({ checked: 12, analysed: 0 })), /all pinned or unreadable/);
    assert.match(summarizeAudit(emptyResult({ checked: 12, analysed: 9 })), /Nothing in this repository is out of step/);
  });
});

describe('audit rendering', () => {
  const finding: LatentFinding = {
    id: 'latent_test',
    kind: 'unreviewed-drift',
    dependency: 'acme-sdk',
    ecosystem: 'npm',
    manifestPath: 'package.json',
    declaredRange: '^4.0.0',
    rangeFloor: '4.0.0',
    installedVersion: '4.9.0',
    breakingChange: {
      id: 'bc_1',
      dependency: 'acme-sdk',
      kind: 'removed-export',
      summary: '`createLegacyClient` was removed in 4.5.0.',
      remediation: 'Use `createClient` with the `legacy: true` option.',
      symbols: ['createLegacyClient'],
      confidence: 'high',
      citations: ['ev_1'],
    },
    sites: [
      {
        breakingChangeId: 'bc_1',
        file: 'src/api.ts',
        line: 12,
        excerpt: 'const client = createLegacyClient(options);',
        matchedSymbol: 'createLegacyClient',
        confidence: 'high',
      },
    ],
    summary: 'acme-sdk 4.9.0 is installed: `createLegacyClient` was removed in 4.5.0.',
  };

  const result: AuditResult = {
    findings: [finding],
    checked: 10,
    analysed: 4,
    gaps: [],
    checkedSurfaces: [],
  };

  test('renders nothing at all when there is nothing to report', () => {
    // An empty section would push a "we checked!" heading into every report,
    // which is exactly the noise that gets a report skimmed instead of read.
    assert.equal(renderAudit(undefined), '');
    assert.equal(renderAudit({ findings: [], checked: 3, analysed: 3, gaps: [], checkedSurfaces: [] }), '');
  });

  test('states the finding in the present tense, with the window that produced it', () => {
    const markdown = renderAudit(result);
    assert.match(markdown, /Already broken, before any upgrade/);
    assert.match(markdown, /installed 4\.9\.0/);
    assert.match(markdown, /anything from 4\.0\.0 up was permitted/);
    assert.match(markdown, /src\/api\.ts/);
    assert.match(markdown, /Use `createClient`/);
    // The claim that must survive every future edit to this renderer.
    assert.match(markdown, /Upgrading will not fix them/);
  });

  test('says how much of the project was eligible to produce a finding', () => {
    assert.match(renderAudit(result), /Audited 4 of 10 direct dependencies/);
  });

  test('the headline counts places, not packages', () => {
    assert.equal(auditHeadline(undefined), null);
    assert.match(auditHeadline(result)!, /1 place in this repository already conflicts/);
  });
});

/**
 * Type-parameter renames are not signature changes.
 *
 * Lives here because the audit is what made this matter: `analyze` sees one
 * dependency move at a time, so a library-wide type-parameter rename produced
 * a handful of odd findings nobody chased. The audit checks every dependency
 * on every run, and the same rename buried its report — in the present tense,
 * pointing at working code.
 */
describe('alpha equivalence of declarations', () => {
  test('a renamed type parameter is not a change', () => {
    // zod 3.24 -> 3.25, verbatim. Every generic export it has read as broken.
    assert.equal(
      alphaEquivalent(
        'declare const optional: <T extends ZodTypeAny>(type: T, params?: RawCreateParams) => ZodOptional<T>;',
        'declare const optional: <Inner extends ZodTypeAny>(type: Inner, params?: RawCreateParams) => ZodOptional<Inner>;',
      ),
      true,
    );
  });

  test('a changed constraint is still a change', () => {
    assert.equal(
      alphaEquivalent(
        'declare const f: <T extends string>(value: T) => T;',
        'declare const f: <U extends number>(value: U) => U;',
      ),
      false,
    );
  });

  test('a changed parameter list is still a change', () => {
    assert.equal(
      alphaEquivalent(
        'declare const f: <T>(value: T) => T;',
        'declare const f: <T>(value: T, options: Options) => T;',
      ),
      false,
    );
  });

  test('a use of a generic type is never mistaken for a declaration', () => {
    // No type parameters are *declared* here, so there is nothing to rename and
    // the two must be compared as the plain, different signatures they are.
    assert.equal(
      alphaEquivalent('declare const a: Promise<Foo>;', 'declare const a: Promise<Bar>;'),
      false,
    );
  });

  test('identical signatures are equivalent whether or not they are generic', () => {
    assert.equal(alphaEquivalent('declare const a: string;', 'declare const a: string;'), true);
  });
});

describe('Hex ranges are pessimistic, not tilde', () => {
  /**
   * `~>` is spelled the same in `mix.exs` and in a semver tilde range, and
   * means something different. Phoenix declares `{:ecto, "~> 3.0"}` and
   * resolves 3.14, which its manifest permits and node-semver's `~3.0` does
   * not — twenty-five findings on one repository, every one wrong.
   */
  test('a two-segment requirement runs to the next major', () => {
    assert.equal(satisfiesRange('4.1.3', '~> 4.0', 'hex'), true);
    assert.equal(satisfiesRange('3.14.0', '~> 3.0', 'hex'), true);
    assert.equal(satisfiesRange('5.0.0', '~> 4.0', 'hex'), false);
  });

  test('a three-segment requirement runs to the next minor', () => {
    assert.equal(satisfiesRange('2.1.5', '~> 2.1.3', 'hex'), true);
    assert.equal(satisfiesRange('2.2.0', '~> 2.1.3', 'hex'), false);
  });

  test('`and` joins requirements the way spaces do in npm', () => {
    assert.equal(satisfiesRange('1.5.0', '~> 1.4 and < 2.0', 'hex'), true);
    assert.equal(satisfiesRange('2.1.0', '~> 1.4 and < 2.0', 'hex'), false);
  });

  test('the floor is the version written, not the one semver would infer', () => {
    assert.equal(rangeFloor('~> 3.13', 'hex'), '3.13.0');
    assert.equal(rangeFloor('~> 1.0', 'hex'), '1.0.0');
  });
});
