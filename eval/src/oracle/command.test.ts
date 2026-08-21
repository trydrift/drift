import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CommandParseError, parseCommand, tokenize } from './command.ts';

/**
 * The failure mode these guard against is silent. A command split on
 * whitespace does not throw — it runs the wrong process with the wrong argv,
 * exits non-zero, and the harness records that as a result about the code
 * under test. Every case below is a shape an external corpus actually states.
 */

test('an ordinary command is spawned without a shell', () => {
  const parsed = parseCommand('npx tsc --noEmit');
  assert.deepEqual(parsed, { kind: 'argv', program: 'npx', args: ['tsc', '--noEmit'], needsShell: false });
});

test('a quoted script argument stays one argv entry, and needs no shell', () => {
  // The parentheses are inside quotes, so they are data rather than operators
  // and no shell has to be involved to pass them through intact.
  const parsed = parseCommand('node -e "console.log(1)"');
  assert.deepEqual(parsed, { kind: 'argv', program: 'node', args: ['-e', 'console.log(1)'], needsShell: false });
});

test('a quoted argument with spaces and no shell operators stays one argv entry', () => {
  const parsed = parseCommand('mvn -Dtest="My Test" test');
  assert.deepEqual(parsed, { kind: 'argv', program: 'mvn', args: ['-Dtest=My Test', 'test'], needsShell: false });
});

test('single quotes are literal', () => {
  assert.deepEqual(tokenize(`echo 'a  b' c`), ['echo', 'a  b', 'c']);
});

test('a backslash outside quotes escapes the next character', () => {
  assert.deepEqual(tokenize('cmd a\\ b'), ['cmd', 'a b']);
});

test('backslash escapes inside double quotes follow shell rules', () => {
  assert.deepEqual(tokenize('cmd "a\\"b" "c\\d"'), ['cmd', 'a"b', 'c\\d']);
});

test('an empty quoted argument survives as an empty argument', () => {
  assert.deepEqual(tokenize(`cmd "" x`), ['cmd', '', 'x']);
});

test('a sequence needs a shell and is handed over whole', () => {
  const parsed = parseCommand('mvn -B clean && mvn -B test');
  assert.deepEqual(parsed, { kind: 'shell', command: 'mvn -B clean && mvn -B test', needsShell: true });
});

test('a pipe and a redirect need a shell', () => {
  assert.equal(parseCommand('npm test | tee build.log').kind, 'shell');
  assert.equal(parseCommand('npm test > build.log').kind, 'shell');
  assert.equal(parseCommand('npm test; npm run lint').kind, 'shell');
});

/**
 * The subtle one. An operator *inside quotes* is data the program receives,
 * not an operator — and detecting operators on raw text would send it to a
 * shell, where it would become one.
 */
test('an operator inside quotes does not select the shell path', () => {
  const parsed = parseCommand('grep --fixed-strings "a && b" src');
  assert.deepEqual(parsed, { kind: 'argv', program: 'grep', args: ['--fixed-strings', 'a && b', 'src'], needsShell: false });
});

test('an unterminated quote is refused rather than silently truncated', () => {
  assert.throws(() => parseCommand('node -e "unterminated'), CommandParseError);
});

test('a trailing backslash is refused', () => {
  assert.throws(() => parseCommand('cmd arg\\'), CommandParseError);
});

test('an empty command is refused', () => {
  assert.throws(() => parseCommand('   '), CommandParseError);
});
