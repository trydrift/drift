import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseReviewOutput } from './review-runner.ts';
import { reviewerInstruction } from './packet.ts';

test('takes the final YAML block, because a model that revises itself puts the answer last', () => {
  const transcript = [
    'Let me look at the packet first.',
    '```yaml',
    'conclusion:',
    '  upstreamFindings: ["lib:a:removed-export"]',
    '```',
    'Actually the function bodies are identical, so this is a rename.',
    '```yaml',
    'conclusion:',
    '  upstreamFindings: ["lib:a:renamed-export"]',
    '```',
  ].join('\n');
  const parsed = parseReviewOutput(transcript) as { conclusion: { upstreamFindings: string[] } };
  assert.deepEqual(parsed.conclusion.upstreamFindings, ['lib:a:renamed-export']);
});

test('a fenced block that is not the answer is skipped rather than failing the parse', () => {
  const transcript = ['```js', "import { a } from 'lib';", '```', '```yaml', 'conclusion:', '  impactSites: []', '```'].join('\n');
  assert.ok(parseReviewOutput(transcript));
});

test('a transcript with no conclusion yields null rather than an empty review', () => {
  assert.equal(parseReviewOutput('I could not determine the answer.'), null);
  assert.equal(parseReviewOutput('```yaml\nnotes: nothing\n```'), null);
});

test('the reviewer instruction forbids answering from prior knowledge and permits uncertainty', () => {
  const instruction = reviewerInstruction('reviewer');
  assert.match(instruction, /Do not use anything you know about this package from elsewhere/);
  assert.match(instruction, /`uncertain` is a correct answer/);
  assert.match(instruction, /Never guess a replacement symbol/);
  assert.doesNotMatch(instruction, /drift/i, 'a reviewer is never told which tool is being evaluated');
});

test('the adjudicator is told not to manufacture consensus', () => {
  const instruction = reviewerInstruction('adjudicator');
  assert.match(instruction, /Do not manufacture consensus/);
  assert.match(instruction, /have NOT been shown any tool output/);
});
