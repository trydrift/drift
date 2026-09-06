import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseVerificationDiagnostics } from '../dist/verification/diagnostics.js';

/**
 * A failing test names its location in a stack frame, not in a `file:line:`
 * diagnostic — so a dependency upgrade that breaks behaviour rather than
 * compilation produced a confirmed regression with nowhere to point. These
 * pin the two things that make a frame usable: it is the *test's* frame and
 * not JUnit's, and the path it yields is marked inferred so a caller has to
 * resolve it before showing it to anyone.
 */

const SUREFIRE = [
  '[INFO] Running com.example.FooTest',
  '[ERROR] Tests run: 2, Failures: 1, Errors: 0, Skipped: 0',
  '[ERROR] testBar(com.example.FooTest)  Time elapsed: 0.01 s  <<< FAILURE!',
  'java.lang.AssertionError: expected:<2> but was:<3>',
  '\tat org.junit.Assert.fail(Assert.java:88)',
  '\tat com.example.FooTest.testBar(FooTest.java:42)',
  '\tat java.base/jdk.internal.reflect.NativeMethodAccessorImpl.invoke0(Native Method)',
].join('\n');

describe('reading a failing test out of Surefire output', () => {
  test('reports the test class frame and not the assertion library above it', () => {
    const diagnostics = parseVerificationDiagnostics(SUREFIRE);
    assert.deepEqual(diagnostics, [
      {
        file: 'com/example/FooTest.java',
        line: 42,
        message: 'java.lang.AssertionError: expected:<2> but was:<3>',
        severity: 'error',
        origin: 'stack-frame',
      },
    ]);
  });

  test('reads the JUnit 5 header layout, which puts the method last', () => {
    const output = [
      '[ERROR] com.example.other.BazTest.testQux  Time elapsed: 0.2 s  <<< ERROR!',
      'java.lang.NoSuchMethodError: org.apache.mina.Foo.bar()',
      '\tat com.example.other.BazTest.testQux(BazTest.java:7)',
    ].join('\n');
    const [only] = parseVerificationDiagnostics(output);
    assert.equal(only?.file, 'com/example/other/BazTest.java');
    assert.equal(only?.line, 7);
    assert.equal(only?.message, 'java.lang.NoSuchMethodError: org.apache.mina.Foo.bar()');
  });

  test('a nested class resolves to the file its outer class names', () => {
    const output = [
      '[ERROR] testInner(com.example.FooTest$Inner)  Time elapsed: 0.01 s  <<< FAILURE!',
      'java.lang.AssertionError',
      '\tat com.example.FooTest$Inner.testInner(FooTest.java:88)',
    ].join('\n');
    assert.equal(parseVerificationDiagnostics(output)[0]?.file, 'com/example/FooTest.java');
  });

  test('stack frames outside any reported failure are ignored', () => {
    // A trace printed by a passing test's logging, or by Maven itself, names
    // no failure and must not become an impact site.
    const output = ['\tat com.example.FooTest.helper(FooTest.java:12)', '[INFO] BUILD SUCCESS'].join('\n');
    assert.deepEqual(parseVerificationDiagnostics(output), []);
  });

  test('frames are capped so one recursive trace is not fifty sites', () => {
    const frames = Array.from(
      { length: 12 },
      (_, index) => `\tat com.example.FooTest.recurse(FooTest.java:${100 + index})`,
    );
    const output = [
      '[ERROR] testDeep(com.example.FooTest)  Time elapsed: 0.01 s  <<< ERROR!',
      'java.lang.StackOverflowError',
      ...frames,
    ].join('\n');
    assert.equal(parseVerificationDiagnostics(output).length, 3);
  });

  test('a compiler diagnostic still parses normally alongside test output', () => {
    // The javac path predates this and must be untouched by it: no `origin`,
    // and the path the tool actually printed.
    const output = [
      '[ERROR] /work/src/main/java/com/example/App.java:[13,5] cannot find symbol',
      '[ERROR] testBar(com.example.FooTest)  Time elapsed: 0.01 s  <<< FAILURE!',
      'java.lang.AssertionError',
      '\tat com.example.FooTest.testBar(FooTest.java:42)',
    ].join('\n');
    const diagnostics = parseVerificationDiagnostics(output, '/work');
    assert.equal(diagnostics.length, 2);
    assert.deepEqual(diagnostics[0], {
      file: 'src/main/java/com/example/App.java',
      line: 13,
      column: 4,
      message: 'cannot find symbol',
      severity: 'error',
    });
    assert.equal(diagnostics[1]?.origin, 'stack-frame');
  });
});
