/**
 * P3 Integration test: Passive mode / Trigger mode message filtering.
 *
 * Verifies that TriggerModeManager correctly controls message filtering
 * behavior in group chats, integrated with the IPC messaging chain.
 *
 * Test scenarios:
 *   1. Default behavior: trigger mode disabled (mention-only) — verified
 *      through TriggerModeManager.isTriggerEnabled() returning false
 *   2. Trigger mode enabled (respond to all messages)
 *   3. Small group auto-detection (≤2 members auto-enables trigger mode)
 *   4. Persisted trigger mode records loaded at startup
 *   5. Integration with IPC: trigger mode state doesn't affect IPC transport
 *
 * Run with: FEISHU_INTEGRATION_TEST=true npx vitest --run tests/integration/feishu
 *
 * @see Issue #1626
 * @see Issue #511 — Group chat passive mode control
 * @see Issue #2052 — Auto-disable passive mode for 2-member group chats
 * @see Issue #2069 — Declarative passive mode via chat config files
 * @see Issue #2193 — Renamed from PassiveModeManager to TriggerModeManager
 * @see Issue #2291 — triggerMode enum (mention/always)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  UnixSocketIpcServer,
  UnixSocketIpcClient,
  createInteractiveMessageHandler,
  type ChannelHandlersContainer,
} from '@disclaude/primary-node';
import { TriggerModeManager } from '../../../packages/primary-node/src/channels/feishu/passive-mode.js';
import { describeIfFeishu, generateSocketPath, cleanupSocket } from './helpers.js';

/**
 * Simulated message event from Feishu WebSocket.
 * Represents the data that TriggerModeManager would filter on.
 */
interface SimulatedFeishuMessage {
  chatId: string;
  text: string;
  senderOpenId: string;
  isMention: boolean;
}

/**
 * Apply trigger mode filtering to a list of simulated messages.
 * Returns only the messages that should be processed by the bot.
 *
 * Filtering rules:
 * - If trigger mode is ENABLED for the chat → ALL messages pass through
 * - If trigger mode is DISABLED → only @mention messages pass through
 */
function filterMessages(
  messages: SimulatedFeishuMessage[],
  triggerManager: TriggerModeManager,
): SimulatedFeishuMessage[] {
  return messages.filter((msg) => {
    if (triggerManager.isTriggerEnabled(msg.chatId)) {
      return true; // Trigger mode enabled: all messages pass
    }
    return msg.isMention; // Trigger mode disabled: only @mention messages pass
  });
}

describeIfFeishu('Trigger mode message filtering', () => {
  let triggerManager: TriggerModeManager;

  beforeEach(() => {
    triggerManager = new TriggerModeManager();
  });

  it('should filter out non-mention messages when trigger mode is disabled', () => {
    const messages: SimulatedFeishuMessage[] = [
      { chatId: 'oc_group', text: 'Hello everyone', senderOpenId: 'ou_user_a', isMention: false },
      { chatId: 'oc_group', text: '@bot help', senderOpenId: 'ou_user_b', isMention: true },
      { chatId: 'oc_group', text: 'Random chat', senderOpenId: 'ou_user_c', isMention: false },
    ];

    const filtered = filterMessages(messages, triggerManager);

    expect(filtered).toHaveLength(1);
    expect(filtered[0].text).toBe('@bot help');
  });

  it('should pass all messages when trigger mode is enabled', () => {
    triggerManager.setTriggerEnabled('oc_group', true);

    const messages: SimulatedFeishuMessage[] = [
      { chatId: 'oc_group', text: 'Hello everyone', senderOpenId: 'ou_user_a', isMention: false },
      { chatId: 'oc_group', text: '@bot help', senderOpenId: 'ou_user_b', isMention: true },
      { chatId: 'oc_group', text: 'Random chat', senderOpenId: 'ou_user_c', isMention: false },
    ];

    const filtered = filterMessages(messages, triggerManager);

    expect(filtered).toHaveLength(3);
  });

  it('should apply different trigger modes per chat independently', () => {
    triggerManager.setTriggerEnabled('oc_group_a', true);
    // oc_group_b stays default (trigger mode disabled)

    const messages: SimulatedFeishuMessage[] = [
      { chatId: 'oc_group_a', text: 'No mention', senderOpenId: 'ou_1', isMention: false },
      { chatId: 'oc_group_b', text: 'No mention', senderOpenId: 'ou_2', isMention: false },
      { chatId: 'oc_group_a', text: '@bot check', senderOpenId: 'ou_1', isMention: true },
      { chatId: 'oc_group_b', text: '@bot check', senderOpenId: 'ou_2', isMention: true },
    ];

    const filtered = filterMessages(messages, triggerManager);

    expect(filtered).toHaveLength(3);
    // oc_group_a: all 2 messages pass (trigger mode enabled)
    expect(filtered.filter((m) => m.chatId === 'oc_group_a')).toHaveLength(2);
    // oc_group_b: only 1 mention message passes
    expect(filtered.filter((m) => m.chatId === 'oc_group_b')).toHaveLength(1);
  });

  it('should auto-enable trigger mode for small groups (Issue #2052)', () => {
    // Small group: bot + 1 user = 2 members
    triggerManager.markAsSmallGroup('oc_dm_chat');

    const messages: SimulatedFeishuMessage[] = [
      { chatId: 'oc_dm_chat', text: 'Hi', senderOpenId: 'ou_user', isMention: false },
      { chatId: 'oc_dm_chat', text: '@bot status', senderOpenId: 'ou_user', isMention: true },
    ];

    const filtered = filterMessages(messages, triggerManager);

    // All messages pass (small group auto-enables trigger mode)
    expect(filtered).toHaveLength(2);
  });

  it('should load persisted trigger mode from records (Issue #2069)', () => {
    // Simulate startup: load from persisted records
    triggerManager.initFromRecords([
      { chatId: 'oc_persisted_chat', triggerMode: 'always' },
      { chatId: 'oc_mention_chat', triggerMode: 'mention' },
      { chatId: 'oc_legacy_chat', passiveMode: false }, // legacy format
    ]);

    const messages: SimulatedFeishuMessage[] = [
      { chatId: 'oc_persisted_chat', text: 'No mention', senderOpenId: 'ou_1', isMention: false },
      { chatId: 'oc_mention_chat', text: 'No mention', senderOpenId: 'ou_2', isMention: false },
      { chatId: 'oc_legacy_chat', text: 'No mention', senderOpenId: 'ou_3', isMention: false },
    ];

    const filtered = filterMessages(messages, triggerManager);

    // Only oc_persisted_chat and oc_legacy_chat pass (trigger mode enabled)
    expect(filtered).toHaveLength(2);
    expect(filtered[0].chatId).toBe('oc_persisted_chat');
    expect(filtered[1].chatId).toBe('oc_legacy_chat');
  });

  it('should keep small group trigger mode even when manually disabled', () => {
    triggerManager.markAsSmallGroup('oc_small_group');
    // User tries to disable trigger mode
    triggerManager.setTriggerEnabled('oc_small_group', false);

    // Small group status persists
    expect(triggerManager.isTriggerEnabled('oc_small_group')).toBe(true);

    const messages: SimulatedFeishuMessage[] = [
      { chatId: 'oc_small_group', text: 'Should pass', senderOpenId: 'ou_user', isMention: false },
    ];

    const filtered = filterMessages(messages, triggerManager);
    expect(filtered).toHaveLength(1);
  });
});

describeIfFeishu('Trigger mode + IPC integration', () => {
  let ipcServer: UnixSocketIpcServer;
  let ipcClient: UnixSocketIpcClient;
  let socketPath: string;
  let capturedMessages: Array<{ chatId: string; text: string }>;
  let triggerManager: TriggerModeManager;

  beforeEach(async () => {
    socketPath = generateSocketPath();
    capturedMessages = [];
    triggerManager = new TriggerModeManager();

    const container: ChannelHandlersContainer = {
      handlers: {
        sendMessage: async (chatId, text) => {
          capturedMessages.push({ chatId, text });
        },
        sendCard: async () => {},
        sendInteractive: async () => ({ messageId: 'om_trigger_test' }),
        uploadFile: async () => ({ fileKey: 'fk', fileType: 'file', fileName: 'f', fileSize: 0 }),
      },
    };

    const handler = createInteractiveMessageHandler(() => {}, container);
    ipcServer = new UnixSocketIpcServer(handler, { socketPath });
    ipcClient = new UnixSocketIpcClient({ socketPath, timeout: 5000 });

    await ipcServer.start();
    await ipcClient.connect();
  });

  afterEach(async () => {
    try {
      await ipcClient.disconnect();
      await ipcServer.stop();
    } finally {
      cleanupSocket(socketPath);
    }
  });

  it('should send IPC messages to both trigger-enabled and trigger-disabled chats', async () => {
    triggerManager.setTriggerEnabled('oc_trigger_on', true);

    // IPC send works regardless of trigger mode (trigger mode affects inbound filtering,
    // not outbound messaging)
    const result1 = await ipcClient.sendMessage('oc_trigger_on', 'Message to trigger-enabled chat');
    const result2 = await ipcClient.sendMessage('oc_trigger_off', 'Message to trigger-disabled chat');

    expect(result1.success).toBe(true);
    expect(result2.success).toBe(true);
    expect(capturedMessages).toHaveLength(2);
  });

  it('should send IPC interactive card to a trigger-mode-managed chat', async () => {
    triggerManager.setTriggerEnabled('oc_managed_chat', true);

    const result = await ipcClient.sendInteractive('oc_managed_chat', {
      question: 'Trigger mode is enabled. Confirm action?',
      options: [
        { text: 'Confirm', value: 'confirm', type: 'primary' },
        { text: 'Cancel', value: 'cancel' },
      ],
      actionPrompts: {
        confirm: '[用户操作] 用户确认了操作',
        cancel: '[用户操作] 用户取消了操作',
      },
    });

    expect(result.success).toBe(true);
  });

  it('should handle trigger mode state changes without affecting IPC transport', async () => {
    // Start with trigger mode enabled
    triggerManager.setTriggerEnabled('oc_dynamic', true);
    expect(triggerManager.isTriggerEnabled('oc_dynamic')).toBe(true);

    // Send IPC message
    const result1 = await ipcClient.sendMessage('oc_dynamic', 'Before disable');
    expect(result1.success).toBe(true);

    // Disable trigger mode
    triggerManager.setTriggerEnabled('oc_dynamic', false);
    expect(triggerManager.isTriggerEnabled('oc_dynamic')).toBe(false);

    // IPC still works (trigger mode doesn't affect outbound)
    const result2 = await ipcClient.sendMessage('oc_dynamic', 'After disable');
    expect(result2.success).toBe(true);

    expect(capturedMessages).toHaveLength(2);
  });
});
