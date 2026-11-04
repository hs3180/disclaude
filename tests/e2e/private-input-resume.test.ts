import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nock from 'nock';
import { HttpApiServer } from '../../packages/service/src/http-api-server.js';
import { FeishuPrivateWorkflows } from '../../packages/service/src/channels/feishu/private-workflows.js';

/**
 * Local end-to-end simulation for issue #5411 (no real Feishu; loopback only):
 * the real HTTP face the channel CLI posts to, the real private-workflow
 * engine, a real consumer process, and the session-resume notifier wired the
 * same way cli-main.ts routes /api/push signals. The Feishu WebSocket event
 * is replayed at the exact call the message handler makes after
 * isPrivateCallback(); the lark client is the only omitted link.
 */
const API_TOKEN = 'agent-token';
const server = new HttpApiServer({ port: 0, host: '127.0.0.1', apiToken: API_TOKEN });

/** Mirror of cli-main.ts: what the signal router would deliver to the waiting session. */
const resumed: Array<{ chatId: string; message: string }> = [];
const cardUpdates: Array<{ cardId: string; status: string }> = [];
const sentCards: Array<Record<string, unknown>> = [];
let cardSeq = 0;
const workflows = new FeishuPrivateWorkflows(
  // Stand-in for the FeishuChannel sendMessage: record the card, return its id.
  async message => {
    if (message.type === 'card') {
      sentCards.push(message.card as Record<string, unknown>);
      cardSeq += 1;
      return `card-${cardSeq}`;
    }
    return undefined;
  },
  async (cardId, card) => {
    cardUpdates.push({
      cardId,
      status: (card as { body?: { elements?: Array<{ content?: string }> } }).body?.elements?.[0]?.content ?? '',
    });
  }
);
workflows.setNotifier(async (chatId, message) => {
  resumed.push({ chatId, message });
});
server.setPrivateWorkflowHandler(request => workflows.request(request));

const dir = mkdtempSync(join(tmpdir(), 'private-resume-'));
const consumed = join(dir, 'consumed.json');
/** stdin collector template; `ending` runs once the private value arrived. */
const workflowArgs = (ending: string) => [
  '-e',
  `let v='';process.stdin.on('data',c=>v+=c);process.stdin.on('end',()=>{${ending}})`,
  consumed,
];
const consumer = {
  title: 'Simulated credential use',
  description: 'Local #5411 simulation',
  command: process.execPath,
  env: {},
};

/** Extract the submit button's one-use callback value from the issued card. */
function callbackValue(card: Record<string, unknown>): Record<string, unknown> {
  const elements = (card as { body?: { elements?: unknown[] } }).body?.elements ?? [];
  const form = elements.find(e => (e as { tag?: string }).tag === 'form') as
    | { elements?: Array<{ name?: string; behaviors?: Array<{ value?: Record<string, unknown> }> }> }
    | undefined;
  const button = form?.elements?.find(e => e.name === 'submit_private');
  return button?.behaviors?.[0]?.value ?? {};
}

async function baseUrl(): Promise<string> {
  await server.start();
  const address = (server as unknown as { server?: { address(): { address: string; port: number } | null } })
    .server?.address();
  if (!address) {throw new Error('HTTP API server did not expose an address');}
  return `http://${address.address}:${address.port}`;
}

beforeAll(() => {
  // tests/setup.ts enables 127.0.0.1 by exact string; the OS-assigned port
  // form host:port needs a regex. Loopback only — no external network.
  nock.enableNetConnect(/^(127\.0\.0\.1|localhost)(:\d+)?$/);
});

afterAll(async () => {
  workflows.revoke();
  await server.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('private input end-to-end resume simulation (#5411)', () => {
  it('consumes a valid submission, shows success, and resumes the waiting session without another message', async () => {
    const base = await baseUrl();
    rmSync(consumed, { force: true });
    // Step 1: the channel-CLI transport — POST /api/private-workflows.
    const response = await fetch(`${base}/api/private-workflows`, {
      method: 'POST',
      headers: { authorization: `Bearer ${API_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        chatId: 'oc_chat',
        actorId: 'ou_actor',
        sourceMessageId: 'om_source',
        workflow: { ...consumer, args: workflowArgs("require('fs').writeFileSync(process.argv[1],v)") },
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, actionId: expect.any(String) });
    expect(sentCards).toHaveLength(1);

    // Step 2: replay the Feishu card-action callback the way the message
    // handler hands it to the engine (submit button value + form value).
    const value = callbackValue(sentCards[0]);
    const callback = {
      operator: { open_id: 'ou_actor' },
      context: { open_chat_id: 'oc_chat', open_message_id: 'card-1' },
      action: { value, form_value: { credential: 'simulated-private-value' } },
    };
    // A wrong actor must not consume, notify, or repaint the live card.
    expect(await workflows.submit({ ...callback, operator: { open_id: 'ou_other' } })).toBe(true);
    expect(resumed).toEqual([]);
    expect(existsSync(consumed)).toBe(false);

    expect(await workflows.submit(callback)).toBe(true);
    // The consumer really received the private value over stdin.
    expect(readFileSync(consumed, 'utf8')).toBe('simulated-private-value');
    // Acceptance 1: the waiting session is resumed by itself — signal routed,
    // ids/outcome only, no user message involved.
    expect(resumed).toEqual([
      { chatId: 'oc_chat', message: expect.stringMatching(/succeeded$/) },
    ]);
    expect(JSON.stringify(resumed)).not.toContain('simulated-private-value');
    // Acceptance 2: the card's terminal status shows success, not a failure.
    expect(cardUpdates.at(-1)?.status).toBe('本次鉴权操作已完成。');
  });

  it('returns a distinguishable failure status when the consumer exits nonzero', async () => {
    const base = await baseUrl();
    resumed.length = 0;
    const response = await fetch(`${base}/api/private-workflows`, {
      method: 'POST',
      headers: { authorization: `Bearer ${API_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        chatId: 'oc_chat',
        actorId: 'ou_actor',
        sourceMessageId: 'om_source2',
        workflow: { ...consumer, args: workflowArgs('process.exit(3)') },
      }),
    });
    expect(response.status).toBe(200);
    const card = sentCards.at(-1)!;
    const value = callbackValue(card);
    expect(
      await workflows.submit({
        operator: { open_id: 'ou_actor' },
        context: { open_chat_id: 'oc_chat', open_message_id: `card-${cardSeq}` },
        action: { value, form_value: { credential: 'simulated-private-value' } },
      })
    ).toBe(true);
    // Distinct, safe failure: outcome 'failed' (not success, not leaked input).
    expect(resumed).toEqual([
      { chatId: 'oc_chat', message: expect.stringMatching(/failed$/) },
    ]);
    expect(cardUpdates.at(-1)?.status).toBe('本次鉴权操作未完成，请稍后重新发起。');
    expect(JSON.stringify(resumed) + cardUpdates.at(-1)?.status).not.toContain('simulated-private-value');
  });
});
