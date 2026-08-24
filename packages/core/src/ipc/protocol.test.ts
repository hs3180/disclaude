/**
 * Unit tests for IPC Protocol
 *
 * Issue #4168 (Phase 3 residual): the Unix-socket config surface
 * (DEFAULT_IPC_CONFIG / generateSocketPath / IpcConfig) and the wire-frame
 * types (IpcRequest / IpcResponse) are gone with the transport — this file
 * now covers the payload surface the REST client + facade still share.
 */

import { describe, it, expect } from 'vitest';
import type {
  IpcRequestPayloads,
  IpcResponsePayloads,
} from './protocol.js';

describe('IPC Protocol payload surface', () => {
  it('response payloads for messaging methods carry success', () => {
    const sendMessage: IpcResponsePayloads['sendMessage'] = { success: true };
    const sendCard: IpcResponsePayloads['sendCard'] = { success: true };
    const pushToAgent: IpcResponsePayloads['pushToAgent'] = { success: true };
    expect(sendMessage.success).toBe(true);
    expect(sendCard.success).toBe(true);
    expect(pushToAgent.success).toBe(true);
  });

  it('uploadFile response carries the uploaded-file descriptor', () => {
    const uploadFile: IpcResponsePayloads['uploadFile'] = {
      success: true,
      fileKey: 'fk',
      fileType: 'file',
      fileName: 'a.pdf',
      fileSize: 1,
    };
    expect(uploadFile.fileKey).toBe('fk');
  });

  it('sendInteractive request carries the raw card params', () => {
    const payload: IpcRequestPayloads['sendInteractive'] = {
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
    const payload: IpcRequestPayloads['markChatResponded'] = {
      chatId: 'oc_1',
      response: { selectedValue: 'v', responder: 'u', repliedAt: '2026-08-24T00:00:00Z' },
    };
    expect(payload.response.responder).toBe('u');
  });
});
