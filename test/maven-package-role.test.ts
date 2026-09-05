import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyMavenPackaging,
  diffPomContracts,
  javaSurface,
  parsePomContract,
} from '../dist/evidence/surface/java.js';
import { setHelperArtifactOverride } from '../dist/evidence/surface/helper-artifact.js';
import { clearHttpCache } from '../dist/util/http.js';
import { createLogger } from '../dist/util/logger.js';
import { remediationForFinding } from '../dist/analyze/rules.js';

const realFetch = globalThis.fetch;
const logger = createLogger('error');
setHelperArtifactOverride('japicmp', '/dev/null');

const pom = (body: string) => `<?xml version="1.0"?><project>${body}</project>`;

/**
 * A minimal zip with only a central directory — enough for `readZip` to
 * report the entry paths `hasClassfiles` inspects, without needing valid
 * local headers or compressed bodies nothing here ever reads.
 */
function fakeJar(paths: string[]): Buffer {
  const central: Buffer[] = [];
  for (const path of paths) {
    const name = Buffer.from(path, 'utf8');
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(name.length, 28);
    central.push(header, name);
  }
  const centralDirectory = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(paths.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12); // central directory size
  eocd.writeUInt32LE(0, 16); // central directory starts at byte 0 of this buffer
  return Buffer.concat([centralDirectory, eocd]);
}

function changeRequest(exec: (...args: never[]) => Promise<never>) {
  return {
    name: 'org.springframework.boot:spring-boot-starter-parent',
    from: '2.7.0',
    to: '3.0.0',
    exec,
    workdir: '/tmp/drift-maven-role-test',
    logger,
    timeoutMs: 10_000,
  };
}

function servePoms(before: string, after: string): string[] {
  const calls: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/2.7.0/spring-boot-starter-parent-2.7.0.pom')) return new Response(before);
    if (url.endsWith('/3.0.0/spring-boot-starter-parent-3.0.0.pom')) return new Response(after);
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return calls;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  clearHttpCache();
});

describe('Maven artifact roles', () => {
  test('missing packaging defaults to a library jar and bundle is library-compatible', () => {
    assert.equal(parsePomContract(pom('<artifactId>demo</artifactId>')).packaging, 'jar');
    assert.equal(classifyMavenPackaging(undefined), 'library');
    assert.equal(classifyMavenPackaging('jar'), 'library');
    assert.equal(classifyMavenPackaging('bundle'), 'library');
    assert.equal(classifyMavenPackaging('pom'), 'pom');
    assert.equal(classifyMavenPackaging('maven-plugin'), 'maven-plugin');
    assert.equal(classifyMavenPackaging('war'), 'unsupported');
  });

  test('parent POM contracts compare managed properties, dependencies, exclusions, and plugins', () => {
    const before = parsePomContract(pom(`
      <packaging>pom</packaging>
      <parent><groupId>org.example</groupId><artifactId>base</artifactId><version>1</version></parent>
      <properties><java.version>17</java.version></properties>
      <dependencyManagement><dependencies><dependency>
        <groupId>org.example</groupId><artifactId>core</artifactId><version>1.0</version>
        <exclusions><exclusion><groupId>bad</groupId><artifactId>legacy</artifactId></exclusion></exclusions>
      </dependency></dependencies></dependencyManagement>
      <build><pluginManagement><plugins><plugin><artifactId>maven-compiler-plugin</artifactId><version>3.10</version></plugin></plugins></pluginManagement></build>
    `));
    const after = parsePomContract(pom(`
      <packaging>pom</packaging>
      <parent><groupId>org.example</groupId><artifactId>base</artifactId><version>2</version></parent>
      <properties><java.version>21</java.version></properties>
      <dependencyManagement><dependencies><dependency>
        <groupId>org.example</groupId><artifactId>core</artifactId><version>2.0</version>
      </dependency></dependencies></dependencyManagement>
      <build><pluginManagement><plugins><plugin><artifactId>maven-compiler-plugin</artifactId><version>3.12</version></plugin></plugins></pluginManagement></build>
    `));
    const changes = diffPomContracts(before, after);
    assert.ok(changes.some((change) => change.symbol === 'pom:parent'));
    assert.ok(changes.some((change) => change.symbol === 'pom:property:java.version'));
    assert.ok(changes.some((change) => change.symbol === 'pom:dependencyManagement:org.example:core'));
    assert.ok(changes.some((change) => change.symbol === 'pom:pluginManagement:org.apache.maven.plugins:maven-compiler-plugin'));
    assert.ok(changes.every((change) => /POM|Maven artifact role|Maven parent/.test(change.detail)));
    assert.match(
      remediationForFinding({ code: 'signature-changed', symbol: 'pom:parent', detail: 'changed' }, 'parent'),
      /Maven POM contract.*not an ordinary call-site signature change/,
    );
  });

  test('a Spring Boot parent POM never asks for Java, japicmp, or a jar', async () => {
    const calls = servePoms(
      pom('<packaging>pom</packaging><properties><java.version>17</java.version></properties>'),
      pom('<packaging>pom</packaging><properties><java.version>21</java.version></properties>'),
    );
    let execCalls = 0;
    const outcome = await javaSurface.compute(changeRequest((async () => {
      execCalls += 1;
      throw new Error('must not execute');
    }) as never));
    assert.equal(outcome.available, true);
    if (!outcome.available) return;
    assert.match(outcome.locator, /POM contract; pom → pom/);
    assert.ok(outcome.changes.some((change) => change.symbol === 'pom:property:java.version'));
    assert.equal(execCalls, 0);
    assert.equal(calls.some((url) => url.endsWith('.jar')), false);
  });

  test('known non-library packaging is explicit unsupported role evidence', async () => {
    servePoms(pom('<packaging>maven-plugin</packaging>'), pom('<packaging>maven-plugin</packaging>'));
    const outcome = await javaSurface.compute(changeRequest((async () => {
      throw new Error('must not execute');
    }) as never));
    assert.equal(outcome.available, false);
    if (outcome.available) return;
    assert.equal(outcome.reason, 'artifact-type-unsupported');
    assert.match(outcome.detail, /packaged as maven-plugin, not as a Java library jar/);
  });

  test('a starter/aggregator jar with no classfiles of its own is inconclusive, not a clean diff', async () => {
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.endsWith('.pom')) return new Response(pom('<artifactId>spring-boot-starter</artifactId>'));
      // Real starters ship only META-INF/ resources — no `.class` entries.
      return new Response(fakeJar(['META-INF/MANIFEST.MF', 'META-INF/LICENSE.txt']), { status: 200 });
    }) as typeof fetch;

    let execCalled = false;
    const outcome = await javaSurface.compute(changeRequest((async (command, args) => {
      execCalled = true;
      if (command === 'java' && args[0] === '-version') return { code: 0, stdout: '', stderr: 'openjdk 21' };
      throw new Error('japicmp must not run against a classfile-less jar');
    }) as never));

    assert.equal(outcome.available, false);
    if (outcome.available) return;
    assert.equal(outcome.reason, 'artifact-type-unsupported');
    assert.match(outcome.detail, /ships no classfiles of its own/);
    assert.equal(execCalled, true, 'java -version still runs before the classfile check');
  });

  test('a library jar with real classfiles still runs japicmp', async () => {
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.endsWith('.pom')) return new Response(pom('<artifactId>demo</artifactId>'));
      return new Response(fakeJar(['com/example/Client.class']), { status: 200 });
    }) as typeof fetch;

    let japicmpRan = false;
    const outcome = await javaSurface.compute(changeRequest((async (command, args) => {
      if (command === 'java' && args[0] === '-version') return { code: 0, stdout: '', stderr: 'openjdk 21' };
      if (command === 'java' && args[0] === '-jar') {
        japicmpRan = true;
        return { code: 0, stdout: '***! MODIFIED CLASS: PUBLIC com.example.Client\n', stderr: '' };
      }
      throw new Error('unexpected exec');
    }) as never));

    assert.equal(japicmpRan, true);
    assert.equal(outcome.available, true);
  });

  test('ordinary jar packaging still enters the existing Java tool path', async () => {
    servePoms(pom('<artifactId>demo</artifactId>'), pom('<packaging>bundle</packaging>'));
    const outcome = await javaSurface.compute(changeRequest((async () => ({
      code: 1,
      stdout: '',
      stderr: 'java not found',
      failure: 'not-found',
    })) as never));
    assert.equal(outcome.available, false);
    if (outcome.available) return;
    assert.equal(outcome.reason, 'tool-missing');
    assert.doesNotMatch(outcome.detail, /no jar/i);
  });
});

/**
 * Maven Central is the default, not the only place Java is published.
 *
 * A POM declares `<repositories>`, and Maven reads them; Drift did not, so an
 * artifact hosted anywhere else was reported `version-unavailable` — which
 * reads as "that version was unpublished or yanked" when the truth is that
 * Drift looked in one place. Every `org.jenkins-ci.*` plugin lives at
 * `repo.jenkins-ci.org`, and that alone accounted for 41 of BUMP's Java
 * cases, a tenth of the corpus.
 *
 * Nothing here knows what Jenkins is: the URLs come from the POM that declared
 * the dependency, which is where Maven itself reads them.
 */
describe('repositories the project declares', () => {
  const JENKINS = 'https://repo.jenkins-ci.org/public';

  const pomWithRepo = (url: string) =>
    pom(`<repositories><repository><id>r</id><url>${url}/</url></repository></repositories>`);

  /** Serves POMs and jars only from `host`, 404ing every other origin. */
  function serveOnlyFrom(host: string, packaging: string, jarEntries: string[]) {
    const seen: string[] = [];
    globalThis.fetch = (async (input) => {
      const url = String(input);
      seen.push(url);
      if (!url.startsWith(host)) return new Response('not found', { status: 404 });
      if (url.endsWith('.pom')) return new Response(pom(`<packaging>${packaging}</packaging>`));
      if (url.endsWith('.jar')) return new Response(fakeJar(jarEntries), { status: 200 });
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    return { seen: () => seen };
  }

  test('an artifact only on a declared repository is found there', async () => {
    const stub = serveOnlyFrom(JENKINS, 'jar', ['com/example/Client.class']);
    const outcome = await javaSurface.compute({
      ...changeRequest((async (command, args) => {
        if (command === 'java' && args[0] === '-version') return { code: 0, stdout: '', stderr: 'openjdk 21' };
        return { code: 0, stdout: '***! MODIFIED CLASS: PUBLIC com.example.Client\n', stderr: '' };
      }) as never),
      manifestPath: 'plugin/pom.xml',
      readRepoFile: async (path: string) => (path === 'plugin/pom.xml' ? pomWithRepo(JENKINS) : null),
    });

    assert.equal(outcome.available, true, 'the declared repository answered');
    assert.ok(stub.seen().some((url) => url.startsWith('https://repo1.maven.org')), 'Central is still tried first');
    assert.ok(stub.seen().some((url) => url.startsWith(JENKINS)), 'and the declared repository after it');
  });

  test('a non-library packaging is compared through its companion jar', async () => {
    // A Jenkins plugin ships an `hpi`; the `.jar` beside it is what a consumer
    // compiles against, and it carries the real classes.
    serveOnlyFrom(JENKINS, 'hpi', ['com/example/Client.class']);
    const outcome = await javaSurface.compute({
      ...changeRequest((async (command, args) => {
        if (command === 'java' && args[0] === '-version') return { code: 0, stdout: '', stderr: 'openjdk 21' };
        return { code: 0, stdout: '***! MODIFIED CLASS: PUBLIC com.example.Client\n', stderr: '' };
      }) as never),
      manifestPath: 'plugin/pom.xml',
      readRepoFile: async () => pomWithRepo(JENKINS),
    });

    assert.equal(outcome.available, true, 'hpi is not a reason to decline when a jar exists');
  });

  test('a non-library packaging with no companion jar is still unsupported', async () => {
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.endsWith('.pom')) return new Response(pom('<packaging>maven-plugin</packaging>'));
      return new Response('not found', { status: 404 });
    }) as typeof fetch;

    const outcome = await javaSurface.compute(changeRequest((async () => {
      throw new Error('must not execute');
    }) as never));

    assert.equal(outcome.available, false);
    if (outcome.available) return;
    assert.equal(outcome.reason, 'artifact-type-unsupported');
    assert.match(outcome.detail, /publishes no companion jar/);
  });

  test('a plaintext repository is never fetched from', async () => {
    const stub = serveOnlyFrom(JENKINS, 'jar', ['com/example/Client.class']);
    await javaSurface.compute({
      ...changeRequest((async () => ({ code: 1, stdout: '', stderr: 'java not found' })) as never),
      manifestPath: 'pom.xml',
      readRepoFile: async () => pomWithRepo('http://insecure.example.invalid/repo'),
    });

    assert.ok(!stub.seen().some((url) => url.startsWith('http://')), 'http:// declared mirrors are skipped');
  });

  test('with no repositories declared, only Central is consulted', async () => {
    const stub = serveOnlyFrom('https://repo1.maven.org', 'jar', ['com/example/Client.class']);
    await javaSurface.compute({
      ...changeRequest((async (command, args) => {
        if (command === 'java' && args[0] === '-version') return { code: 0, stdout: '', stderr: 'openjdk 21' };
        return { code: 0, stdout: '', stderr: '' };
      }) as never),
      readRepoFile: async () => pom('<artifactId>demo</artifactId>'),
    });

    const origins = new Set(stub.seen().map((url) => new URL(url).origin));
    assert.deepEqual([...origins], ['https://repo1.maven.org']);
  });
});
