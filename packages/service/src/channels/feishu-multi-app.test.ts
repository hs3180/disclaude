/**
 * Named multi-app Feishu routing (#5254 / T-083).
 *
 * Locks the simulated acceptance surface: config validation and per-app
 * credential resolution, dual-channel inbound ownership with stable
 * `feishu:<app>:` chat identities, outbound history keeping that ownership,
 * post-restart ownership recovery, and full compatibility
 * for the legacy single-app shape.
 */
import { describe, expect, it } from 'vitest';
import {
  feishuAppErrors,
  type DisclaudeConfigWithChannels,
  type OutgoingMessage,
} from '@disclaude/core';
import { resolveChannelConfigs } from '../cli-main.js';
import { FeishuChannel, type FeishuChannelConfig } from './feishu-channel.js';

const SECRET_A = 'app-secret-a';
const SECRET_B = 'app-secret-b';

function namedRawConfig(): DisclaudeConfigWithChannels {
  return {
    agents: {
      personal: { backend: 'claude', llm: 'gateway' },
      work: { backend: 'claude', llm: 'gateway', default: true },
    },
    channels: {
      feishu: {
        apps: {
          personal: { appId: 'cli_a', appSecret: '$FEISHU_APP_SECRET_PERSONAL', agent: 'personal' },
          work: { appId: 'cli_b', appSecret: '${FEISHU_APP_SECRET_WORK}', agent: 'work' },
        },
      },
    },
  };
}

class RecordingFeishuChannel extends FeishuChannel {
  readonly sent: Array<OutgoingMessage> = [];
  protected async doStart(): Promise<void> {
    /* test transport */
  }
  protected doSendMessage(message: OutgoingMessage): Promise<string> {
    this.sent.push(message);
    return Promise.resolve(`sent-${this.id}`);
  }
  protected checkHealth(): boolean {
    return true;
  }
  async emitIncoming(chatId: string): Promise<void> {
    const handler = (
      this as unknown as {
        feishuMessageHandler: { handleMessageReceive(data: unknown): Promise<void> };
      }
    ).feishuMessageHandler;
    await handler.handleMessageReceive({
      event: {
        message: {
          message_id: 'om_same',
          chat_id: chatId,
          chat_type: 'p2p',
          content: JSON.stringify({ text: 'hello' }),
          message_type: 'text',
          create_time: Date.now(),
          mentions: undefined,
          parent_id: undefined,
        },
        sender: { sender_type: 'user', sender_id: { open_id: 'user_same' } },
      },
    });
  }
}

function makeChannel(appName: string): RecordingFeishuChannel {
  return new RecordingFeishuChannel({
    id: `feishu:${appName}`,
    appName,
    appId: `cli_${appName}`,
    appSecret: `secret-${appName}`,
  } satisfies FeishuChannelConfig);
}

describe('named Feishu apps (#5254)', () => {
  it('resolves two named apps into independent channel entries and credentials', () => {
    process.env.FEISHU_APP_SECRET_PERSONAL = SECRET_A;
    process.env.FEISHU_APP_SECRET_WORK = SECRET_B;
    const entries = resolveChannelConfigs(namedRawConfig(), {
      FEISHU_STREAMING_CARD: false,
    } as never);
    const feishuEntries = entries.filter((entry) => entry.type === 'feishu');
    expect(feishuEntries).toEqual([
      {
        type: 'feishu',
        config: {
          id: 'feishu:personal',
          appName: 'personal',
          appId: 'cli_a',
          appSecret: SECRET_A,
          streamingCard: false,
        },
      },
      {
        type: 'feishu',
        config: {
          id: 'feishu:work',
          appName: 'work',
          appId: 'cli_b',
          appSecret: SECRET_B,
          streamingCard: false,
        },
      },
    ]);
  });

  it('keeps the legacy single-app entry bit-identical when apps is absent', () => {
    const raw = { channels: { feishu: {} } } as unknown as DisclaudeConfigWithChannels;
    const entries = resolveChannelConfigs(raw, {
      FEISHU_APP_ID: 'cli_legacy',
      FEISHU_APP_SECRET: 'legacy-secret',
      FEISHU_STREAMING_CARD: false,
    } as never);
    expect(entries).toEqual([
      {
        type: 'feishu',
        config: { appId: 'cli_legacy', appSecret: 'legacy-secret', streamingCard: false },
      },
    ]);
  });

  it('rejects missing presets, mixed legacy credentials, literal secrets and empty maps explicitly', () => {
    const base = namedRawConfig();
    const named = base.channels?.feishu;
    if (!named?.apps) {
      throw new Error('fixture must configure channels.feishu.apps');
    }
    const { personal } = named.apps;
    delete process.env.FEISHU_APP_SECRET_PERSONAL;
    expect(
      feishuAppErrors({
        ...base,
        channels: { feishu: { apps: { personal: { ...personal, agent: 'missing' } } } },
      })
    ).toEqual([expect.stringContaining('unknown agents preset: missing')]);
    expect(
      feishuAppErrors({ ...base, channels: { feishu: { ...named, appId: 'cli_root' } } })
    ).toEqual([expect.stringContaining('cannot be combined with channels.feishu.apps')]);
    expect(
      feishuAppErrors({
        ...base,
        channels: { feishu: { apps: { ...named.apps, PERSONAL: personal } } },
      })
    ).toEqual([expect.stringContaining('duplicate app name')]);
    const emptyAppConfig = {
      agents: base.agents,
      channels: { feishu: { apps: { broken: {} } } },
    } as unknown as DisclaudeConfigWithChannels;
    expect(feishuAppErrors(emptyAppConfig)).toEqual([
      expect.stringContaining('channels.feishu.apps.broken.appId must be'),
      expect.stringContaining('channels.feishu.apps.broken.appSecret must be'),
    ]);
    expect(
      feishuAppErrors({
        ...base,
        channels: { feishu: { apps: { personal: { appId: 'cli_a', appSecret: 'raw-secret' } } } },
      })
    ).toEqual([expect.stringContaining('whole $VARIABLE or ${VARIABLE} reference')]);
    expect(feishuAppErrors({ ...base, channels: { feishu: { apps: {} } } })).toEqual([
      expect.stringContaining('non-empty map of named apps'),
    ]);
  });

  it('routes one raw chat concurrently through both apps with disjoint identities up to the API boundary', async () => {
    const routed: Array<{ channel: string; chatId: string }> = [];
    const personal = makeChannel('personal');
    const work = makeChannel('work');
    for (const channel of [personal, work]) {
      channel.onMessage((message) => {
        routed.push({ channel: channel.id, chatId: message.chatId });
        return Promise.resolve();
      });
      await channel.start();
    }
    try {
      await Promise.all([personal.emitIncoming('oc_same'), work.emitIncoming('oc_same')]);
      expect([...routed].sort((a, b) => a.channel.localeCompare(b.channel))).toEqual([
        { channel: 'feishu:personal', chatId: 'feishu:personal:oc_same' },
        { channel: 'feishu:work', chatId: 'feishu:work:oc_same' },
      ]);
      expect(personal.ownsChatId('feishu:personal:oc_same')).toBe(true);
      expect(personal.ownsChatId('feishu:work:oc_same')).toBe(false);
      expect(work.ownsChatId('feishu:work:oc_same')).toBe(true);

      await personal.sendMessage({
        chatId: 'feishu:personal:oc_same',
        type: 'text',
        text: 'reply',
      });
      await work.sendMessage({ chatId: 'feishu:work:oc_same', type: 'text', text: 'reply' });
      // doSendMessage (and therefore history) still sees the owning app's
      // routed ID; feishu-channel-send.test.ts pins the bare-ID API boundary.
      expect(personal.sent).toEqual([
        { chatId: 'feishu:personal:oc_same', type: 'text', text: 'reply' },
      ]);
      expect(work.sent).toEqual([{ chatId: 'feishu:work:oc_same', type: 'text', text: 'reply' }]);
      expect(personal.toApiChatId('feishu:personal:oc_same')).toBe('oc_same');
      expect(personal.toApiChatId('feishu:work:oc_same')).toBe('feishu:work:oc_same');

      // Restart simulation: fresh instances over the same config reclaim only
      // their own prefixed chats; the other app's chat is never claimed.
      await Promise.all([personal.stop(), work.stop()]);
      const restarted = makeChannel('work');
      expect(restarted.ownsChatId('feishu:work:oc_same')).toBe(true);
      expect(restarted.ownsChatId('feishu:personal:oc_same')).toBe(false);
    } finally {
      await Promise.allSettled([personal.stop(), work.stop()]);
    }
  });
});
