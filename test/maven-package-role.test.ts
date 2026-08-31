import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyMavenPackaging,
  diffPomContracts,
  javaSurface,
  parsePomContract,
} from '../dist/evidence/surface/java.js';
import { clearHttpCache } from '../dist/util/http.js';
import { createLogger } from '../dist/util/logger.js';

const realFetch = globalThis.fetch;
const logger = createLogger('error');

const pom = (body: string) => `<?xml version="1.0"?><project>${body}</project>`;

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
