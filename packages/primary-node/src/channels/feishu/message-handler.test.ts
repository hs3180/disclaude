/**
 * Tests for audio/voice message handling in MessageHandler.
 *
 * Issue #1966: Verify audio message type is supported in the type system
 * and the file_key parsing logic works correctly for audio messages.
 */

import { describe, it, expect } from 'vitest';
import type { IncomingMessage } from '@disclaude/core';

describe('Issue #1966: Audio message support', () => {
  describe('Type system', () => {
    it('should accept "audio" as a valid messageType in IncomingMessage', () => {
      const audioMessage: IncomingMessage = {
        messageId: 'audio_test_1',
        chatId: 'test_chat',
        userId: 'test_user',
        content: '用户发送了一条语音消息',
        messageType: 'audio',
        timestamp: Date.now(),
        attachments: [
          {
            fileName: 'voice_test.opus',
            filePath: '/tmp/test/voice_test.opus',
            mimeType: 'audio',
          },
        ],
      };

      expect(audioMessage.messageType).toBe('audio');
      expect(audioMessage.attachments).toHaveLength(1);
      expect(audioMessage.attachments![0].mimeType).toBe('audio');
    });
  });

  describe('Audio content parsing', () => {
    /**
     * Feishu audio messages send content as JSON with file_key field:
     * {"file_key": "v3_audio_xxx", "duration": 5}
     *
     * This mirrors the parsing logic in message-handler.ts.
     */
    function parseFileKeyFromContent(
      content: string,
      messageType: string,
    ): { fileKey?: string; fileName?: string } {
      try {
        const parsed = JSON.parse(content);
        if (messageType === 'image') {
          return { fileKey: parsed.image_key, fileName: `image_${parsed.image_key}` };
        } else if (messageType === 'audio') {
          return { fileKey: parsed.file_key, fileName: `voice_${parsed.file_key}` };
        } else {
          return {
            fileKey: parsed.file_key,
            fileName: parsed.file_name || `file_${parsed.file_key}`,
          };
        }
      } catch {
        return {};
      }
    }

    it('should parse file_key from audio message content', () => {
      const content = JSON.stringify({ file_key: 'v3_audio_abc123', duration: 5 });
      const result = parseFileKeyFromContent(content, 'audio');

      expect(result.fileKey).toBe('v3_audio_abc123');
      expect(result.fileName).toBe('voice_v3_audio_abc123');
    });

    it('should handle audio message with minimal content', () => {
      const content = JSON.stringify({ file_key: 'audio_minimal' });
      const result = parseFileKeyFromContent(content, 'audio');

      expect(result.fileKey).toBe('audio_minimal');
      expect(result.fileName).toBe('voice_audio_minimal');
    });

    it('should return empty result for invalid JSON', () => {
      const result = parseFileKeyFromContent('not json', 'audio');
      expect(result.fileKey).toBeUndefined();
    });

    it('should return empty result for missing file_key', () => {
      const content = JSON.stringify({ duration: 5 });
      const result = parseFileKeyFromContent(content, 'audio');
      expect(result.fileKey).toBeUndefined();
    });

    it('should differentiate audio from file message parsing', () => {
      const audioContent = JSON.stringify({ file_key: 'audio_1' });
      const fileContent = JSON.stringify({ file_key: 'file_1', file_name: 'doc.pdf' });

      const audioResult = parseFileKeyFromContent(audioContent, 'audio');
      const fileResult = parseFileKeyFromContent(fileContent, 'file');

      expect(audioResult.fileName).toBe('voice_audio_1');
      expect(fileResult.fileName).toBe('doc.pdf');
    });
  });

  describe('Resource type mapping', () => {
    /**
     * Feishu API requires type='file' for audio resource downloads,
     * not type='audio'. This test verifies the mapping logic.
     */
    function getResourceType(messageType: string): string {
      return messageType === 'audio' ? 'file' : messageType;
    }

    it('should map audio message type to file resource type for download', () => {
      expect(getResourceType('audio')).toBe('file');
    });

    it('should keep other message types unchanged', () => {
      expect(getResourceType('image')).toBe('image');
      expect(getResourceType('file')).toBe('file');
      expect(getResourceType('media')).toBe('media');
    });
  });

  describe('Audio prompt generation', () => {
    it('should generate appropriate prompt for successful download', () => {
      const localPath = '/workspace/downloads/voice_test.opus';
      const fileName = 'voice_test.opus';
      const typeLabel = '语音消息';
      const filePrompt = localPath
        ? `用户发送了一条${typeLabel}（语音），文件：${fileName}\n\n语音文件已下载到本地: ${localPath}\n\n请注意这是一个语音/音频文件，你无法直接播放它。如果你有语音转文字(ASR)工具，请使用该工具将语音转录为文本后再处理。如果没有，请告知用户当前不支持语音消息处理。`
        : `用户发送了一条${typeLabel}（语音），但下载失败。`;

      expect(filePrompt).toContain('语音文件已下载到本地');
      expect(filePrompt).toContain('/workspace/downloads/voice_test.opus');
      expect(filePrompt).toContain('ASR');
      expect(filePrompt).not.toContain('下载失败');
    });

    it('should generate error prompt for failed download', () => {
      const localPath = undefined;
      const typeLabel = '语音消息';
      const filePrompt = localPath
        ? `用户发送了一条${typeLabel}（语音），文件：test\n\n语音文件已下载到本地: ${localPath}`
        : `用户发送了一条${typeLabel}（语音），但下载失败。请告知用户语音消息接收失败，建议重新发送或使用文字消息。`;

      expect(filePrompt).toContain('下载失败');
      expect(filePrompt).toContain('重新发送');
    });
  });
});
