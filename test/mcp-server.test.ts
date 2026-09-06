import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

/**
 * The MCP server is spawned by somebody else's editor and talked to over a
 * pipe, which makes two things load-bearing that nothing else in this
 * repository depends on:
 *
 *   1. **stdout belongs to the protocol.** One stray `console.log` anywhere in
 *      the analysis pipeline corrupts the stream and the client drops the
 *      connection with no useful error.
 *   2. The tool descriptions are the entire interface. A model decides whether
 *      to call `check_upgrades` from its description alone.
 *
 * So this drives the real binary over real stdio rather than calling
 * `createDriftMcpServer()` in-process — the in-process version cannot catch
 * either failure.
 */

interface Rpc {
  id?: number;
  result?: { tools?: { name: string; description?: string; inputSchema?: { properties?: Record<string, unknown> } }[]; serverInfo?: { name: string } };
}

async function handshake(): Promise<{ info: string; tools: NonNullable<NonNullable<Rpc['result']>['tools']> }> {
  const child = spawn(process.execPath, ['dist/cli.js', 'mcp'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const messages: Rpc[] = [];
  let buffer = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) if (line.trim()) messages.push(JSON.parse(line) as Rpc);
  });

  const send = (message: unknown): void => void child.stdin.write(`${JSON.stringify(message)}\n`);
  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
  });

  const deadline = Date.now() + 20_000;
  const settled = async (predicate: () => boolean): Promise<void> => {
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('timed out waiting for the server');
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  await settled(() => messages.some((m) => m.id === 1));
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  await settled(() => messages.some((m) => m.id === 2));

  child.kill();
  await once(child, 'close').catch(() => undefined);

  return {
    info: messages.find((m) => m.id === 1)?.result?.serverInfo?.name ?? '',
    tools: messages.find((m) => m.id === 2)?.result?.tools ?? [],
  };
}

describe('serving Drift over MCP', () => {
  test('completes a handshake and advertises both tools', async () => {
    const { info, tools } = await handshake();
    assert.equal(info, 'drift');
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      ['check_upgrades', 'explain_upgrade'],
    );
  });

  test('every tool describes itself and its arguments', async () => {
    // The description is the whole interface: a model chooses whether to call
    // the tool from this text and nothing else.
    const { tools } = await handshake();
    for (const tool of tools) {
      assert.ok((tool.description ?? '').length > 120, `${tool.name} needs a real description`);
      assert.ok(Object.keys(tool.inputSchema?.properties ?? {}).includes('directory'));
    }
    const check = tools.find((tool) => tool.name === 'check_upgrades')!;
    // The two claims that make it worth calling instead of guessing.
    assert.match(check.description!, /diffs their actual API/);
    assert.match(check.description!, /NOT ENOUGH EVIDENCE/);
  });
});
