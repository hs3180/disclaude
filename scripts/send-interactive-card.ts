#!/usr/bin/env npx tsx
/**
 * Send an interactive card to a Feishu chat via IPC.
 *
 * Usage:
 *   npx tsx scripts/send-interactive-card.ts
 *
 * Updated (Issue #1614): Replaced raw `sendCard` + `registerActionPrompts`
 * two-step flow with a single typed `sendInteractive` IPC call.
 */

import { getIpcClient } from '../packages/core/src/ipc/unix-socket-client.js';

async function main() {
  const chatId = 'test-use-case-2-text-53258';
  const parentMessageId = '5e27aaf9-8448-4ae3-93c8-9cc4c244e932';

  // Action prompts mapping
  const actionPrompts = {
    explain_ai: '请详细解释什么是人工智能(AI)，包括它的定义、核心概念和工作原理。',
    ai_applications: '请介绍人工智能的主要应用领域，并举一些实际例子。',
    ai_history: '请介绍人工智能的发展历史，包括重要的里程碑事件。',
  };

  console.log('Connecting to IPC server...');
  const ipcClient = getIpcClient();

  try {
    // Check availability first
    const availability = await ipcClient.checkAvailability();
    if (!availability.available) {
      console.error('IPC not available:', availability.reason);
      process.exit(1);
    }

    console.log('IPC available, sending interactive card...');

    // Use typed sendInteractive convenience method for better error handling
    const result = await ipcClient.sendInteractive(chatId, {
      question: '已完成一句话总结',
      options: [
        { text: '详细解释AI', value: 'explain_ai', type: 'primary' },
        { text: 'AI的应用领域', value: 'ai_applications' },
        { text: 'AI发展历史', value: 'ai_history' },
      ],
      title: '接下来您可以...',
      threadId: parentMessageId,
      actionPrompts,
    });

    if (!result.success) {
      console.error('Failed to send interactive card:', result.error);
      process.exit(1);
    }

    console.log('Interactive card sent successfully!');
    console.log('Message ID:', result.messageId);
    console.log('Done!');
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

main();
