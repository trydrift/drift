import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  crossesMajor,
  linkifyPaths,
  renderBody,
  renderMarkdown,
  renderPanel,
  SLASH_COMMANDS,
  type ViewModel,
} from '../src/ui/webview.js';
import { warmCodeHighlighter } from '../src/ui/highlight.js';
import type { TaskGroup } from '../src/session.js';
import { describeSeverity, severityOf } from '../src/severity.js';
import type { UpgradeCandidate } from '../src/upgrades.js';
import type { RemediationPlan } from '../../src/types.js';

/**
 * The panel is the product, and it is a large amount of generated markup. It is
 * a pure function of a view model and imports no `vscode`, specifically so that
 * it can be rendered here — an unrenderable panel that typechecks is still a
 * broken extension.
 *
 * The assertions that matter are about *framing* as much as structure: the panel
 * must not shout about breaking changes that do not affect the repository, and it
 * must never inline unescaped content from a changelog.
 */

/** Strips <style>...</style> blocks, re-applying until stable so a crafted overlap can't survive one pass. */
function stripStyleBlocks(html: string): string {
  let stripped = html;
  let previous: string;
  do {
    previous = stripped;
    stripped = stripped.replace(/<style[\s\S]*?<\/style>/gi, '');
  } while (stripped !== previous);
  return stripped;
}

function candidate(over: Partial<UpgradeCandidate> = {}): UpgradeCandidate {
  return {
    id: 'lodash@4.17.21->5.0.0',
    name: 'lodash',
    kind: 'runtime',
    ecosystem: 'npm',
    packageManager: 'npm',
    manifestPath: 'package.json',
    current: '4.17.21',
    range: '^4.17.0',
    safeLatest: '4.17.23',
    selected: '5.0.0',
    latest: '5.0.0',
    versions: ['5.0.0', '4.17.23'],
    status: 'ready',
    evidenceCount: 3,
    breakingCount: 7,
    impactCount: 0,
    impactFiles: 0,
    impactConfidence: 'high',
    risk: 'none',
    gaps: [],
    toolRequests: [],
    summary: '7 breaking changes in lodash, but this repository does not use any of the affected APIs.',
    ...over,
  };
}

function plan(over: Partial<RemediationPlan> = {}): RemediationPlan {
  return {
    schemaVersion: 3,
    gaps: [],
    checkedSurfaces: [],
    id: 'p1',
    branchName: 'drift/upgrade-phaser',
    baseBranch: 'main',
    headSha: 'abc',
    changes: [
      { name: 'phaser', ecosystem: 'npm', from: '3.90.0', to: '4.0.0', kind: 'runtime', bump: 'major', manifestPath: 'package.json' },
    ],
    evidence: [],
    breakingChanges: [],
    impactSites: [],
    commits: [],
    planEdges: [],
    upgradeCohorts: [],
    risk: 'none',
    blockers: [],
    warnings: [],
    createdAt: '2026-08-02T00:00:00Z',
    ...over,
  };
}

function model(over: Partial<ViewModel> = {}): ViewModel {
  return {
    nonce: 'abc123',
    repoLabel: 'acme/app',
    signedInLabel: null,
    agents: [{ id: 'copilot-lm', label: 'GitHub Copilot', available: true }],
    agentId: 'auto',
    agentLabel: 'GitHub Copilot',
    mode: 'agent',
    effortLabel: 'Medium',
    modelLabel: 'Claude Opus',
    permission: 'auto-edit',
    branchMode: 'new',
    commitMode: 'approve',
    scopeLabel: null,
    attachments: [],
    thread: [],
    candidates: {},
    review: null,
    busy: false,
    cancellable: true,
    stopping: false,
    awaitingAnswer: false,
    commands: SLASH_COMMANDS,
    menu: [
      {
        id: 'context',
        anchor: 'context',
        title: 'Context',
        items: [{ id: 'context:file', label: 'Add a file…', detail: 'Search this project by path', icon: 'file' }],
      },
      {
        id: 'model:claude',
        anchor: 'model:claude',
        title: 'Claude Code',
        items: [
          { id: 'model:claude:opus', label: 'Claude Opus', checked: true },
          { id: 'model:claude:sonnet', label: 'Claude Sonnet' },
        ],
      },
      {
        id: 'effort',
        anchor: 'effort',
        title: 'Claude Code effort',
        items: [],
        slider: {
          id: 'effort',
          value: 1,
          stops: [
            { value: 'low', label: 'Low', detail: 'Edits directly, without extended thinking' },
            { value: 'medium', label: 'Medium', detail: 'Thinks through each change before making it' },
            { value: 'high', label: 'High', detail: 'Thinks harder on each change' },
            { value: 'xhigh', label: 'Ultracode', detail: 'The deepest reasoning Claude Code offers' },
          ],
        },
      },
      {
        id: 'tools',
        anchor: 'tools',
        title: 'Tools',
        items: [
          { id: 'tool:/scan', label: 'Scan dependencies', detail: 'Check every dependency', hint: '/scan', icon: 'search' },
        ],
      },
      {
        id: 'permission',
        anchor: 'permission',
        title: 'Permission',
        items: [{ id: 'permission:auto-edit', label: 'Edit, then review', checked: true }],
      },
    ],
    stale: null,
    draft: '',
    draftToken: 0,
    conversationId: 'c1',
    ...over,
  };
}

test('an empty session renders the welcome state and a composer', () => {
  const html = renderPanel(model());

  assert.match(html, /<!DOCTYPE html>/);
  assert.match(html, /class="welcome /);
  assert.match(html, /class="composer/);
  assert.match(html, /data-command="\/scan"/);
  assert.match(html, /data-action="openMenu" data-anchor="context"/);
  assert.match(html, /id="menu-filter"/);
});

test('the stop button becomes a centered spinner while stopping', () => {
  const html = renderBody(model({ busy: true, cancellable: true, stopping: true }));

  assert.match(html, /class="stop stopping"[^>]*disabled/);
  assert.match(html, /aria-label="Stopping"/);
  assert.doesNotMatch(html, /data-action="stop"[^>]*>[\s\S]*?<svg/);
});

test('the tools menu can lead with recent conversations', () => {
  const html = renderBody(
    model({
      menu: [
        {
          id: 'recent-conversations',
          anchor: 'tools',
          title: 'Recent conversations',
          items: [
            {
              id: 'history:c1',
              label: 'Scan — 2 affect this repo',
              detail: 'just now · 4 messages',
              hint: 'Active',
              icon: 'history',
              checked: true,
            },
          ],
        },
        {
          id: 'tools',
          anchor: 'tools',
          title: 'Tools',
          items: [{ id: 'tool:/scan', label: 'Scan dependencies', detail: 'Check every dependency', hint: '/scan' }],
        },
      ],
    }),
  );

  assert.ok(html.indexOf('Recent conversations') < html.indexOf('Scan dependencies'));
  assert.match(html, /data-action="menu" data-id="history:c1"/);
  assert.match(html, />Active</);
});

test('a busy package verdict cannot steal width from the package identity column', () => {
  const html = renderPanel(
    model({
      thread: [{ id: 'p1', kind: 'packages', headline: 'Testing upgrades.', ids: [candidate().id] }],
      candidates: {
        [candidate().id]: candidate({
          status: 'checking',
          phase: 'Testing 12 upgrades together against the full workspace typecheck and build suite',
        }),
      },
    }),
  );

  assert.match(html, /grid-template-columns: auto minmax\(min\(15ch, 100%\), 1fr\) minmax\(0, clamp\(88px, 36%, 170px\)\)/);
  assert.match(html, /\.verdict \{[\s\S]*?justify-self: end;[\s\S]*?overflow: hidden;/);
  assert.match(html, /\.verdict\.pending, \.verdict\.busy \{[\s\S]*?overflow-wrap: anywhere;/);
});

const modelMenu = [
  { id: 'context', anchor: 'context', title: 'Context', items: [{ id: 'context:file', label: 'Add a file…' }] },
  {
    id: 'model',
    anchor: 'model',
    title: 'Model',
    items: [{ id: 'agent:claude', label: 'Claude Code', detail: 'Opus', submenu: 'model:claude', checked: true }],
  },
  {
    id: 'model:claude',
    anchor: 'model:claude',
    title: 'Claude Code',
    items: [
      { id: 'back', label: 'All subscriptions', submenu: 'model', icon: 'back' as const },
      { id: 'model:claude:sonnet', label: 'Claude Sonnet' },
    ],
  },
];

test('the model is its own control, named for what is selected', () => {
  // It used to live under the plus, whose label named neither context nor
  // model. The setting that most changes the result was the one a developer
  // had to already know was hidden.
  const html = renderPanel(model({ modelLabel: 'GPT-5.5', menu: modelMenu }));

  const bar = html.slice(html.indexOf('composer-bar'));
  assert.match(bar, /data-anchor="model"[^>]*>[\s\S]*?GPT-5\.5/);
  // Order in the row: context, then model, then tools.
  assert.ok(
    bar.indexOf('data-anchor="context"') < bar.indexOf('data-anchor="model"'),
    'the model button sits after the plus',
  );
  assert.ok(
    bar.indexOf('data-anchor="model"') < bar.indexOf('data-anchor="tools"'),
    'the model button sits before Tools',
  );
  // The plus no longer claims to hold the model.
  assert.doesNotMatch(bar, /aria-label="Context and model"/);
});

test('with no agent installed the model button offers to set one up', () => {
  const html = renderPanel(model({ modelLabel: null, menu: modelMenu }));
  assert.match(html.slice(html.indexOf('composer-bar')), /data-anchor="model:setup"[^>]*>[\s\S]*?Choose agent/);
});

test('a subscription drills in to its own models, and back out again', () => {
  // A subscription is not a model. Someone paying for Claude has Opus, Sonnet
  // and Haiku, so picking a subscription is the first of two steps and opens
  // that subscription's own models — a drill-in inside the same menu, which
  // costs nothing because it never leaves the webview.
  const html = renderPanel(model({ menu: modelMenu }));

  assert.match(html, /data-section="context" data-anchor="context"/);
  assert.match(html, /data-section="model" data-anchor="model"/);
  // The subscription row opens its own section rather than acting.
  assert.match(html, /data-action="openMenu" data-anchor="model:claude"[^>]*data-search="[^"]*claude/i);
  assert.match(html, /data-section="model:claude" data-anchor="model:claude"/);
  assert.match(html, /data-action="menu" data-id="model:claude:sonnet"/);
  // And a way back out of the drill-in.
  assert.match(html, /data-action="openMenu" data-anchor="model"[^>]*>[\s\S]*?All subscriptions/);
});

test('the row that goes back does not also point forward', () => {
  // "All subscriptions" drew a left arrow and a right arrow at once, each
  // claiming a different destination for the same click.
  const html = renderPanel(model({ menu: modelMenu }));

  const back = html.slice(html.indexOf('All subscriptions'));
  const row = back.slice(0, back.indexOf('</button>'));
  assert.doesNotMatch(row, /menu-more/);
  // A row that genuinely drills in keeps its chevron.
  assert.match(html.slice(0, html.indexOf('All subscriptions')), /menu-more/);
});

test('the control row never wraps and the composer stays at the bottom', () => {
  // #root replaced the body as the flex column when rendering became a body
  // swap; without that the thread stops filling the panel and the composer
  // floats up under the last message.
  const html = renderPanel(model());

  assert.match(html, /#root\s*\{[^}]*flex:\s*1 1 auto[^}]*\}/);
  assert.match(html, /\.composer-bar\s*\{[^}]*flex-wrap:\s*nowrap/);
});

test('a slash command is one row, not two', () => {
  const html = renderPanel(model());
  assert.match(html, /button\.command\s*\{[^}]*white-space:\s*nowrap/);
});

test('effort is a dial, in the words the agent itself uses', () => {
  const html = renderPanel(model());

  assert.match(html, /data-action="openMenu" data-anchor="effort"/);
  assert.match(html, /<input\b[^>]*type="range"[^>]*data-action="slider"/);
  assert.match(html, /data-values="low,medium,high,xhigh"/);
  // Anthropic's name for its top stop, not a house word invented here.
  assert.match(html, /Ultracode/);
  // The label under the handle says what a position does to the model.
  assert.match(html, /class="slider-detail"[^>]*>Thinks through each change before making it</);
  // And it is about thinking, never about looking at fewer packages.
  assert.ok(!/dependencies only/.test(html), 'effort must not describe itself as narrowing the scan');
});

test('an agent with no reasoning budget gets no dial at all', () => {
  // Drawing a control that does nothing is worse than drawing none: it invites
  // the developer to change a setting the backend will ignore.
  const html = renderPanel(model({ effortLabel: null }));
  assert.ok(!/data-action="openMenu" data-anchor="effort"/.test(html), 'no effort button');
});

test('one open repository gets no scope button', () => {
  // The same "no control that does nothing" rule the effort dial follows —
  // with one folder open there is nothing to disambiguate.
  const html = renderPanel(model({ scopeLabel: null }));
  assert.ok(!/data-action="openMenu" data-anchor="scope"/.test(html), 'no scope button');
});

test('more than one open repository gets a labelled scope button', () => {
  const html = renderPanel(model({ scopeLabel: '2 repositories' }));
  assert.match(html, /data-action="openMenu" data-anchor="scope"/);
  assert.match(html, />2 repositories</);
});

test('Tools is a menu of everything Drift can do', () => {
  const html = renderPanel(model());

  assert.match(html, /data-action="openMenu" data-anchor="tools"/);
  assert.match(html, /data-section="tools" data-anchor="tools"/);
  assert.match(html, /data-id="tool:\/scan"/);
  // Named the way someone who has never typed a slash command would name it,
  // with the command itself kept as the hint — which is how it gets learned.
  assert.match(html, /<b>Scan dependencies<\/b>/);
  assert.match(html, /class="menu-hint">\/scan</);
  // Every command has such a name, or the menu would show a raw slash command.
  for (const command of SLASH_COMMANDS) {
    assert.ok(command.title && !command.title.startsWith('/'), `${command.name} needs a readable title`);
  }
});

test('each dial label is centred on its own handle', () => {
  // Evenly spaced labels are not the same points as the handle's stops: a
  // handle travels the track minus its own width, so spread labels drift away
  // from the circle they name — worst in the middle, which is where the eye
  // checks them.
  const html = renderPanel(model());

  const ticks = [...html.matchAll(/<span class="[^"]*" style="left:([^"]+)"/g)].map((match) => match[1]);
  assert.equal(ticks.length, 4);
  assert.ok(ticks[0]!.includes('* 0.0000'), 'the first label sits on the first handle position');
  assert.ok(ticks[3]!.includes('* 1.0000'), 'the last label sits on the last handle position');
  // Placed against the handle's own size, which is why the panel draws it.
  assert.ok(ticks[1]!.includes('var(--thumb)'));
  assert.match(html, /\.slider-ticks span \{[^}]*translateX\(-50%\)/s);
});

test('an answer is typed out rather than dropped in whole', () => {
  const html = renderPanel(
    model({ conversationId: 'c9', thread: [{ id: 'i2', kind: 'assistant', text: 'Two packages moved.' }] }),
  );

  // The key carries the conversation, so reopening an old thread does not
  // retype what it already typed.
  assert.match(html, /data-type="c9:i2"/);
  assert.match(html, /function typewriter\(\)/);
});

test('send is a thin arrow, not a filled wedge', () => {
  const html = renderPanel(model());
  const send = /<button class="send"[^>]*>(.*?)<\/button>/s.exec(html)?.[1] ?? '';

  assert.match(send, /stroke="currentColor"/);
  assert.match(send, /fill="none"/);
});

test('permission is its own button, beside send', () => {
  const html = renderPanel(model());

  assert.match(html, /data-action="openMenu" data-anchor="permission"/);
  assert.match(html, /data-section="permission" data-anchor="permission"/);
  assert.ok(
    html.indexOf('data-anchor="permission"') < html.indexOf('data-action="submit"'),
    'the permission button sits next to send',
  );
});

test('no control in the panel is an OS-drawn form widget', () => {
  // A native dropdown inside a webview is painted by the operating system: it
  // ignores the colour theme, mis-centres its own label, and cannot show the
  // sentence that explains each option. The menu is themed markup; the only
  // native elements are the two text-entry fields, which VS Code themes itself.
  const c = candidate({ impactCount: 2, impactFiles: 1 });
  const html = renderPanel(
    model({
      thread: [{ id: 'p1', kind: 'packages', headline: 'One upgrade.', ids: [c.id] }],
      candidates: { [c.id]: c },
    }),
  );

  assert.ok(!/<select\b/.test(html), 'no native dropdowns');
  assert.ok(!/<option\b/.test(html), 'no native dropdown options');
  // Two native inputs, both of which VS Code themes itself: the menu's filter
  // box and the effort dial. Everything else is themed markup.
  const inputs = [...html.matchAll(/<input\b[^>]*/g)].map((match) => match[0]);
  assert.equal(inputs.length, 2, 'only the filter and the dial are native');
  assert.ok(inputs.some((input) => /type="text"/.test(input)));
  assert.ok(inputs.some((input) => /type="range"/.test(input)));
  // The target-version control is the one inside a result row, and it is a
  // button too — consistency here is the whole point.
  assert.match(html, /data-action="pickVersion" data-id="/);
});

test('the nonce is applied to both the script and the CSP', () => {
  const html = renderPanel(model({ nonce: 'NONCEVALUE' }));
  assert.match(html, /script-src 'nonce-NONCEVALUE'/);
  assert.match(html, /<script nonce="NONCEVALUE">/);
  assert.ok(!html.includes('unsafe-eval'));
});

test('an upstream-only package is not framed as an alarm', () => {
  const c = candidate();
  assert.equal(severityOf(c), 'upstream-only');

  const html = renderPanel(
    model({
      thread: [{ id: 'i1', kind: 'packages', headline: 'One upgrade available.', ids: [c.id] }],
      candidates: { [c.id]: c },
    }),
  );

  // The row reads "Safe here", and carries neither the warning tint nor the
  // error tint — only `affected` and `error` deviate from the calm default.
  assert.match(html, /Safe here/);
  assert.match(html, /class="dot upstream-only"/);
  assert.ok(!/class="dot affected"/.test(html), 'must not be tinted as affecting the repo');
  assert.ok(!/verdict affected/.test(html), 'must not be labelled as affecting the repo');
  assert.match(describeSeverity(c), /none used here/);
});

test('a package that does affect the repo says so, with counts', () => {
  const c = candidate({ impactCount: 4, impactFiles: 2 });
  assert.equal(severityOf(c), 'affected');

  const html = renderPanel(
    model({
      thread: [{ id: 'i1', kind: 'packages', headline: 'One upgrade needs attention.', ids: [c.id] }],
      candidates: { [c.id]: c },
    }),
  );

  assert.match(html, /4 sites here/);
  assert.match(html, /class="dot affected"/);
  assert.match(html, /data-action="fixPackage"/);
});

test('a running step shows the specific phase, detail and progress', () => {
  const html = renderPanel(
    model({
      busy: true,
      thread: [
        {
          id: 'i1',
          kind: 'step',
          title: 'Checking your dependencies',
          phase: 'Reading release notes and changelog',
          detail: 'react 18.3.1 → 19.2.0',
          done: 12,
          total: 48,
          state: 'running',
          log: [
            { text: 'Reading manifest — package.json' },
            { text: 'Reading release notes and changelog — react 18.3.1 → 19.2.0' },
          ],
        },
      ],
    }),
  );

  assert.match(html, /Reading release notes and changelog/);
  assert.match(html, /react 18\.3\.1 → 19\.2\.0/);
  assert.match(html, /12 \/ 48/);
  assert.match(html, /width:25%/);
  // Agent work is interruptible, and says so with a stop button.
  assert.match(html, /data-action="stop"/);
  assert.ok(!/data-action="submit"/.test(html));
});

/**
 * A progress line that names a file has already done the work of telling the
 * developer where Drift is; making them retype that path to go and look is the
 * whole distance between a log and a tool. What these guard is the other half:
 * a link that opens nothing is worse than plain text, because it invites a
 * click and then does nothing with it.
 */
test('a file path in a progress line becomes a link that opens it', () => {
  const html = linkifyPaths('Reading manifest — eval/fixtures/npm-return-value/consumer/package.json');

  assert.match(html, /data-action="openFile"/);
  assert.match(html, /data-file="eval\/fixtures\/npm-return-value\/consumer\/package\.json"/);
});

test('a bare manifest name at the repository root is still a link', () => {
  assert.match(linkifyPaths('Reading manifest — package.json'), /data-file="package\.json"/);
});

test('a gitignored file a test checkout refused to copy is a link, not a rule to decode', () => {
  const html = linkifyPaths('never copied 1 gitignored file (backend/lutexplorer.key) — it looked like credentials');

  assert.match(html, /data-file="backend\/lutexplorer\.key"/);
  // The `.gitignore:6:` prefix `git check-ignore -v` prints is not the answer
  // to "which file?" — it is the answer with a filename and a stale line
  // number bolted onto the front.
  assert.ok(!/gitignore:\d+:/.test(html));
});

test('a version is never mistaken for a path', () => {
  for (const line of [
    'react 18.3.1 → 19.2.0',
    'Checked zod 3.22.4 → 4.1.5 · safe',
    '@anthropic-ai/sdk@0.68.0',
  ]) {
    assert.ok(!/data-action="openFile"/.test(linkifyPaths(line)), `${line} should not linkify`);
  }
});

test('text around a path is escaped rather than passed through', () => {
  const html = linkifyPaths('<script> src/app.ts');
  assert.ok(!html.includes('<script>'));
  assert.match(html, /data-file="src\/app\.ts"/);
});

test('a running command shows what it is printing, so a long check is not a hang', () => {
  const html = renderPanel(
    model({
      busy: true,
      thread: [
        {
          id: 'i1',
          kind: 'step',
          title: 'Checking your dependencies',
          phase: 'Checking extension as it is',
          detail: '`npm run typecheck`',
          done: 3,
          total: 9,
          state: 'running',
          log: [{ text: 'Checking extension as it is — `npm run typecheck`', output: 'i1-o1' }],
          outputs: [
            { id: 'i1-o1', phase: 'Checking extension as it is', lines: ['src/ui/home.ts', 'src/ui/webview.ts'] },
          ],
        },
      ],
    }),
  );

  assert.match(html, /class="step-output"/);
  assert.match(html, /src\/ui\/webview\.ts/);
  // The phase names the command, not just "checking" — a typecheck, a build
  // and a test suite are different waits.
  assert.match(html, /npm run typecheck/);
});

/**
 * The regression this guards: output used to be a single buffer, cleared the
 * moment the phase changed — a typecheck's tail vanished the instant the
 * build started, which read as the terminal "clearing and coming back" with
 * no way to tell which step it belonged to. Every phase now keeps its own
 * segment.
 */
test('a step with output from more than one phase keeps every phase, not just the newest', () => {
  const html = renderPanel(
    model({
      busy: true,
      thread: [
        {
          id: 'i1',
          kind: 'step',
          title: 'Checking your dependencies',
          phase: 'Checking extension as it is',
          detail: '`npm run build`',
          done: 3,
          total: 9,
          state: 'running',
          log: [],
          outputs: [
            { id: 'i1-o1', phase: 'Installing dependencies', lines: ['added 412 packages'] },
            { id: 'i1-o2', phase: 'Checking extension as it is', lines: ['src/ui/home.ts(12,3): error'] },
          ],
        },
      ],
    }),
  );

  // Both segments are in the markup — only their visibility differs, and that
  // is a client-side choice, not something the server hides.
  assert.match(html, /added 412 packages/);
  assert.match(html, /src\/ui\/home\.ts\(12,3\): error/);
  // One control — the follow/pin toggle — and the name of whichever phase is
  // showing. Picking a different phase is done from the step list itself.
  assert.match(html, /class="output-tab live active"/);
  assert.ok(!/class="output-tab"/.test(html), 'no per-phase badges');
});

test('a single-phase step shows its output with no tab bar to switch between', () => {
  const html = renderPanel(
    model({
      thread: [
        {
          id: 'i1',
          kind: 'step',
          title: 'Checking your dependencies',
          phase: 'Installing dependencies',
          detail: '',
          done: 0,
          total: 0,
          state: 'running',
          log: [],
          outputs: [{ id: 'i1-o1', phase: 'Installing dependencies', lines: ['added 1 package'] }],
        },
      ],
    }),
  );

  assert.match(html, /added 1 package/);
  // The stylesheet always defines \`.output-tabs\`; what must be absent is the
  // tab bar actually being rendered into the body.
  assert.ok(!/<div class="output-tabs">/.test(html), 'nothing to switch between yet');
});

test('a button that is working keeps its label and spins beside it', () => {
  // The regression this guards: the loading state blanked the label to centre
  // a spinner in the gap, and drew that spinner in the progress-bar colour —
  // the same blue as a primary button's background. The result was an empty
  // blue rectangle with an invisible ring in it, and no way to tell which of
  // two adjacent buttons had been pressed.
  const html = renderPanel(model({}));
  const rule = /button\[data-action\]\.is-loading \{[\s\S]*?\}/.exec(html)?.[0] ?? '';

  assert.ok(rule, 'the loading state is styled');
  assert.ok(!/color:\s*transparent/.test(rule), 'the label stays readable while the action runs');
  assert.match(rule, /display:\s*inline-flex/, 'the spinner sits beside the label rather than over it');
  assert.match(
    html,
    /button\[data-action\]\.is-loading::after \{[\s\S]*?currentColor/,
    'the spinner is drawn in the colour the label is drawn in, which every theme guarantees is readable here',
  );
});

test('a step in the log opens its own output, and one that printed nothing does not', () => {
  // The control that replaced the row of phase badges. A phase that ran a
  // command is a button in the step list; a phase that printed nothing stays
  // plain text, because a highlight on hover is an offer the panel cannot
  // keep.
  const html = renderPanel(
    model({
      thread: [
        {
          id: 'i1',
          kind: 'step',
          title: 'Checking your dependencies',
          phase: 'Checking extension as it is',
          detail: '`npm run build`',
          done: 3,
          total: 9,
          state: 'running',
          log: [
            { text: 'Reading manifest — package.json' },
            { text: 'Preparing a test checkout — carried over config/local.json', output: 'i1-o1' },
            { text: 'Checking extension as it is — `npm run build`', output: 'i1-o2' },
          ],
          outputs: [
            { id: 'i1-o1', phase: 'Preparing a test checkout', lines: ['added 412 packages'] },
            { id: 'i1-o2', phase: 'Checking extension as it is', lines: ['src/ui/home.ts(12,3): error'] },
          ],
        },
      ],
    }),
  );

  assert.match(html, /<button type="button" class="log-line" data-action="selectOutput" data-step="i1" data-seg="i1-o1"/);
  assert.match(html, /<button type="button" class="log-line" data-action="selectOutput" data-step="i1" data-seg="i1-o2"/);
  // The line for a phase that ran no command is not clickable.
  assert.match(html, /<li>Reading manifest/);

  // The button is the phase alone. The detail after it carries the file links
  // `linkifyPaths` produces, and an anchor inside a button is invalid markup
  // that browsers resolve inconsistently — the file link and the output picker
  // would be fighting over the same click.
  for (const button of html.matchAll(/<button[^>]*class="log-line"[^>]*>([\s\S]*?)<\/button>/g)) {
    assert.ok(!/<a\b/.test(button[1] ?? ''), `an anchor is nested inside a log-line button: ${button[0]}`);
  }
  assert.match(
    html,
    /<span class="log-detail"> — carried over <a data-action="openFile" data-file="config\/local\.json"/,
    'the path after the phase still opens the file',
  );

  // Every line keeps its list marker: the numbering is the reading order, and
  // hiding it on the clickable ones would leave the visible markers skipping
  // (the double-digit-marker test below is about that numbering).
  assert.ok(!/<li class=/.test(html), 'no log line opts out of the list numbering');
  assert.ok(
    !/\.step \.log[^{]*\{[^}]*list-style:\s*none/.test(html),
    'and nothing in the step log stylesheet removes the markers either',
  );
});

test('a log line whose output has been evicted is not offered as a button', () => {
  // Segments are bounded; the log is not. A line pointing at a segment that
  // has since been dropped must read as plain text rather than as a control
  // that does nothing.
  const html = renderPanel(
    model({
      thread: [
        {
          id: 'i1',
          kind: 'step',
          title: 'Checking',
          phase: 'Now',
          detail: '',
          done: 0,
          total: 0,
          state: 'running',
          log: [{ text: 'Long gone — `npm install`', output: 'i1-o0' }, { text: 'Now' }],
          outputs: [{ id: 'i1-o9', phase: 'Now', lines: ['working'] }],
        },
      ],
    }),
  );

  assert.ok(!/data-seg="i1-o0"/.test(html), 'a segment that no longer exists is not offered');
});

test('step logs leave room for double digit markers', () => {
  const html = renderPanel(
    model({
      thread: [
        {
          id: 'i1',
          kind: 'step',
          title: 'Checking your dependencies',
          phase: 'Reading',
          detail: '',
          done: 10,
          total: 12,
          state: 'running',
          log: Array.from({ length: 12 }, (_, i) => ({ text: `Package ${i + 1}` })),
        },
      ],
    }),
  );

  assert.match(html, /\.step \.log ol \{[\s\S]*?padding-left:\s*28px/);
  assert.match(html, /<li>Package 10<\/li>/);
});

test('a dependency check offers no way to stop it', () => {
  // A scan stopped half way has not checked the packages it never reached, but
  // the tallies, the safe list and the headline would all read as though it had.
  // The one wrong answer Drift must never give is "safe" about something nothing
  // looked at, so this run has no stop button at all.
  const html = renderPanel(
    model({
      busy: true,
      cancellable: false,
      thread: [
        {
          id: 'i1',
          kind: 'step',
          title: 'Checking your dependencies',
          phase: 'Reading release notes',
          detail: 'react',
          done: 3,
          total: 40,
          state: 'running',
          log: [{ text: 'a' }, { text: 'b' }],
        },
      ],
    }),
  );

  assert.ok(!/data-action="stop"/.test(html), 'a scan cannot be interrupted');
  assert.ok(!/data-action="submit"/.test(html));
  assert.match(html, /class="working"/);
});

test('the introduction survives the opening scan and goes when talking starts', () => {
  const scanning = renderPanel(
    model({
      busy: true,
      cancellable: false,
      thread: [
        { id: 's1', kind: 'step', title: 'Checking your dependencies', phase: 'Reading', detail: '', done: 0, total: 9, state: 'running', log: [] },
      ],
    }),
  );

  // Still explaining what the panel is for, and standing above the work it
  // started: a developer meeting this panel for the first time reads downwards,
  // so the reason has to come before the progress bar.
  assert.match(scanning, /class="welcome compact"/);
  assert.ok(scanning.indexOf('class="welcome') < scanning.indexOf('class="step'), 'the introduction comes first');

  const talking = renderPanel(
    model({ thread: [{ id: 'u1', kind: 'user', text: 'hello', attachments: [] }] }),
  );
  assert.ok(!/class="welcome/.test(talking), 'the conversation replaces the introduction');
});

test('a turn with a checkpoint offers a rewind', () => {
  const withCheckpoint = renderPanel(
    model({ thread: [{ id: 'u1', kind: 'user', text: '/fix', attachments: [], checkpoint: 'c1' }] }),
  );
  assert.match(withCheckpoint, /data-action="rewind" data-id="u1"/);

  // No snapshot, no button: a folder that is not a git repository cannot be
  // rewound, and offering the control anyway would be a promise Drift cannot keep.
  const without = renderPanel(model({ thread: [{ id: 'u1', kind: 'user', text: '/fix', attachments: [] }] }));
  assert.ok(!/data-action="rewind"/.test(without));
});

test('safe upgrades can be taken in one action, unknown ones cannot', () => {
  const clean = candidate({ id: 'a@1->2', name: 'a', breakingCount: 0, summary: 'no breaking changes' });
  const upstream = candidate({ id: 'b@1->2', name: 'b' });
  const html = renderPanel(
    model({
      thread: [{ id: 'p1', kind: 'packages', headline: 'Two upgrades.', ids: [clean.id, upstream.id] }],
      candidates: { [clean.id]: clean, [upstream.id]: upstream },
    }),
  );

  assert.match(html, /data-action="upgradeAll"/);
  assert.match(html, /Upgrade all 2/);
});

test('markdown renders a before/after pair as one comparison with a diff button', async () => {
  await warmCodeHighlighter();
  const html = renderMarkdown('Update call sites.\n  before: old(<tag>)\n  after:  next(value)');

  assert.match(html, /<p>Update call sites\.<\/p>/);
  assert.match(html, /<figcaption>before<\/figcaption>/);
  assert.match(html, /<figcaption>after<\/figcaption>/);

  // One block, not two loose figures — and the action every before/after
  // implies: open exactly this change in the editor's diff view.
  assert.match(html, /<div class="compare">/);
  assert.match(html, /data-action="openFindingDiff"/);

  // Syntax highlighting wraps tokens in their own <span>, so the escaped
  // source text is asserted with the tags stripped rather than as one run.
  const text = html.replace(/<[^>]+>/g, '');
  assert.match(text, /old\(&lt;tag&gt;\)/);
  assert.match(text, /next\(value\)/);
  assert.doesNotMatch(html, /old\(<tag>\)/);
});

test('code is tokenised against the editor theme rather than left flat', async () => {
  await warmCodeHighlighter();
  // Real TextMate tokenisation colours each token inline, from the theme the
  // editor is using — the whole point of not hand-rolling a highlighter.
  assert.match(renderMarkdown('```\nexport const x = 1;\n```'), /<span style="color:#[0-9a-fA-F]{6}">/);
});

test('a scan whose results have gone stale says so and offers a rescan', () => {
  const c = candidate();
  const html = renderPanel(
    model({
      stale: { reason: 'dependencies', label: 'package.json changed since this scan.' },
      thread: [{ id: 'p1', kind: 'packages', headline: 'One upgrade.', ids: [c.id] }],
      candidates: { [c.id]: c },
    }),
  );

  assert.match(html, /package.json changed since this scan/);
  assert.match(html, /data-action="rescan"/);
});

test('one package can be checked again without re-checking every package', () => {
  // Re-checking a single row cost a full scan, so the cheapest question in the
  // panel — "is that still true?" — was the one nobody asked.
  const c = candidate();
  const html = renderPanel(
    model({
      thread: [{ id: 'p1', kind: 'packages', headline: 'One upgrade.', ids: [c.id] }],
      candidates: { [c.id]: c },
    }),
  );

  // The id is attribute-escaped on the way out, so match the button and then
  // that it carries this row's id rather than comparing the raw string.
  assert.match(html, /data-action="recheck" data-id="lodash@4\.17\.21-&gt;5\.0\.0"/);
});

test('a package already being checked offers no second re-check', () => {
  const c = candidate({ status: 'checking' });
  const html = renderPanel(
    model({
      thread: [{ id: 'p1', kind: 'packages', headline: 'One upgrade.', ids: [c.id] }],
      candidates: { [c.id]: c },
    }),
  );

  assert.doesNotMatch(html, /data-action="recheck"/);
});

test('a package the manifest named but nothing has checked yet says so, and offers nothing', () => {
  // The row that exists to prove the scan is working. It has a name and an
  // installed version and nothing else, so it must not render a target
  // version, an upgrade button, or a verdict — and above all must not be
  // counted among the packages found safe.
  const c = candidate({
    status: 'pending',
    phase: 'Reading release notes and changelog',
    selected: '4.17.21',
    latest: '4.17.21',
    versions: [],
    breakingCount: 0,
    evidenceCount: 0,
    summary: '',
  });
  const html = renderPanel(
    model({
      thread: [{ id: 'p1', kind: 'packages', headline: 'Checking.', ids: [c.id] }],
      candidates: { [c.id]: c },
    }),
  );

  assert.match(html, /Reading release notes and changelog/, 'the row says what is happening to it');
  assert.doesNotMatch(html, /Target version/, 'there is no target version to choose yet');
  assert.doesNotMatch(html, /data-action="upgrade"/, 'nothing to install yet');
  assert.doesNotMatch(html, /Safe to upgrade/, 'a package nobody has checked is not a package found safe');
});

test('every disclosure carries a key, so re-rendering cannot collapse it', () => {
  // The panel re-renders many times a second during a scan. Without a stable
  // key on each <details>, everything the developer opened slams shut each time
  // a package arrives — exactly when they are reading it.
  const c = candidate({ impactCount: 2, impactFiles: 1 });
  const html = renderPanel(
    model({
      thread: [
        { id: 's1', kind: 'step', title: 'Checking', phase: 'x', detail: '', done: 1, total: 2, state: 'running', log: [{ text: 'a' }, { text: 'b' }] },
        { id: 'p1', kind: 'packages', headline: 'One upgrade.', ids: [c.id] },
      ],
      candidates: { [c.id]: c },
    }),
  );

  for (const tag of html.matchAll(/<details\b[^>]*>/g)) {
    assert.match(tag[0], /data-key="/, `a <details> has no key: ${tag[0]}`);
  }
  assert.match(html, /data-key="log:s1"/);
  // Keyed by manifest as well as name, so the same package declared in two
  // manifests gets two independently remembered rows rather than one shared
  // open/closed state that makes the list look like it duplicated a row.
  assert.match(html, /data-key="pkg:package\.json#lodash"/);
});

test('an open question renders its options and no answer', () => {
  const html = renderPanel(
    model({
      awaitingAnswer: true,
      thread: [
        {
          id: 'q1',
          kind: 'question',
          text: 'Two migrations are valid here. Which do you want?',
          options: [
            { label: 'Use the new async API', value: 'async' },
            { label: 'Keep it synchronous', value: 'sync' },
          ],
          allowFreeText: true,
        },
      ],
    }),
  );

  assert.match(html, /class="turn assistant question open"/);
  assert.match(html, /data-action="answer" data-id="q1" data-value="async"/);
  assert.match(html, /Or type your own answer below/);
});

test('an answered question shows the answer and no buttons', () => {
  const html = renderPanel(
    model({
      thread: [
        {
          id: 'q1',
          kind: 'question',
          text: 'Which?',
          options: [{ label: 'A', value: 'a' }],
          allowFreeText: false,
          answer: 'a',
        },
      ],
    }),
  );

  assert.match(html, /answered-with/);
  assert.ok(!/data-action="answer"/.test(html));
});

test('the changes card lists files with keep and undo at both levels', () => {
  const html = renderPanel(
    model({
      thread: [{ id: 'c1', kind: 'changes', title: 'Changes waiting for you' }],
      review: {
        totals: { files: 1, hunks: 2, added: 5, removed: 3, groups: 1 },
        groups: [
          {
            order: 1,
            title: 'fix(deps): migrate lodash chain calls',
            paths: ['src/report.ts'],
            files: [
              {
                path: 'src/report.ts',
                baseline: 'a',
                current: 'b',
                hunks: [
                  { id: '1-1', start: 1, end: 2, baselineStart: 1, baselineEnd: 2, modifiedLines: ['b'], baselineLines: ['a'] },
                  { id: '9-9', start: 9, end: 10, baselineStart: 9, baselineEnd: 10, modifiedLines: ['d'], baselineLines: ['c'] },
                ],
                stat: { added: 5, removed: 3 },
              },
            ],
          },
        ],
      },
    }),
  );

  assert.match(html, /data-action="keepAll"/);
  assert.match(html, /data-action="undoAll"/);
  assert.match(html, /data-action="keepGroup" data-order="1"/);
  assert.match(html, /data-action="keepFile" data-path="src\/report.ts"/);
  assert.match(html, /data-action="openDiff" data-path="src\/report.ts"/);
  // The promise that makes review safe, stated where the decision is made.
  assert.match(html, /Nothing is committed yet/);
});

test('a committed group reports its sha and offers no further action', () => {
  const html = renderPanel(
    model({
      thread: [{ id: 'c1', kind: 'changes', title: 'Changes' }],
      review: {
        totals: { files: 1, hunks: 1, added: 1, removed: 0, groups: 1 },
        groups: [
          {
            order: 1,
            title: 'done',
            paths: ['done.ts'],
            files: [],
            committed: { sha: 'abcdef1234', branch: 'drift/fix' },
          },
          {
            order: 2,
            title: 'still open',
            paths: ['a.ts'],
            files: [
              {
                path: 'a.ts',
                baseline: 'x',
                current: 'y',
                hunks: [{ id: '0-0', start: 0, end: 1, baselineStart: 0, baselineEnd: 1, modifiedLines: ['y'], baselineLines: ['x'] }],
                stat: { added: 1, removed: 1 },
              },
            ],
          },
        ],
      },
    }),
  );

  assert.match(html, /Committed as abcdef1/);
  assert.ok(!/data-action="keepGroup" data-order="1"/.test(html), 'a committed group has no keep button');
  assert.match(html, /data-action="keepGroup" data-order="2"/);
});

test('evidence content from a third party is escaped, not injected', () => {
  // Changelog text is fetched from the internet. Rendering it unescaped would
  // put arbitrary markup inside the panel.
  const hostile = '<img src=x onerror="alert(1)">';
  const c = candidate({
    impactCount: 1,
    impactFiles: 1,
    summary: hostile,
  });

  const html = renderPanel(
    model({
      thread: [{ id: 'i1', kind: 'packages', headline: hostile, ids: [c.id] }],
      candidates: { [c.id]: c },
    }),
  );

  assert.ok(!html.includes('<img src=x'), 'raw markup must not survive rendering');
  assert.match(html, /&lt;img src=x/);
});

test('a markdown link folded into the one-line verdict renders as a link, not literal brackets', () => {
  // `summarize()` folds rationale gap text (which can carry `[label](url)` links,
  // e.g. release-notes citations) straight into `candidate.summary` when there is
  // nothing else to report. The same sentence renders as a link further down via
  // renderGaps(), so verdict-long must match rather than showing raw markdown.
  const c = candidate({
    summary:
      'Safe to upgrade. Drift read 1 set of release notes ([svelte-check@4.7.6 release notes](https://example.test/notes)) and found nothing that announces a breaking change.',
  });

  const html = renderPanel(
    model({
      thread: [{ id: 'i1', kind: 'packages', headline: 'One upgrade available.', ids: [c.id] }],
      candidates: { [c.id]: c },
    }),
  );

  assert.match(html, /<a data-action="openUrl" data-url="https:\/\/example\.test\/notes">svelte-check@4\.7\.6 release notes<\/a>/);
  assert.ok(!html.includes('[svelte-check@4.7.6 release notes]'), 'raw markdown link syntax must not survive rendering');
});

test('the nightly-toolchain install request is offered with a clear reason', () => {
  const c = candidate({
    name: 'serde',
    ecosystem: 'cargo',
    packageManager: 'cargo',
    gaps: ['`cargo public-api` needs the Rust nightly toolchain to read rustdoc\'s JSON output, and it is not installed.'],
    breakingCount: 0,
    impactCount: 0,
    impactFiles: 0,
    recommendation: 'insufficient-evidence',
    toolRequests: [
      {
        id: 'rustup-nightly',
        label: 'Install the Rust nightly toolchain',
        command: 'rustup',
        args: ['toolchain', 'install', 'nightly', '--profile', 'minimal'],
      },
    ],
  });

  const html = renderPanel(
    model({
      thread: [{ id: 'i1', kind: 'packages', headline: 'One upgrade available.', ids: [c.id] }],
      candidates: { [c.id]: c },
    }),
  );

  assert.match(html, /data-action="installTool"/);
  assert.match(html, /data-value="rustup-nightly"/);
  assert.match(html, /Install the Rust nightly toolchain/);
  assert.match(html, /needs the Rust nightly toolchain/);
});

test('attachment chips render with a remove button', () => {
  const html = renderPanel(
    model({ attachments: [{ kind: 'file', label: 'src/http.ts', value: 'src/http.ts' }] }),
  );

  assert.match(html, /class="chip">/);
  assert.match(html, /data-action="detach" data-value="src\/http.ts"/);
});

test('a panel with every item type produces balanced markup', () => {
  // Unbalanced tags in a webview do not throw — the browser silently reparents
  // everything after the mistake, and the panel just looks broken. So this walks
  // a fully-populated render and checks the tags actually close.
  const c = candidate({ impactCount: 5, impactFiles: 2, risk: 'medium' });
  const html = renderPanel(
    model({
      attachments: [{ kind: 'file', label: 'src/http.ts', value: 'src/http.ts' }],
      awaitingAnswer: true,
      thread: [
        { id: 'u1', kind: 'user', text: '/scan', attachments: [] },
        { id: 'a1', kind: 'assistant', text: 'Here is what I found:\n\n- one\n- two\n\n```ts\nconst x = 1;\n```' },
        { id: 's1', kind: 'step', title: 'Checking', phase: 'Reading changelog', detail: 'lodash 4 → 5', done: 3, total: 9, state: 'done', log: [{ text: 'a' }, { text: 'b' }] },
        { id: 'p1', kind: 'packages', headline: '**1 of 1** affects your code.', ids: [c.id] },
        {
          id: 't1',
          kind: 'tasks',
          title: 'Fixing 2 sites',
          subtitle: '1 commit across 1 file.',
          groups: [
            {
              id: 'c1',
              title: 'fix(deps): migrate',
              package: 'lodash',
              state: 'active',
              note: 'Editing src/a.ts',
              tasks: [{ id: 'c1-0', label: '_.chain() removed', file: 'src/a.ts', line: 3, state: 'active' }],
            },
          ],
        },
        { id: 'q1', kind: 'question', text: 'Which migration?', options: [{ label: 'A', value: 'a' }], allowFreeText: true },
        { id: 'n1', kind: 'notice', tone: 'warn', text: 'heads up' },
        { id: 'ch1', kind: 'changes', title: 'Changes waiting' },
      ],
      candidates: { [c.id]: c },
      review: {
        totals: { files: 1, hunks: 1, added: 2, removed: 1, groups: 1 },
        groups: [
          {
            order: 1,
            title: 'fix: migrate',
            paths: ['src/a.ts'],
            files: [
              {
                path: 'src/a.ts',
                baseline: 'x',
                current: 'y',
                hunks: [{ id: '0-0', start: 0, end: 1, baselineStart: 0, baselineEnd: 1, modifiedLines: ['y'], baselineLines: ['x'] }],
                stat: { added: 2, removed: 1 },
              },
            ],
          },
        ],
      },
    }),
  );

  const voids = new Set(['meta', 'br', 'hr', 'img', 'input', 'source', 'path', 'circle', 'rect', 'use']);
  const stack: string[] = [];

  for (const match of html.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g)) {
    const closing = match[1] === '/';
    const name = match[2]!.toLowerCase();
    if (voids.has(name) || match[3]!.trimEnd().endsWith('/')) continue;

    if (closing) {
      assert.equal(stack.pop(), name, `</${name}> closed the wrong element`);
    } else {
      stack.push(name);
    }
  }

  assert.deepEqual(stack, [], 'every tag is closed');
});

test('agent work is a checklist, not a blob of text', () => {
  // What a developer asks continuously while an agent runs: what is the plan,
  // where is it now, what has it already changed. All three are answerable
  // without reading a transcript.
  const html = renderPanel(
    model({
      busy: true,
      thread: [
        {
          id: 't1',
          kind: 'tasks',
          title: 'Claude Code is fixing 3 sites',
          subtitle: '2 commits, one per concern, across 2 files.',
          groups: [
            {
              id: 'c1',
              title: 'fix(deps): migrate lodash chain calls',
              package: 'lodash',
              state: 'active',
              note: 'Editing src/report.ts',
              activity: [
                { id: 'a1', kind: 'thinking', title: 'Thinking', detail: 'Inspecting the affected call sites' },
                { id: 'a2', kind: 'bash', title: 'Bash', input: 'npm test -- src/report.test.ts', output: 'pass' },
                {
                  id: 'a3',
                  kind: 'edit',
                  title: 'Edit',
                  file: 'src/report.ts',
                  detail: '+2 lines added, -1 line removed',
                  added: 2,
                  removed: 1,
                  lines: [
                    { kind: 'context', text: '@@ -41,1 +41,2 @@' },
                    { kind: 'del', text: 'const result = _.chain(items)' },
                    { kind: 'add', text: 'const result = items' },
                  ],
                },
              ],
              tasks: [
                {
                  id: 'c1-0',
                  label: '_.chain() was removed',
                  file: 'src/report.ts',
                  line: 42,
                  detail: '3 sites in this file',
                  state: 'active',
                },
              ],
            },
            {
              id: 'c2',
              title: 'fix(deps): update express handlers',
              package: 'express',
              state: 'pending',
              tasks: [{ id: 'c2-0', label: 'res.send(status) removed', file: 'src/http.ts', line: 9, state: 'pending' }],
            },
          ],
        },
      ],
    }),
  );

  assert.match(html, /1 of 2 done|0<\/b> of 2/);
  assert.match(html, /fix\(deps\): migrate lodash chain calls/);
  // The specific claim, at the line it is about, as a link that can be checked.
  assert.match(html, /data-action="openFile" data-file="src\/report.ts" data-line="42"/);
  assert.match(html, /_\.chain\(\) was removed/);
  // The one in progress is open; the one still ahead is not.
  assert.match(html, /class="task-group active"[^>]*open/);
  assert.match(html, /class="task-group pending" data-key="task:c2"\s*>/);
  assert.match(html, /Editing src\/report.ts/);
  assert.match(html, /Model work/);
  assert.match(html, /class="activity-item thinking"/);
  assert.match(html, /class="activity-item bash"/);
  assert.match(html, /class="activity-item edit"/);
  assert.match(html, /npm test -- src\/report\.test\.ts/);
  assert.match(html, /data-action="openFile" data-file="src\/report.ts"/);
  assert.match(html, /\+ const result = items/);
});

test('a finished task says whether the file actually changed', () => {
  // "Unchanged" is a real answer: the evidence pointed at a site the agent
  // judged already correct. Ticking it would be a lie about what happened.
  const html = renderPanel(
    model({
      thread: [
        {
          id: 't1',
          kind: 'tasks',
          title: 'Done',
          subtitle: '',
          groups: [
            {
              id: 'c1',
              title: 'fix(deps): migrate',
              state: 'done',
              tasks: [
                { id: 'a', label: 'changed', file: 'a.ts', line: 1, state: 'done' },
                { id: 'b', label: 'untouched', file: 'b.ts', line: 1, state: 'unchanged' },
              ],
            },
          ],
        },
      ],
    }),
  );

  assert.match(html, /class="box done"/);
  assert.match(html, /class="box skipped"/);
  assert.match(html, /No change needed|Changed/);
});

test('updates are a body swap, not a document reload', () => {
  // Reassigning webview.html tears the document down and re-runs the script on
  // every progress line — which is what made every button in the panel feel
  // like it was thinking about it. The body is rendered on its own and posted.
  const vm = model();
  const body = renderBody(vm);

  assert.ok(!body.includes('<!DOCTYPE html>'), 'the body carries no document');
  assert.ok(!body.includes('<script'), 'the script is written once, not per update');
  assert.match(body, /class="thread" id="thread"/);
  assert.match(body, /class="composer/);
  // The full document contains exactly that body, so both paths render the same
  // panel and only one of them pays for a reload.
  assert.ok(renderPanel(vm).includes(body));
});

test('the composer keeps a draft the host did not set', () => {
  // The token changes only when the host assigns the text itself — after a
  // submit, after a rewind. Between those, what is in the box belongs to the
  // developer, who may have typed while a render was in flight.
  const html = renderPanel(model({ draft: 'check react', draftToken: 7 }));
  assert.match(html, /<textarea[^>]*data-token="7"[^>]*>check react<\/textarea>/);
});

test('every slash command is offered in the palette', () => {
  const html = renderPanel(model());
  for (const command of SLASH_COMMANDS) {
    assert.ok(html.includes(`data-command="${command.name}"`), `${command.name} is missing`);
  }
});

test('a monorepo row says which package the dependency belongs to', () => {
  // In a workspace, *which* package moved is the first thing a reviewer needs.
  const api = candidate({
    id: 'packages/api/package.json#lodash',
    manifestPath: 'packages/api/package.json',
    workspace: 'packages/api',
    workspaceName: '@acme/api',
  });

  const html = renderPanel(
    model({
      thread: [{ id: 'p1', kind: 'packages', headline: 'One upgrade.', ids: [api.id] }],
      candidates: { [api.id]: api },
    }),
  );

  assert.match(html, /class="pkg-workspace"[^>]*>@acme\/api</);
  assert.match(html, /title="Declared in packages\/api\/package.json"/);
});

test('a single-package repository carries no workspace label', () => {
  // A label that sits on every row and never varies is one more thing to read
  // past, which is how a panel stops being read at all.
  const c = candidate();
  const html = renderPanel(
    model({
      thread: [{ id: 'p1', kind: 'packages', headline: 'One upgrade.', ids: [c.id] }],
      candidates: { [c.id]: c },
    }),
  );

  assert.ok(!/pkg-workspace/.test(stripStyleBlocks(html)));
});

test('every package row names the ecosystem it came from', () => {
  // Unlike the workspace label, this one is always shown: a scan routinely
  // spans several registries at once, and a package name alone does not say
  // which of them a row belongs to.
  const c = candidate();
  const html = renderPanel(
    model({
      thread: [{ id: 'p1', kind: 'packages', headline: 'One upgrade.', ids: [c.id] }],
      candidates: { [c.id]: c },
    }),
  );

  assert.match(stripStyleBlocks(html), /class="pkg-ecosystem"[^>]*>npm</);
});

test('a scan spanning more than one repository tags each row with its repository', () => {
  const fromA = candidate({ id: 'a#lodash', repoRoot: '/repo-a', repoLabel: 'repo-a' });
  const fromB = candidate({
    id: 'b#lodash',
    name: 'zod',
    repoRoot: '/repo-b',
    repoLabel: 'repo-b',
  });

  const html = renderPanel(
    model({
      thread: [{ id: 'p1', kind: 'packages', headline: 'Two upgrades.', ids: [fromA.id, fromB.id] }],
      candidates: { [fromA.id]: fromA, [fromB.id]: fromB },
    }),
  );

  assert.match(html, /class="pkg-workspace pkg-repo"[^>]*>repo-a</);
  assert.match(html, /class="pkg-workspace pkg-repo"[^>]*>repo-b</);
});

test('a single-repository result carries no repository label even when repoRoot is set', () => {
  // `repoRoot` is stamped on every candidate once more than one root is *open*,
  // but the tag itself is about what this *list* spans — a scope narrowed to
  // one repository should read exactly like a window that only ever had one.
  const c = candidate({ repoRoot: '/repo-a', repoLabel: 'repo-a' });
  const html = renderPanel(
    model({
      thread: [{ id: 'p1', kind: 'packages', headline: 'One upgrade.', ids: [c.id] }],
      candidates: { [c.id]: c },
    }),
  );

  assert.ok(!/pkg-repo/.test(stripStyleBlocks(html)));
});

/**
 * The failure that made this verdict necessary.
 *
 * Drift scanned this very repository, found nothing it could read about zod 4
 * or typescript 7, and rendered both as "Safe for your code · no breaking
 * changes found". Both were installed; both broke the build. Nothing about the
 * panel may ever again turn an absence of evidence into a green row.
 */
test('the panel shows what an upgrade buys, not only what it costs', () => {
  const c = candidate({
    name: 'lodash',
    current: '4.17.15',
    selected: '4.17.21',
    latest: '4.17.21',
    breakingCount: 0,
    impactCount: 0,
    impactFiles: 0,
    gaps: [],
    recommendation: 'upgrade-recommended',
    rationale: {
      dependency: 'lodash',
      from: '4.17.15',
      to: '4.17.21',
      security: {
        checked: true,
        current: [],
        target: [],
        resolved: [
          { id: 'GHSA-35jh-r3h4-6jhm', aliases: ['CVE-2021-23337'], summary: 'Command injection.', severity: 'high', url: 'https://example.test', fixedIn: '4.17.21' },
        ],
        introduced: [],
        carried: [],
        direction: 'improves',
      },
      maintenance: { facts: [{ statement: 'The repository is archived.', concerning: true }] },
      improvements: [],
      license: { verdict: 'ok', statement: '', introduced: [] },
      summary: { changes: [], unrelated: 0 },
      assessment: { recommendation: 'upgrade-recommended', reasons: [], confidence: 'high', confidenceBasis: '' },
      gaps: [],
    },
  });

  const html = renderPanel(
    model({
      thread: [{ id: 'i1', kind: 'packages', headline: 'One upgrade available.', ids: [c.id] }],
      candidates: { [c.id]: c },
    }),
  );

  assert.match(html, /Fixes 1 known vulnerability/);
  assert.match(html, /GHSA-35jh-r3h4-6jhm<\/a> — high, first fixed in 4\.17\.21/);
  // Naming an advisory without linking it asks the reader to go and search for
  // a page Drift already holds the URL of.
  assert.match(html, /data-action="openUrl" data-url="https:\/\/example\.test"/);
  assert.match(html, /CVE-2021-23337/);
  assert.match(html, /class="rationale good"/);
  // A concerning maintenance fact is shown; the neutral ones are not, so the
  // block stays worth reading.
  assert.match(html, /The repository is archived\./);
  assert.match(html, /class="rationale bad"/);
});

test('overflow security advisories are expandable', () => {
  const c = candidate({
    name: 'axios',
    current: '2.40.0',
    selected: '2.70.2',
    latest: '2.70.2',
    breakingCount: 0,
    impactCount: 0,
    impactFiles: 0,
    gaps: [],
    recommendation: 'upgrade-recommended',
    rationale: {
      dependency: 'axios',
      from: '2.40.0',
      to: '2.70.2',
      security: {
        checked: true,
        current: [],
        target: [],
        resolved: [
          { id: 'GHSA-2crg-3p73-43xp', aliases: ['CVE-2026-40073'], summary: 'First advisory.', severity: 'high', url: 'https://example.test/1', fixedIn: '2.57.1' },
          { id: 'GHSA-j62c-4x62-9r35', aliases: ['CVE-2025-67647'], summary: 'Second advisory.', severity: 'high', url: 'https://example.test/2', fixedIn: '2.49.5' },
          { id: 'GHSA-29g2-3rmr-qm68', aliases: ['CVE-2026-66062'], summary: 'Third advisory.', severity: 'medium', url: 'https://example.test/3', fixedIn: '2.70.2' },
          { id: 'GHSA-3f6h-2hrp-w5wx', aliases: ['CVE-2026-40074'], summary: 'Fourth advisory.', severity: 'medium', url: 'https://example.test/4', fixedIn: '2.57.1' },
          { id: 'GHSA-866w-xmhq-wj7x', aliases: [], summary: 'Fifth advisory.', severity: 'medium', url: 'https://example.test/5', fixedIn: '2.69.1' },
          { id: 'GHSA-hidden-hidden-0000', aliases: ['CVE-2026-00000'], summary: 'Hidden advisory.', severity: 'low', url: 'https://example.test/6', fixedIn: '2.70.2' },
        ],
        introduced: [],
        carried: [],
        direction: 'improves',
      },
      maintenance: { facts: [] },
      improvements: [],
      license: { verdict: 'ok', statement: '', introduced: [] },
      summary: { changes: [], unrelated: 0 },
      assessment: { recommendation: 'upgrade-recommended', reasons: [], confidence: 'high', confidenceBasis: '' },
      gaps: [],
    },
  });

  const html = renderPanel(
    model({
      thread: [{ id: 'i1', kind: 'packages', headline: 'One upgrade available.', ids: [c.id] }],
      candidates: { [c.id]: c },
    }),
  );

  assert.match(html, /Fixes 6 known vulnerabilities/);
  assert.match(html, /<details class="fact-more" data-key="facts:good:Fixes 6 known vulnerabilities:[^"]+">\s*<summary>…and 1 more<\/summary>/);
  assert.match(html, /GHSA-hidden-hidden-0000<\/a> — low, first fixed in 2\.70\.2/);
  assert.match(html, /data-action="openUrl" data-url="https:\/\/example\.test\/6"/);
});

test('a compared API with no changelog is checked, not unverified', () => {
  // The gap is real — there is no changelog — but the exported API was compared
  // symbol by symbol and found unchanged. Counting the gap alone would bury a
  // genuine result under a missing one.
  const c = candidate({
    name: 'golang.org/x/sys',
    current: 'v0.26.0',
    selected: 'v0.47.0',
    latest: 'v0.47.0',
    breakingCount: 0,
    impactCount: 0,
    impactFiles: 0,
    gaps: ['No release notes, changelog, or migration guide was reachable.'],
    recommendation: 'safe-to-upgrade',
  });

  assert.equal(severityOf(c), 'clean');
  assert.match(describeSeverity(c), /Safe for your code/);
});

test('an upgrade that closes an advisory is worth taking, not merely safe', () => {
  const c = candidate({
    name: 'lodash',
    current: '4.17.15',
    selected: '4.17.21',
    latest: '4.17.21',
    breakingCount: 0,
    impactCount: 0,
    impactFiles: 0,
    gaps: [],
    recommendation: 'upgrade-recommended',
  });

  assert.equal(severityOf(c), 'clean');
  assert.match(describeSeverity(c), /Worth taking/);
});

test('a rationale that reached "insufficient evidence" is still unverified', () => {
  const c = candidate({
    name: 'zod',
    current: '3.24.1',
    selected: '4.4.3',
    latest: '4.4.3',
    breakingCount: 0,
    impactCount: 0,
    impactFiles: 0,
    gaps: ['Nothing was reachable for this version.'],
    recommendation: 'insufficient-evidence',
  });

  assert.equal(severityOf(c), 'unchecked');
  assert.ok(!/Safe/.test(describeSeverity(c)));
});

test('an unverified upgrade is never rendered as safe', () => {
  const c = candidate({
    name: 'zod',
    current: '3.24.1',
    selected: '4.4.3',
    latest: '4.4.3',
    breakingCount: 0,
    impactCount: 0,
    impactFiles: 0,
    gaps: ['zod publishes no TypeScript declarations Drift could compare.'],
  });

  assert.equal(severityOf(c), 'unchecked');
  assert.match(describeSeverity(c), /Not verified/);
  assert.ok(!/Safe/.test(describeSeverity(c)), 'must not contain the word "safe"');

  const html = renderPanel(
    model({
      thread: [{ id: 'i1', kind: 'packages', headline: 'One upgrade available.', ids: [c.id] }],
      candidates: { [c.id]: c },
    }),
  );

  assert.match(html, /Not verified/);
  assert.match(html, /Could not verify/);
  assert.match(html, /class="dot unchecked"/);
  // The reason is on the page, not in a log file.
  assert.match(html, /no TypeScript declarations Drift could compare/);
  // And it is not filed under the collapsed "Safe to upgrade" group.
  assert.ok(!/pkg-subhead clean/.test(html) || !/grp:safe/.test(html.split('Could not verify')[0]!));
});

test('a missing Drift helper is offered as an approval action', () => {
  const c = candidate({
    name: 'serde',
    ecosystem: 'cargo',
    packageManager: 'cargo',
    gaps: ['Rust and Cargo are installed, but Drift\'s Rust API helper is missing.'],
    breakingCount: 0,
    impactCount: 0,
    impactFiles: 0,
    recommendation: 'insufficient-evidence',
    toolRequests: [
      {
        id: 'cargo-public-api',
        label: 'Install cargo-public-api',
        command: 'cargo',
        args: ['install', 'cargo-public-api'],
      },
    ],
  });

  const html = renderPanel(
    model({
      thread: [{ id: 'i1', kind: 'packages', headline: 'One upgrade available.', ids: [c.id] }],
      candidates: { [c.id]: c },
    }),
  );

  assert.match(html, /data-action="installTool"/);
  assert.match(html, /data-value="cargo-public-api"/);
  assert.match(html, /Install cargo-public-api/);
  assert.match(html, /compare Rust public APIs/);
});

test('evidence markdown renders relative links and keeps the full excerpt', () => {
  const content = `See [MatterCollisionData](./MatterCollisionData.md) before changing callbacks.\n\n${'migration detail '.repeat(140)}tail-still-visible`;
  const c = candidate({
    name: 'phaser',
    current: '3.90.0',
    selected: '4.0.0',
    latest: '4.0.0',
    evidenceCount: 1,
    plan: plan({
      evidence: [
        {
          id: 'e1',
          source: 'migration-guide',
          dependency: 'phaser',
          title: 'Phaser migration guide',
          content,
          weight: 0.75,
          url: 'https://raw.githubusercontent.com/phaserjs/phaser/v4.0.0/docs/migration.md',
        },
      ],
    }),
  });

  const html = panelFor(c);

  assert.doesNotMatch(html, /\[MatterCollisionData\]\(\.\/MatterCollisionData\.md\)/);
  assert.match(html, /data-action="openUrl" data-url="https:\/\/raw\.githubusercontent\.com\/phaserjs\/phaser\/v4\.0\.0\/docs\/MatterCollisionData\.md"/);
  assert.match(html, /tail-still-visible/);
});

test('evidence rendering does not silently drop later sources', () => {
  const c = candidate({
    evidenceCount: 7,
    plan: plan({
      evidence: Array.from({ length: 7 }, (_, i) => ({
        id: `e${i + 1}`,
        source: 'changelog',
        dependency: 'phaser',
        title: `Source ${i + 1}`,
        content: `content ${i + 1}`,
        weight: 0.5,
      })),
    }),
  });

  const html = panelFor(c);

  assert.match(html, /Source 7/);
  assert.match(html, /content 7/);
});

test('semver-heuristic evidence offers a real diff between the two versions; other sources do not', () => {
  const c = candidate({
    name: 'serde_json',
    current: '1.0.150',
    selected: '1.0.151',
    latest: '1.0.151',
    plan: plan({
      evidence: [
        {
          id: 'e1',
          source: 'semver-heuristic',
          dependency: 'serde_json',
          title: 'serde_json 1.0.150 → 1.0.151 (patch)',
          content: 'Patch bump. Breakage here is usually accidental.',
          weight: 0.3,
          url: 'https://semver.org/#spec-item-6',
        },
        {
          id: 'e2',
          source: 'changelog',
          dependency: 'serde_json',
          title: 'serde_json CHANGELOG § 1.0.151',
          content: 'Nothing breaking.',
          weight: 0.9,
        },
      ],
    }),
  });

  const html = panelFor(c);

  assert.match(
    html,
    /data-action="openVersionDiff" data-id="[^"]*"[^>]*>View diff/,
    'the semver-heuristic entry must offer to open a real diff',
  );
  // Exactly one — the changelog entry gets no such button.
  assert.equal(html.match(/data-action="openVersionDiff"/g)?.length, 1);
});

const panelFor = (c: UpgradeCandidate): string =>
  renderPanel(
    model({
      thread: [{ id: 'i1', kind: 'packages', headline: 'One upgrade available.', ids: [c.id] }],
      candidates: { [c.id]: c },
    }),
  );

test('the button that installs names the version it installs', () => {
  const c = candidate({ current: '3.24.1', selected: '3.25.76', latest: '4.4.3', safeLatest: '3.25.76' });
  const html = panelFor(c);

  // The primary button follows the selection. It used to be hard-wired to
  // `latest`, so picking a target version changed the heading and nothing else.
  assert.match(html, /Upgrade to 3\.25\.76/);
  assert.ok(!/Upgrade to 4\.4\.3/.test(html), 'must not offer to install a version that is not selected');

  // The major is still reachable — as a destination to check, not to install blind.
  assert.match(html, /Latest \(4\.4\.3\) — major/);
  assert.match(html, /data-action="selectVersion" data-id="[^"]*" data-version="4\.4\.3"/);
});

test('a major upgrade says that it is a major once it is the selection', () => {
  const html = panelFor(candidate({ current: '3.24.1', selected: '4.4.3', latest: '4.4.3' }));

  assert.match(html, /Upgrade to 4\.4\.3 \(major\)/);
  assert.match(html, /class="risky"/);
});

test('the upgrade button is never disabled just because the range excludes it', () => {
  // The old button was enabled only when a version fitted the declared range,
  // so a pinned dependency — or any 0.x module whose next release moves the
  // minor — rendered a permanently dead control that read as a broken panel.
  const html = panelFor(
    candidate({ current: '0.13.0', selected: '0.47.0', latest: '0.47.0', safeLatest: undefined }),
  );

  const actions = html.split('class="pkg-actions"')[1]!.split('</div>')[0]!;

  assert.match(actions, /Upgrade to 0\.47\.0/);
  assert.ok(!/disabled/.test(actions), 'no upgrade action should be disabled');
  // Out of range means widen the range, not refuse.
  assert.match(actions, /data-mode="force"/);
});

test('staying on the current major is offered when it is a real destination', () => {
  const withMinor = panelFor(
    candidate({ current: '3.24.1', selected: '4.4.3', latest: '4.4.3', latestMinor: '3.25.76' }),
  );
  assert.match(withMinor, /Stay on 3\.x \(3\.25\.76\)/);
  assert.match(withMinor, /data-action="selectVersion" data-id="[^"]*" data-version="3\.25\.76"/);

  // Not offered when it would land where the primary button already lands.
  const same = panelFor(
    candidate({ current: '3.24.1', selected: '3.25.76', latest: '3.25.76', latestMinor: '3.25.76' }),
  );
  assert.ok(!/Stay on 3\.x/.test(same));
});

test('crossesMajor reads the leading number and nothing else', () => {
  assert.equal(crossesMajor('3.24.1', '4.0.0'), true);
  assert.equal(crossesMajor('3.24.1', '3.25.76'), false);
  assert.equal(crossesMajor('v5.7.3', '7.0.2'), true);
  assert.equal(crossesMajor('1.0.0', '1.0.0'), false);
  assert.equal(crossesMajor('not-a-version', '4.0.0'), false);
});

/* ------------------------------------------------------------------ */
/* Transparency: what the panel says the agent is doing                */
/* ------------------------------------------------------------------ */

/** A `tasks` item with one group carrying the given activity rows. */
function withActivity(activity: NonNullable<TaskGroup['activity']>): string {
  return renderBody(
    model({
      thread: [
        {
          id: 't1',
          kind: 'tasks',
          title: 'Fixing 1 site',
          subtitle: '1 commit.',
          groups: [
            {
              id: 'c1',
              title: 'refactor(typescript): new entry point',
              state: 'active',
              tasks: [{ id: 'c1-0', label: 'import moved', file: 'src/a.ts', line: 1, state: 'active' }],
              activity,
            },
          ],
        },
      ],
    }),
  );
}

test('a source the agent consulted is a link, not a string in a log line', () => {
  const html = withActivity([
    {
      id: 'a1',
      kind: 'search',
      title: 'Web search',
      detail: 'Reading https://example.com/changelog?from=5&to=7',
      links: ['https://example.com/changelog?from=5&to=7'],
    },
  ]);

  // Clickable, and pointing at the whole URL — a query string dropped on the
  // way into the attribute is a link that opens a different page.
  assert.match(html, /data-action="openUrl"/);
  assert.match(html, /data-url="https:\/\/example\.com\/changelog\?from=5&amp;to=7"/);
  // Not double-encoded: `&amp;amp;` would reach the host as a literal `&amp;`.
  assert.ok(!html.includes('&amp;amp;'), 'the URL was escaped twice');
});

test('the activity drawer scrolls instead of growing without limit', () => {
  const html = renderPanel(model());
  const list = /\.activity-list\s*\{[^}]*\}/.exec(html)?.[0] ?? '';
  assert.match(list, /max-height/);
  assert.match(list, /overflow-y:\s*auto/);
});

test('agent reasoning is never titled with the stream it arrived on', () => {
  const html = withActivity([
    { id: 'a1', kind: 'thinking', title: 'Thinking', detail: 'The factory helper does not take source text' },
  ]);

  assert.match(html, /Thinking/);
  assert.ok(!/STDERR/i.test(html), 'a row was titled after a pipe');
});

/**
 * "No change needed" on its own is Drift half-retracting a breakage it just
 * reported. Without the reason behind it, a developer cannot tell a considered
 * verdict from an agent that gave up — and the agent's own explanation was
 * being discarded in favour of "Codex finished."
 */
test('a commit unit that changed nothing says why', () => {
  const html = renderBody(
    model({
      thread: [
        {
          id: 't1',
          kind: 'tasks',
          title: 'Fixing 1 site',
          subtitle: '1 commit.',
          groups: [
            {
              id: 'c1',
              title: 'refactor(zod): replace removed object',
              state: 'unchanged',
              reason: 'Both files reach `object` through the `z` namespace, which zod 4 still exports.',
              tasks: [{ id: 'c1-0', label: 'object removed', file: 'src/a.ts', line: 1, state: 'unchanged' }],
            },
          ],
        },
      ],
    }),
  );

  assert.match(html, /No change needed/);
  assert.match(html, /class="task-reason/);
  assert.match(html, /zod 4 still exports/);
});

/**
 * `.activity-io` is a two-column grid whose first track is the 34px `IN`/`OUT`
 * gutter. An unlabelled snippet rendered into that rule put the code itself in
 * the 34px column, so every line wrapped at about three characters.
 */
test('a code snippet in the drawer is not squeezed into the label gutter', () => {
  const html = withActivity([
    {
      id: 'a1',
      kind: 'thinking',
      title: 'Thinking',
      detail: 'export const schema = z.object({ retries: z.number() });',
    },
  ]);

  assert.match(html, /<pre class="activity-code">/);
  assert.ok(
    !/<pre class="activity-io"><code>/.test(html),
    'an unlabelled block must not reuse the two-column rule',
  );

  const rule = /\.activity-code\s*\{[^}]*\}/.exec(renderPanel(model()))?.[0] ?? '';
  assert.ok(!/grid-template-columns/.test(rule), 'it has no column layout of its own to be squeezed by');
});

test('the composer says where a fix will land and whether it will be committed', () => {
  const branching = renderPanel(model({ branchMode: 'new', commitMode: 'approve' }));
  assert.match(branching, /data-anchor="git"/);
  assert.match(branching, /New branch/);
  assert.match(branching, /nothing is committed until you keep it/);

  const inPlace = renderPanel(model({ branchMode: 'current', commitMode: 'auto' }));
  assert.match(inPlace, /This branch/);
  assert.match(inPlace, /commits automatically/);
});

test('the composer no longer offers a bare list of agent counts', () => {
  const html = renderPanel(model());
  // The number of agents is a question asked in the conversation, where there is
  // room to say what it buys. A row of naked integers in a menu was not that.
  assert.ok(!/data-id="fixAgents:/.test(html), 'the agent-count menu is still there');
});

test('next steps are buttons, not instructions to retype a command', () => {
  const html = renderBody(
    model({
      thread: [
        {
          id: 'a1',
          kind: 'assistant',
          text: 'That upgrade needs code changes here.',
          actions: [
            { label: 'Fix them with Codex', command: '/fix', primary: true },
            { label: 'Review the changes', command: '/review' },
          ],
        },
      ],
    }),
  );

  assert.match(html, /class="msg-actions"/);
  assert.match(html, /data-action="run" data-command="\/fix"/);
  assert.match(html, /Fix them with Codex/);
  // The panel no longer asks the reader to notice that prose was an instruction.
  assert.ok(!/[Ss]ay `\/fix`/.test(html), 'the panel still tells people to type a command');
});

/**
 * Quick Scan vs Deep Verification.
 *
 * A row with no `verification` is a Quick Scan result — static analysis
 * only. It must offer the one action that moves it into Deep Verification,
 * and say plainly that nothing has been installed or run yet, so it can
 * never be mistaken for a measured "safe".
 */
describe('Quick Scan vs Deep Verification', () => {
  test('an unmeasured row offers Verify and says it is static analysis only', () => {
    const c = candidate({ breakingCount: 0, impactCount: 0, impactFiles: 0 });
    assert.equal(c.verification, undefined);

    const html = renderPanel(
      model({
        thread: [{ id: 'i1', kind: 'packages', headline: 'One upgrade available.', ids: [c.id] }],
        candidates: { [c.id]: c },
      }),
    );

    assert.match(html, /Static analysis only — not deeply verified/);
    assert.match(html, /data-action="verifyOne"/);
  });

  test('a passed verification reads "Verified safe", not the Quick Scan wording', () => {
    const c = candidate({
      breakingCount: 2,
      impactCount: 0,
      impactFiles: 0,
      verification: {
        status: 'passed',
        checks: [
          {
            kind: 'typecheck',
            label: 'npm run typecheck',
            status: 'passed',
            compileCapable: true,
            durationMs: 1000,
            output: '',
          },
        ],
        failedFiles: [],
      },
    });

    const html = renderPanel(
      model({
        thread: [{ id: 'i1', kind: 'packages', headline: 'One upgrade available.', ids: [c.id] }],
        candidates: { [c.id]: c },
      }),
    );

    assert.match(html, /Verified safe/);
    assert.ok(!/Static analysis only/.test(html), 'a measured pass must not still read as unmeasured');
    assert.ok(!/data-action="verifyOne"/.test(html), 'nothing left to verify once it has passed');
  });

  test('a skipped verification reads "Could not verify", distinct from never having tried', () => {
    const c = candidate({
      breakingCount: 0,
      impactCount: 0,
      impactFiles: 0,
      verification: {
        status: 'skipped',
        reason: 'The scan was stopped before this could be installed.',
        checks: [],
        failedFiles: [],
      },
    });

    const html = renderPanel(
      model({
        thread: [{ id: 'i1', kind: 'packages', headline: 'One upgrade available.', ids: [c.id] }],
        candidates: { [c.id]: c },
      }),
    );

    assert.match(html, /Could not verify/);
    assert.ok(!/Static analysis only — not deeply verified/.test(html), 'a skipped attempt is not the same as no attempt');
    assert.ok(!/Verified safe/.test(html), 'an incomplete verification must never read as a pass');
    // Offers to try again rather than leaving the row a dead end.
    assert.match(html, /data-action="verifyOne"/);
  });

  test('a row still installing and checking is never left claiming a stale verdict', () => {
    const c = candidate({ status: 'checking', phase: 'npm install' });
    const html = renderPanel(
      model({
        thread: [{ id: 'i1', kind: 'packages', headline: 'One upgrade available.', ids: [c.id] }],
        candidates: { [c.id]: c },
      }),
    );

    assert.match(html, /Installing this version and running your checks against it/);
    assert.ok(!/data-action="verifyOne"/.test(html), 'no second Verify button while one is already running');
  });

  test('"Verify all" is offered only while something is actually eligible for it', () => {
    const nothingToVerify = candidate({
      verification: { status: 'passed', checks: [], failedFiles: [] },
    });
    const withVerify = candidate({ id: 'other@1->2' });

    const noneEligible = renderPanel(
      model({
        thread: [{ id: 'i1', kind: 'packages', headline: 'One upgrade available.', ids: [nothingToVerify.id] }],
        candidates: { [nothingToVerify.id]: nothingToVerify },
      }),
    );
    assert.ok(!/data-action="verifyAll"/.test(noneEligible));

    const someEligible = renderPanel(
      model({
        thread: [
          { id: 'i1', kind: 'packages', headline: 'Two upgrades available.', ids: [nothingToVerify.id, withVerify.id] },
        ],
        candidates: { [nothingToVerify.id]: nothingToVerify, [withVerify.id]: withVerify },
      }),
    );
    assert.match(someEligible, /data-action="verifyAll"/);
  });
});
