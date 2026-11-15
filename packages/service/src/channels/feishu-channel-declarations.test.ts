/**
 * Named multi-channel Feishu declarations (#5254 / T-083 rework).
 *
 * Users declare channels by name with a `type` marker
 * (`channels.<name>: { type: feishu, … }`). This locks the simulated
 * acceptance surface: declaration validation and per-channel credential
 * resolution, dual-channel inbound ownership with stable `feishu:<name>:`
 * chat identities, outbound history keeping that ownership, post-restart
 * ownership recovery, and full compatibility for the legacy single-app shape.
 */
import { describe, expect, it } from 'vitest';
import {
  channelCredentialErrors,
  channelDeclarationErrors,
  resolveChannelDeclarations,
  type DisclaudeConfigWithChannels,
  type OutgoingMessage,
} from '@disclaude/core';
import { resolveChannelConfigs } from '../cli-main.js';
import { FeishuChannel, type FeishuChannelConfig } from './feishu-channel.js';

const SECRET_A = 'app-secret-a';
const SECRET_B = 'app-secret-b';

function declaredRawConfig(): DisclaudeConfigWithChannels {
  return {
    agents: {
      personal: { backend: 'claude', llm: 'gateway' },
      work: { backend: 'claude', llm: 'gateway', default: true },
    },
    channels: {
      personal: {
        type: 'feishu',
        appId: 'cli_a',
        appSecret: '$FEISHU_APP_SECRET_PERSONAL',
        agent: 'personal',
      },
      work: {
        type: 'feishu',
        appId: 'cli_b',
        appSecret: '${FEISHU_APP_SECRET_WORK}',
        agent: 'work',
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

function makeChannel(channelName: string): RecordingFeishuChannel {
  return new RecordingFeishuChannel({
    id: `feishu:${channelName}`,
    channelName,
    appId: `cli_${channelName}`,
    appSecret: `secret-${channelName}`,
  } satisfies FeishuChannelConfig);
}

describe('named channel declarations (#5254)', () => {
  it('resolves two feishu declarations into independent channel entries and credentials', () => {
    process.env.FEISHU_APP_SECRET_PERSONAL = SECRET_A;
    process.env.FEISHU_APP_SECRET_WORK = SECRET_B;
    const entries = resolveChannelConfigs(declaredRawConfig(), {
      FEISHU_STREAMING_CARD: false,
    } as never);
    const feishuEntries = entries.filter((entry) => entry.type === 'feishu');
    expect(feishuEntries).toEqual([
      {
        type: 'feishu',
        config: {
          id: 'feishu:personal',
          channelName: 'personal',
          appId: 'cli_a',
          appSecret: SECRET_A,
          streamingCard: false,
        },
      },
      {
        type: 'feishu',
        config: {
          id: 'feishu:work',
          channelName: 'work',
          appId: 'cli_b',
          appSecret: SECRET_B,
          streamingCard: false,
        },
      },
    ]);
    // The declaration layer is the seam between YAML and channel instances:
    // same records, no config parsing downstream.
    expect(resolveChannelDeclarations(declaredRawConfig())).toEqual([
      {
        name: 'personal',
        type: 'feishu',
        config: {
          appId: 'cli_a',
          appSecret: '$FEISHU_APP_SECRET_PERSONAL',
          agent: 'personal',
        },
      },
      {
        name: 'work',
        type: 'feishu',
        config: { appId: 'cli_b', appSecret: '${FEISHU_APP_SECRET_WORK}', agent: 'work' },
      },
    ]);
  });

  it('keeps the legacy single-app entry bit-identical when no declaration exists', () => {
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

  it('does not gate named declarations on the legacy channels.feishu.enabled switch (T-105)', () => {
    // Regression: turning OFF the legacy single app while keeping named declarations
    // must not silently drop the declarations (previously `feishuEnabled &&` sent the
    // migration config into the legacy else-branch → zero channels, no error).
    process.env.FEISHU_APP_SECRET_PERSONAL = SECRET_A;
    process.env.FEISHU_APP_SECRET_WORK = SECRET_B;

    // Quadrant: legacy OFF + declarations present → named channels still register.
    const migrationRaw = {
      ...declaredRawConfig(),
      channels: { ...declaredRawConfig().channels, feishu: { enabled: false } },
    } as unknown as DisclaudeConfigWithChannels;
    const migrationEntries = resolveChannelConfigs(migrationRaw, {
      FEISHU_STREAMING_CARD: false,
    } as never).filter((entry) => entry.type === 'feishu');
    expect(migrationEntries.map((entry) => entry.config.channelName).sort()).toEqual([
      'personal',
      'work',
    ]);

    // Quadrant: legacy ON + declarations present → named channels (declarations win,
    // no duplicate legacy single-app entry). Same shape as the existing two-app test.
    const bothRaw = {
      ...declaredRawConfig(),
      channels: { ...declaredRawConfig().channels, feishu: { enabled: true } },
    } as unknown as DisclaudeConfigWithChannels;
    const bothEntries = resolveChannelConfigs(bothRaw, {
      FEISHU_APP_ID: 'cli_legacy',
      FEISHU_APP_SECRET: 'legacy-secret',
      FEISHU_STREAMING_CARD: false,
    } as never).filter((entry) => entry.type === 'feishu');
    expect(bothEntries.map((entry) => entry.config.channelName).sort()).toEqual([
      'personal',
      'work',
    ]);

    // Quadrant: legacy OFF + no declarations → zero feishu channels (explicit intent:
    // user disabled feishu and declared nothing named).
    const offOnlyRaw = {
      channels: { feishu: { enabled: false } },
    } as unknown as DisclaudeConfigWithChannels;
    const offOnlyEntries = resolveChannelConfigs(offOnlyRaw, {
      FEISHU_APP_ID: 'cli_legacy',
      FEISHU_APP_SECRET: 'legacy-secret',
      FEISHU_STREAMING_CARD: false,
    } as never).filter((entry) => entry.type === 'feishu');
    expect(offOnlyEntries).toEqual([]);

    // Quadrant: legacy ON + no declarations → legacy single-app entry unchanged.
    const legacyOnlyRaw = { channels: { feishu: {} } } as unknown as DisclaudeConfigWithChannels;
    const legacyOnlyEntries = resolveChannelConfigs(legacyOnlyRaw, {
      FEISHU_APP_ID: 'cli_legacy',
      FEISHU_APP_SECRET: 'legacy-secret',
      FEISHU_STREAMING_CARD: false,
    } as never);
    expect(legacyOnlyEntries).toEqual([
      {
        type: 'feishu',
        config: { appId: 'cli_legacy', appSecret: 'legacy-secret', streamingCard: false },
      },
    ]);
  });

  it('supports per-declaration streamingCard with fallback to the shared setting', () => {
    process.env.FEISHU_APP_SECRET_PERSONAL = SECRET_A;
    const raw = {
      channels: {
        personal: { type: 'feishu', appId: 'cli_a', appSecret: '$FEISHU_APP_SECRET_PERSONAL' },
        plain: { type: 'feishu', appId: 'cli_c', appSecret: '$FEISHU_APP_SECRET_PERSONAL' },
        off: {
          type: 'feishu',
          appId: 'cli_d',
          appSecret: '$FEISHU_APP_SECRET_PERSONAL',
          streamingCard: false,
          enabled: false,
        },
      },
    } as unknown as DisclaudeConfigWithChannels;
    const entries = resolveChannelConfigs(raw, {
      FEISHU_STREAMING_CARD: true,
    } as never);
    expect(entries.filter((entry) => entry.type === 'feishu')).toEqual([
      expect.objectContaining({
        config: expect.objectContaining({ channelName: 'personal', streamingCard: true }),
      }),
      expect.objectContaining({
        config: expect.objectContaining({ channelName: 'plain', streamingCard: true }),
      }),
    ]);
  });

  it('rejects unknown agents presets, mixed legacy credentials, literal secrets, duplicate and reserved names explicitly', () => {
    const base = declaredRawConfig();
    expect(
      channelCredentialErrors({
        ...base,
        channels: {
          personal: { type: 'feishu', appId: 'cli_a', appSecret: '$X', agent: 'missing' },
        },
      })
    ).toEqual([expect.stringContaining('unknown agents preset: missing')]);
    expect(
      channelCredentialErrors({
        channels: {
          feishu: { appId: 'cli_root', appSecret: '$FEISHU_APP_SECRET' },
          personal: { type: 'feishu', appId: 'cli_a', appSecret: '$FEISHU_APP_SECRET_PERSONAL' },
        },
      })
    ).toEqual([
      expect.stringContaining('cannot be combined with named feishu channel declarations'),
    ]);
    expect(
      channelCredentialErrors({
        channels: {
          personal: { type: 'feishu', appId: 'cli_a', appSecret: 'raw-secret' },
        },
      })
    ).toEqual([expect.stringContaining('whole $VARIABLE or ${VARIABLE} reference')]);
    expect(
      channelDeclarationErrors({
        channels: {
          personal: { type: 'feishu', appId: 'cli_a', appSecret: '$X' },
          PERSONAL: { type: 'feishu', appId: 'cli_a2', appSecret: '$X' },
        },
      })
    ).toEqual([expect.stringContaining('duplicate channel name (also personal)')]);
    expect(
      channelDeclarationErrors({
        channels: {
          feishu: { type: 'feishu', appId: 'cli_a', appSecret: '$X' },
        },
      })
    ).toEqual([
      expect.stringContaining(
        'built-in channel type section name; declare this channel under another name'
      ),
    ]);
    expect(
      channelCredentialErrors({
        channels: {
          broken: { type: 'feishu' },
        },
      })
    ).toEqual([
      expect.stringContaining('channels.broken.appId is required'),
      expect.stringContaining('channels.broken.appSecret is required'),
    ]);
  });

  it('rejects unsupported declaration types and the obsolete apps nesting at resolution time', () => {
    expect(() =>
      resolveChannelConfigs(
        {
          channels: { backup: { type: 'rest', port: 3000 } },
        } as unknown as DisclaudeConfigWithChannels,
        {} as never
      )
    ).toThrow('type "rest" cannot be declared as a named channel yet');
    expect(
      channelCredentialErrors({
        channels: { feishu: { apps: { personal: { appId: 'cli_a', appSecret: '$X' } } } },
      } as unknown as DisclaudeConfigWithChannels)
    ).toEqual([expect.stringContaining('channels.feishu.apps is obsolete')]);
  });

  it('rejects two declarations resolving to the same real Feishu app', () => {
    process.env.FEISHU_APP_SECRET_PERSONAL = SECRET_A;
    expect(() =>
      resolveChannelConfigs(
        {
          channels: {
            personal: {
              type: 'feishu',
              appId: 'cli_same',
              appSecret: '$FEISHU_APP_SECRET_PERSONAL',
            },
            work: { type: 'feishu', appId: 'cli_same', appSecret: '$FEISHU_APP_SECRET_PERSONAL' },
          },
        } as unknown as DisclaudeConfigWithChannels,
        { FEISHU_STREAMING_CARD: false } as never
      )
    ).toThrow('channels.work.appId duplicates channel personal');
  });

  it('routes one raw chat concurrently through both channels with disjoint identities up to the API boundary', async () => {
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
      // doSendMessage (and therefore history) still sees the owning channel's
      // routed ID; feishu-channel-send.test.ts pins the bare-ID API boundary.
      expect(personal.sent).toEqual([
        { chatId: 'feishu:personal:oc_same', type: 'text', text: 'reply' },
      ]);
      expect(work.sent).toEqual([{ chatId: 'feishu:work:oc_same', type: 'text', text: 'reply' }]);
      expect(personal.toApiChatId('feishu:personal:oc_same')).toBe('oc_same');
      expect(personal.toApiChatId('feishu:work:oc_same')).toBe('feishu:work:oc_same');

      // Restart simulation: fresh instances over the same config reclaim only
      // their own prefixed chats; the other channel's chat is never claimed.
      await Promise.all([personal.stop(), work.stop()]);
      const restarted = makeChannel('work');
      expect(restarted.ownsChatId('feishu:work:oc_same')).toBe(true);
      expect(restarted.ownsChatId('feishu:personal:oc_same')).toBe(false);
    } finally {
      await Promise.allSettled([personal.stop(), work.stop()]);
    }
  });
});
