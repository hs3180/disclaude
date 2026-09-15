import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import * as lark from '@larksuiteoapi/node-sdk';
import nock from 'nock';
import type { OutgoingMessage } from '@disclaude/core';

const exec = promisify(execFile);
describe('static Card JSON 2.0 delivery to an authorized Feishu test chat', () => {
  it.skipIf(process.env.DISCLAUDE_E2E_FEISHU_CARD !== '1')('sends the CLI fixture through HTTP and the product sender, then reads back the real message', async () => {
    const chat = process.env.DISCLAUDE_E2E_FEISHU_CHAT;
    expect(chat).toMatch(/^oc_[a-zA-Z0-9]+$/u);
    expect(process.env.FEISHU_APP_ID).toBeTruthy();
    expect(process.env.FEISHU_APP_SECRET).toBeTruthy();
    const root = await mkdtemp(join(tmpdir(), 'static-card-e2e-'));
    const previousWorkspace = process.env.DISCLAUDE_WORKSPACE_DIR;
    process.env.DISCLAUDE_WORKSPACE_DIR = root;
    const { FeishuChannel } = await import('../../packages/service/src/channels/feishu-channel.js');
    const { HttpApiServer } = await import('../../packages/service/src/http-api-server.js');
    // This fixture exercises the real outgoing channel implementation. Incoming WS
    // startup is deliberately absent so it cannot compete with a running daily bot.
    class OutboundAcceptanceChannel extends FeishuChannel {
      constructor(client: lark.Client) {
        super({ appId: process.env.FEISHU_APP_ID, appSecret: process.env.FEISHU_APP_SECRET });
        Object.assign(this, { client });
      }
      deliver(message: OutgoingMessage) { return this.doSendMessage(message); }
      closeAcceptance() { return this.doStop(); }
    }

    nock.enableNetConnect(host => /^(open\.feishu\.cn|localhost|127\.0\.0\.1)(:\d+)?$/u.test(host));
    const client = new lark.Client({ appId: process.env.FEISHU_APP_ID!, appSecret: process.env.FEISHU_APP_SECRET!,
      logger: { error() {}, warn() {}, info() {}, debug() {}, trace() {} } });
    const channel = new OutboundAcceptanceChannel(client);
    const token = randomUUID();
    const server = new HttpApiServer({ host: '127.0.0.1', port: 0, apiToken: token });
    const fixture = resolve('tests/e2e/fixtures/static-card-2.json');
    const card = JSON.parse(await readFile(fixture, 'utf8')) as Record<string, unknown>;
    let messageId: string | void, sentCard: unknown, sends = 0;
    const original = client.im.message.create;
    client.im.message.create = async request => {
      sends++;
      sentCard = JSON.parse(request!.data.content);
      return original(request);
    };
    server.setSendCardHandler(async (chatId, value, threadId) => {
      if (chatId !== chat) { throw new Error('Acceptance chat mismatch'); }
      messageId = await channel.deliver({ chatId, type: 'card', card: value, threadId });
      return { success: Boolean(messageId), messageId: messageId || undefined };
    });
    try {
      await server.start();
      const address = server.getAddress()!;
      const result = await exec(process.execPath, ['bin/disclaude.js', 'channel', 'send_card', '--chat', chat!,
        '--card-file', fixture, '--base-url', `http://127.0.0.1:${address.port}`],
      { env: { ...process.env, DISCLAUDE_API_TOKEN: token }, timeout: 30_000 });
      expect(result.stdout).toContain('"ok":true');
      expect(sends).toBe(1);
      expect(sentCard).toEqual(card);
      expect(messageId!).toBeTruthy();
      const fetched = await client.im.message.get({ path: { message_id: messageId! as string } });
      expect(fetched.code).toBe(0);
      expect(fetched.data?.items?.[0]?.msg_type).toBe('interactive');
      const title = (card.header as { title: { content: string } }).title.content;
      expect(fetched.data?.items?.[0]?.body?.content).toContain(title);
      console.info('STATIC_CARD_LIVE_ACCEPTANCE', JSON.stringify({ messageId, schema: '2.0', sends, readback: true }));
    } finally {
      await server.stop();
      await channel.closeAcceptance();
      nock.enableNetConnect(host => /^(localhost|127\.0\.0\.1)(:\d+)?$/u.test(host));
      if (previousWorkspace === undefined) { delete process.env.DISCLAUDE_WORKSPACE_DIR; }
      else { process.env.DISCLAUDE_WORKSPACE_DIR = previousWorkspace; }
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
