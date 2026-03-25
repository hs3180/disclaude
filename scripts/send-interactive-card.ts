#!/usr/bin/env npx tsx
/**
 * Send an interactive card to a Feishu chat via IPC.
 *
 * Usage:
 *   npx tsx scripts/send-interactive-card.ts
 */

import { getIpcClient } from '../packages/core/src/ipc/unix-socket-client.js';

async function main() {
  const chatId = 'test-use-case-2-text-53258';
  const parentMessageId = '5e27aaf9-8448-4ae3-93c8-9cc4c244e932';

  // Build the interactive card
  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '接下来您可以...' },
      template: 'blue',
    },
    elements: [
      {
        tag: 'markdown',
        content: '✅ 已完成一句话总结',
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '详细解释AI' },
            type: 'primary',
            value: 'explain_ai',
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: 'AI的应用领域' },
            value: 'ai_applications',
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: 'AI发展历史' },
            value: 'ai_history',
          },
        ],
      },
    ],
  };

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

    console.log('IPC available, sending card...');

    // First send the card
    const cardResult = await ipcClient.sendCard(
      chatId,
      card,
      parentMessageId,
      'Interactive card with action buttons'
    );

    if (!cardResult.success) {
      console.error('Failed to send card:', cardResult.error);
      process.exit(1);
    }

    console.log('Card sent successfully! Message ID:', cardResult.messageId);

    // Register action prompts if we got a message ID
    if (cardResult.messageId) {
      console.log('Registering action prompts...');
      const registerResult = await ipcClient.request('registerActionPrompts', {
        messageId: cardResult.messageId,
        chatId,
        actionPrompts,
      });

      if (registerResult.success) {
        console.log('Action prompts registered successfully!');
      } else {
        console.error('Failed to register action prompts');
      }
    }

    console.log('Done!');
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

main();
