/** Tests for Channel API request and response payloads. */

import { describe, it, expect } from 'vitest';
import type {
  ChannelApiRequestPayloads,
  ChannelApiResponsePayloads,
} from './protocol.js';

describe('REST API Protocol payload surface', () => {
  it('response payloads for messaging methods carry success', () => {
    const sendMessage: ChannelApiResponsePayloads['sendMessage'] = { success: true };
    const sendCard: ChannelApiResponsePayloads['sendCard'] = { success: true };
    const pushToAgent: ChannelApiResponsePayloads['pushToAgent'] = { success: true };
    expect(sendMessage.success).toBe(true);
    expect(sendCard.success).toBe(true);
    expect(pushToAgent.success).toBe(true);
  });

  it('uploadFile response carries the uploaded-file descriptor', () => {
    const uploadFile: ChannelApiResponsePayloads['uploadFile'] = {
      success: true,
      fileKey: 'fk',
      fileType: 'file',
      fileName: 'a.pdf',
      fileSize: 1,
    };
    expect(uploadFile.fileKey).toBe('fk');
  });

  it('sendInteractive request carries the raw card params', () => {
    const payload: ChannelApiRequestPayloads['sendInteractive'] = {
      chatId: 'oc_1',
      question: 'q',
      options: [{ text: 't', value: 'v', type: 'primary' }],
      title: 'T',
      actionPrompts: { v: 'do it' },
    };
    expect(payload.options[0]?.type).toBe('primary');
    expect(payload.actionPrompts?.v).toBe('do it');
  });

  it('markChatResponded request carries the responder record', () => {
    const payload: ChannelApiRequestPayloads['markChatResponded'] = {
      chatId: 'oc_1',
      response: { selectedValue: 'v', responder: 'u', repliedAt: '2026-08-24T00:00:00Z' },
    };
    expect(payload.response.responder).toBe('u');
  });
});
