/**
 * P0 Integration test: IPC sendInteractive complete chain.
 *
 * Tests the full pipeline:
 *   IPC Client.sendInteractive()  →  IPC Server  →  Mock sendInteractive handler
 *   →  registerActionPrompts callback  →  InteractiveContextStore  →  generatePrompt
 *
 * This test verifies the end-to-end flow that a real Feishu card action callback
 * would exercise: card sent → prompts registered → callback resolves prompt.
 *
 * Run with: FEISHU_INTEGRATION_TEST=true npx vitest --run packages/primary-node/src/__tests__/integration/feishu
 *
 * @see Issue #1626
 * @see Issue #1570 — sendInteractive IPC flow
 * @see Issue #1572 — InteractiveContextStore migration
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  UnixSocketIpcServer,
  UnixSocketIpcClient,
  createInteractiveMessageHandler,
  type ChannelHandlersContainer,
} from '@disclaude/core';
import { InteractiveContextStore } from '../../../interactive-context.js';
import { describeIfFeishu, generateSocketPath, cleanupSocket } from './helpers.js';

describeIfFeishu('IPC sendInteractive end-to-end chain', () => {
  let server: UnixSocketIpcServer;
  let client: UnixSocketIpcClient;
  let socketPath: string;
  let store: InteractiveContextStore;

  beforeEach(async () => {
    socketPath = generateSocketPath();
    store = new InteractiveContextStore();

    // Build a channel handlers container with a mock sendInteractive
    const container: ChannelHandlersContainer = {
      handlers: {
        sendMessage: async () => {},
        sendCard: async () => {},
        sendInteractive: async (_chatId, params) => {
          // Simulate Feishu returning a messageId based on the first option
          return { messageId: `om_${params.options[0]?.value ?? 'unknown'}` };
        },
        uploadFile: async () => ({ fileKey: 'fk', fileType: 'file', fileName: 'f', fileSize: 0 }),
      },
    };

    // Create handler that registers prompts into our InteractiveContextStore
    const handler = createInteractiveMessageHandler(
      (messageId, chatId, actionPrompts) => {
        store.register(messageId, chatId, actionPrompts);
      },
      container,
    );

    server = new UnixSocketIpcServer(handler, { socketPath });
    client = new UnixSocketIpcClient({ socketPath, timeout: 5000 });

    await server.start();
    await client.connect();
  });

  afterEach(async () => {
    await client.disconnect();
    await server.stop();
    cleanupSocket(socketPath);
    store.clear();
  });

  it('should send card, register actionPrompts, and resolve callback', async () => {
    const actionPrompts = {
      confirm: '[用户操作] 用户选择了「{{actionText}}」',
      cancel: '[用户操作] 用户取消了操作',
    };

    // Step 1: Send interactive card through IPC
    const result = await client.sendInteractive('oc_test_chat', {
      question: '确认部署到生产环境？',
      options: [
        { text: '确认', value: 'confirm', type: 'primary' },
        { text: '取消', value: 'cancel' },
      ],
      title: '部署确认',
      context: '生产环境部署需要审批',
      actionPrompts,
    });

    expect(result.success).toBe(true);
    expect(result.messageId).toBe('om_confirm');
    expect(store.size).toBe(1);

    // Step 2: Verify action prompts were registered in the store
    const registered = store.getActionPrompts('om_confirm');
    expect(registered).toEqual(actionPrompts);

    // Step 3: Simulate Feishu card callback — user clicks "confirm"
    const prompt = store.generatePrompt('om_confirm', 'oc_test_chat', 'confirm', '确认');
    expect(prompt).toBe('[用户操作] 用户选择了「确认」');

    // Step 4: Simulate Feishu card callback — user clicks "cancel"
    const cancelPrompt = store.generatePrompt('om_confirm', 'oc_test_chat', 'cancel', '取消');
    expect(cancelPrompt).toBe('[用户操作] 用户取消了操作');
  });

  it('should handle card callback with unknown messageId via chatId fallback', async () => {
    const actionPrompts = {
      approve: '[用户操作] 用户审批通过了',
    };

    await client.sendInteractive('oc_chat_fallback', {
      question: '审批请求',
      options: [{ text: '通过', value: 'approve', type: 'primary' }],
      actionPrompts,
    });

    // Simulate Feishu callback with a DIFFERENT messageId than what we registered
    // (this happens in production when Feishu assigns a real messageId)
    const prompt = store.generatePrompt('real_feishu_msg_id', 'oc_chat_fallback', 'approve', '通过');
    expect(prompt).toBe('[用户操作] 用户审批通过了');
  });

  it('should support sending multiple cards to different chats', async () => {
    // Send card to chat A
    const resultA = await client.sendInteractive('oc_chat_a', {
      question: 'Chat A question?',
      options: [{ text: 'Yes', value: 'a_yes' }],
      actionPrompts: { a_yes: 'Chat A: yes' },
    });

    // Send card to chat B
    const resultB = await client.sendInteractive('oc_chat_b', {
      question: 'Chat B question?',
      options: [{ text: 'No', value: 'b_no' }],
      actionPrompts: { b_no: 'Chat B: no' },
    });

    expect(resultA.success).toBe(true);
    expect(resultB.success).toBe(true);
    expect(store.size).toBe(2);

    // Each chat should resolve independently
    const promptA = store.generatePrompt('unknown', 'oc_chat_a', 'a_yes');
    expect(promptA).toBe('Chat A: yes');

    const promptB = store.generatePrompt('unknown', 'oc_chat_b', 'b_no');
    expect(promptB).toBe('Chat B: no');
  });

  it('should return error when sendInteractive handler is not available', async () => {
    // Create a server WITHOUT channel handlers
    const emptySocketPath = generateSocketPath();
    const emptyContainer: ChannelHandlersContainer = { handlers: undefined };
    const emptyHandler = createInteractiveMessageHandler(() => {}, emptyContainer);
    const emptyServer = new UnixSocketIpcServer(emptyHandler, { socketPath: emptySocketPath });
    const emptyClient = new UnixSocketIpcClient({ socketPath: emptySocketPath, timeout: 2000 });

    await emptyServer.start();
    await emptyClient.connect();

    const result = await emptyClient.sendInteractive('oc_test', {
      question: 'Q?',
      options: [{ text: 'A', value: 'a' }],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('not available');

    await emptyClient.disconnect();
    await emptyServer.stop();
    cleanupSocket(emptySocketPath);
  });

  it('should pass threadId through the IPC chain', async () => {
    let capturedThreadId: string | undefined;

    const threadSocketPath = generateSocketPath();
    const threadContainer: ChannelHandlersContainer = {
      handlers: {
        sendMessage: async () => {},
        sendCard: async () => {},
        sendInteractive: async (_chatId, params) => {
          capturedThreadId = params.threadId;
          return { messageId: 'om_thread_test' };
        },
        uploadFile: async () => ({ fileKey: '', fileType: 'file', fileName: 'f', fileSize: 0 }),
      },
    };
    const threadHandler = createInteractiveMessageHandler(
      (messageId, chatId, actionPrompts) => {
        store.register(messageId, chatId, actionPrompts);
      },
      threadContainer,
    );
    const threadServer = new UnixSocketIpcServer(threadHandler, { socketPath: threadSocketPath });
    const threadClient = new UnixSocketIpcClient({ socketPath: threadSocketPath, timeout: 2000 });

    await threadServer.start();
    await threadClient.connect();

    await threadClient.sendInteractive('oc_test', {
      question: 'Threaded question?',
      options: [{ text: 'Reply', value: 'reply' }],
      threadId: 'parent_msg_123',
      actionPrompts: { reply: 'User replied in thread' },
    });

    expect(capturedThreadId).toBe('parent_msg_123');

    await threadClient.disconnect();
    await threadServer.stop();
    cleanupSocket(threadSocketPath);
  });
});
