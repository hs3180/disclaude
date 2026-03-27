/**
 * P0 Integration Test: IPC sendInteractive complete flow.
 *
 * Tests the full sendInteractive pipeline:
 * 1. Build an interactive card using the production card builder
 * 2. Send the card via real Feishu API (im.message.create)
 * 3. Register action prompts in InteractiveContextStore
 * 4. Verify callback prompt resolution
 *
 * **Prerequisites:**
 * - `FEISHU_INTEGRATION_TEST=true`
 * - `FEISHU_APP_ID` / `FEISHU_APP_SECRET` (Feishu app credentials)
 * - `FEISHU_TEST_CHAT_ID` (group chat for test messages)
 *
 * @see Issue #1626 - Optional Feishu integration tests
 * @see Issue #1570 - sendInteractive IPC flow
 */

import { it, expect, beforeAll, afterAll } from 'vitest';
import * as lark from '@larksuiteoapi/node-sdk';
import { InteractiveContextStore } from '../../../interactive-context.js';
import { buildInteractiveCard, buildActionPrompts } from '../../../platforms/feishu/card-builders/index.js';
import {
  describeIfFeishu,
  allowFeishuNetwork,
  blockFeishuNetwork,
  getFeishuAppId,
  getFeishuAppSecret,
  getTestChatId,
  generateTestMarker,
} from './helpers.js';

describeIfFeishu('Feishu Integration: sendInteractive complete flow', () => {
  let client: lark.Client;
  let store: InteractiveContextStore;
  let testChatId: string;
  let testMarker: string;

  beforeAll(() => {
    allowFeishuNetwork();

    const appId = getFeishuAppId();
    const appSecret = getFeishuAppSecret();
    testChatId = getTestChatId();
    testMarker = generateTestMarker();

    // Create a real Feishu SDK client
    client = new lark.Client({
      appId,
      appSecret,
      appType: lark.AppType.SelfBuild,
    });

    store = new InteractiveContextStore();
  });

  afterAll(() => {
    blockFeishuNetwork();
    store.clear();
  });

  it('should send an interactive card via real Feishu API and register action prompts', async () => {
    const options = [
      { text: 'Confirm', value: 'confirm', type: 'primary' as const },
      { text: 'Cancel', value: 'cancel' },
      { text: 'Retry', value: 'retry', type: 'danger' as const },
    ];

    // Step 1: Build the card using production card builder
    const card = buildInteractiveCard({
      question: `${testMarker} Integration test: choose an option`,
      options,
      title: 'Integration Test',
      context: 'This is an automated integration test. Safe to ignore.',
    });

    // Step 2: Send the card via real Feishu API
    const response = await client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: testChatId,
        msg_type: 'interactive',
        content: JSON.stringify(card),
      },
    });

    // Step 3: Verify the API response
    expect(response).toBeDefined();
    expect(response).not.toBeNull();
    // The real messageId from Feishu (om_xxx format)
    const realMessageId = response?.data?.message_id;
    expect(realMessageId).toBeDefined();
    expect(typeof realMessageId).toBe('string');

    // Step 4: Register action prompts in InteractiveContextStore
    const actionPrompts = buildActionPrompts(options);
    // Simulate what the IPC handler does: use synthetic messageId
    const syntheticMessageId = `interactive_${testChatId}_${Date.now()}`;
    store.register(syntheticMessageId, testChatId, actionPrompts);

    // Step 5: Verify action prompts are registered
    const registeredPrompts = store.getActionPrompts(syntheticMessageId);
    expect(registeredPrompts).toEqual(actionPrompts);

    // Step 6: Verify callback resolution via chatId fallback
    // Simulate a Feishu callback with the real messageId (different from synthetic)
    const prompt = store.generatePrompt(realMessageId!, testChatId, 'confirm', 'Confirm');
    expect(prompt).toBeDefined();
    expect(prompt).toContain('Confirm');
  });

  it('should generate default action prompts when none provided', () => {
    const options = [
      { text: 'Option A', value: 'opt_a' },
      { text: 'Option B', value: 'opt_b', type: 'primary' as const },
    ];

    const prompts = buildActionPrompts(options);

    // Each option should have a corresponding prompt
    expect(prompts.opt_a).toBeDefined();
    expect(prompts.opt_b).toBeDefined();
    expect(typeof prompts.opt_a).toBe('string');
    expect(typeof prompts.opt_b).toBe('string');
  });

  it('should build a valid interactive card structure', () => {
    const card = buildInteractiveCard({
      question: 'Test question',
      options: [
        { text: 'Yes', value: 'yes', type: 'primary' as const },
        { text: 'No', value: 'no' },
      ],
      title: 'Test Title',
    });

    // Card should be a valid object with expected structure
    expect(card).toBeDefined();
    expect(card.config).toBeDefined();
    expect(card.header).toBeDefined();
    // The card should have elements (question + buttons)
    expect(card.elements).toBeDefined();
    expect(Array.isArray(card.elements)).toBe(true);
    expect(card.elements.length).toBeGreaterThan(0);
  });

  it('should handle action prompt template replacement with store', () => {
    const customPrompts = {
      confirm: '[用户操作] 用户选择了「{{actionText}}」',
      cancel: '[用户操作] 用户取消了操作 ({{actionValue}})',
      details: 'Type: {{actionType}}, Value: {{actionValue}}',
    };

    store.register('test-msg-template', testChatId, customPrompts);

    // Test with actionText
    const confirmPrompt = store.generatePrompt('test-msg-template', testChatId, 'confirm', '确认提交');
    expect(confirmPrompt).toBe('[用户操作] 用户选择了「确认提交」');

    // Test with actionValue only
    const cancelPrompt = store.generatePrompt('test-msg-template', testChatId, 'cancel');
    expect(cancelPrompt).toBe('[用户操作] 用户取消了操作 (cancel)');

    // Test with actionType
    const detailsPrompt = store.generatePrompt('test-msg-template', testChatId, 'details', undefined, 'button');
    expect(detailsPrompt).toBe('Type: button, Value: details');

    // Cleanup
    store.unregister('test-msg-template');
  });
});
