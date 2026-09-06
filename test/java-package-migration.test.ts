import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseJapicmp } from '../dist/evidence/surface/java.js';
import {
  detectPackageMigrations,
  parseMemberSignature,
  splitParameters,
} from '../dist/evidence/surface/java-migration.js';

/**
 * A package migration is the one breaking change whose localization anchor is
 * a symbol the changed library does not own. Spring 6 removes every method
 * taking a `javax.servlet` type and adds the `jakarta.servlet` equivalent; the
 * consumer's build fails on its own `import javax.servlet.http.HttpServletRequest;`,
 * a line that names nothing in `org.springframework`. These tests pin both
 * directions: the migration is found, and a diff that merely changes types is
 * never mistaken for one.
 */

const MIGRATION_REPORT = `Comparing binary compatibility of new.jar against old.jar
***! MODIFIED CLASS: PUBLIC org.springframework.web.servlet.HandlerInterceptor
\t---! REMOVED METHOD: PUBLIC(-) boolean preHandle(javax.servlet.http.HttpServletRequest, javax.servlet.http.HttpServletResponse, java.lang.Object)
\t+++  NEW METHOD: PUBLIC(+) boolean preHandle(jakarta.servlet.http.HttpServletRequest, jakarta.servlet.http.HttpServletResponse, java.lang.Object)
\t---! REMOVED METHOD: PUBLIC(-) void postHandle(javax.servlet.http.HttpServletRequest, java.lang.Object)
\t+++  NEW METHOD: PUBLIC(+) void postHandle(jakarta.servlet.http.HttpServletRequest, java.lang.Object)
`;

describe('detecting a package migration in a japicmp report', () => {
  test('reports the old fully-qualified name, which is what a consumer imports', () => {
    const changes = parseJapicmp(MIGRATION_REPORT);
    const migrated = changes.filter((change) => change.before !== undefined && change.before !== change.after);

    assert.deepEqual(
      migrated.map((change) => change.symbol).sort(),
      ['javax.servlet.http.HttpServletRequest', 'javax.servlet.http.HttpServletResponse'],
    );
    const request = migrated.find((c) => c.symbol === 'javax.servlet.http.HttpServletRequest')!;
    assert.equal(request.kind, 'export-removed');
    assert.equal(request.after, 'jakarta.servlet.http.HttpServletRequest');
    // The remediation a reader needs is the replacement import, not the
    // Spring class whose signature happened to reveal the move.
    assert.match(request.detail, /import `jakarta\.servlet\.http\.HttpServletRequest` instead/);
  });

  test('one witness is not a migration', () => {
    // A single method changing a parameter's package is far likelier to be an
    // ordinary type swap than a namespace move, and the false direction is the
    // expensive one — see `MIGRATION_MIN_WITNESSES`.
    const single = `Comparing binary compatibility of new.jar against old.jar
***! MODIFIED CLASS: PUBLIC com.example.Service
\t---! REMOVED METHOD: PUBLIC(-) void run(com.example.old.Task)
\t+++  NEW METHOD: PUBLIC(+) void run(com.example.next.Task)
`;
    assert.deepEqual(
      parseJapicmp(single).filter((change) => change.before !== undefined),
      [],
    );
  });

  test('a differently-named replacement type is not a migration', () => {
    const replaced = `Comparing binary compatibility of new.jar against old.jar
***! MODIFIED CLASS: PUBLIC com.example.Service
\t---! REMOVED METHOD: PUBLIC(-) void a(com.example.old.Task)
\t+++  NEW METHOD: PUBLIC(+) void a(com.example.next.Job)
\t---! REMOVED METHOD: PUBLIC(-) void b(com.example.old.Task)
\t+++  NEW METHOD: PUBLIC(+) void b(com.example.next.Job)
`;
    assert.deepEqual(
      parseJapicmp(replaced).filter((change) => change.before !== undefined),
      [],
    );
  });

  test('a migration japicmp never called binary-incompatible is not reported', () => {
    // The parser reports only `!`-flagged changes, and a migration inferred
    // from unflagged lines alone would quietly break that rule.
    const unflagged = MIGRATION_REPORT.replace(/---!/g, '--- ');
    assert.deepEqual(
      parseJapicmp(unflagged).filter((change) => change.before !== undefined),
      [],
    );
  });

  test('arity and owner must match before signatures are compared', () => {
    const removed = [
      { owner: 'A', name: 'run', params: ['javax.a.T'], returns: null, binaryBreaking: true },
      { owner: 'A', name: 'run', params: ['javax.a.T', 'int'], returns: null, binaryBreaking: true },
    ];
    // Same simple name, but the only candidate differs in arity and owner.
    const added = [
      { owner: 'B', name: 'run', params: ['jakarta.a.T'], returns: null, binaryBreaking: false },
      { owner: 'A', name: 'run', params: ['jakarta.a.T', 'int', 'int'], returns: null, binaryBreaking: false },
    ];
    assert.deepEqual(detectPackageMigrations(removed, added), []);
  });

  test('a moved return type counts as a witness', () => {
    const removed = [
      { owner: 'A', name: 'one', params: [], returns: 'javax.a.T', binaryBreaking: true },
      { owner: 'A', name: 'two', params: [], returns: 'javax.a.T', binaryBreaking: true },
    ];
    const added = [
      { owner: 'A', name: 'one', params: [], returns: 'jakarta.a.T', binaryBreaking: false },
      { owner: 'A', name: 'two', params: [], returns: 'jakarta.a.T', binaryBreaking: false },
    ];
    assert.deepEqual(detectPackageMigrations(removed, added), [
      { fromPackage: 'javax.a', toPackage: 'jakarta.a', types: [{ from: 'javax.a.T', to: 'jakarta.a.T' }] },
    ]);
  });
});

describe('reading a japicmp member signature', () => {
  test('erases generics and arrays, which a classfile does not distinguish', () => {
    assert.deepEqual(splitParameters('java.util.List<java.lang.String>, int[], java.util.Map<A, B>'), [
      'java.util.List',
      'int',
      'java.util.Map',
    ]);
  });

  test('separates the return type from the member name', () => {
    const signature = parseMemberSignature(
      'PROTECTED(-) javax.servlet.http.HttpServletRequest checkMultipart(javax.servlet.http.HttpServletRequest)',
      'Owner',
      true,
    );
    assert.deepEqual(signature, {
      owner: 'Owner',
      name: 'checkMultipart',
      params: ['javax.servlet.http.HttpServletRequest'],
      returns: 'javax.servlet.http.HttpServletRequest',
      binaryBreaking: true,
    });
  });

  test('a constructor has no return type', () => {
    const signature = parseMemberSignature('PUBLIC(-) Owner(java.lang.String)', 'Owner', true);
    assert.equal(signature?.returns, null);
    assert.equal(signature?.name, 'Owner');
  });

  test('a line with no parameter list is not a signature', () => {
    assert.equal(parseMemberSignature('PUBLIC static final int MAX', 'Owner', true), null);
  });
});
