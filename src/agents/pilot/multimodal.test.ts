/**
 * Tests for multimodal message handling in Pilot agent.
 *
 * Issue #808: Test native multimodal model support in disclaude.
 *
 * Test scenarios:
 * 1. Single image with text query
 * 2. Multiple images for comparison
 * 3. Image + text mixed message
 * 4. Screenshot for code explanation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageBuilder } from './message-builder.js';
import type { FileRef } from '../../file-transfer/types.js';

// Mock config
vi.mock('../../config/index.js', () => ({
  Config: {
    getMcpServersConfig: vi.fn(() => ({
      '4_5v_mcp': { command: 'test-command' },
    })),
    getWorkspaceDir: vi.fn(() => '/workspace'),
    getSkillsDir: vi.fn(() => '/skills'),
  },
}));

describe('Multimodal Message Handling (Issue #808)', () => {
  let messageBuilder: MessageBuilder;

  beforeEach(() => {
    messageBuilder = new MessageBuilder();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Helper to create image FileRef
   */
  const createImageAttachment = (
    fileName: string,
    mimeType: string = 'image/png',
    size: number = 102400
  ): FileRef => ({
    id: `test-id-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    fileName,
    mimeType,
    size,
    localPath: `/tmp/workspace/attachments/${fileName}`,
    source: 'user',
    createdAt: Date.now(),
  });

  describe('Scenario 1: Single image with text query', () => {
    it('should properly format message with single image attachment', () => {
      const imageAttachment = createImageAttachment('screenshot.png', 'image/png');
      const userText = '这张图片里有什么？';

      const result = messageBuilder.buildEnhancedContent({
        text: userText,
        messageId: 'msg-123',
        senderOpenId: 'user-456',
        attachments: [imageAttachment],
      }, 'chat-789');

      // Should include user's text
      expect(result).toContain(userText);

      // Should include attachment info
      expect(result).toContain('Attachments');
      expect(result).toContain('screenshot.png');
      expect(result).toContain(imageAttachment.localPath);
      expect(result).toContain('image/png');

      // Should include image analyzer hint
      expect(result).toContain('## 🖼️ Image Analysis Required');
      expect(result).toContain('mcp__4_5v_mcp__analyze_image');
    });

    it('should handle JPEG image', () => {
      const jpegAttachment = createImageAttachment('photo.jpg', 'image/jpeg', 2048000);
      const userText = '请分析这张照片';

      const result = messageBuilder.buildEnhancedContent({
        text: userText,
        messageId: 'msg-123',
        attachments: [jpegAttachment],
      }, 'chat-789');

      expect(result).toContain('photo.jpg');
      expect(result).toContain('image/jpeg');
      // Size is displayed in KB (2000.0 KB for 2 MB)
      expect(result).toContain('2000.0 KB');
    });

    it('should handle GIF image', () => {
      const gifAttachment = createImageAttachment('animation.gif', 'image/gif');
      const userText = '这个动图是什么内容？';

      const result = messageBuilder.buildEnhancedContent({
        text: userText,
        messageId: 'msg-123',
        attachments: [gifAttachment],
      }, 'chat-789');

      expect(result).toContain('animation.gif');
      expect(result).toContain('image/gif');
    });

    it('should handle WebP image', () => {
      const webpAttachment = createImageAttachment('modern-image.webp', 'image/webp');
      const userText = 'Describe this image';

      const result = messageBuilder.buildEnhancedContent({
        text: userText,
        messageId: 'msg-123',
        attachments: [webpAttachment],
      }, 'chat-789');

      expect(result).toContain('modern-image.webp');
      expect(result).toContain('image/webp');
    });
  });

  describe('Scenario 2: Multiple images for comparison', () => {
    it('should properly format message with multiple image attachments', () => {
      const attachments: FileRef[] = [
        createImageAttachment('design-v1.png', 'image/png'),
        createImageAttachment('design-v2.png', 'image/png'),
      ];
      const userText = '请对比这两个设计稿，告诉我哪个更好';

      const result = messageBuilder.buildEnhancedContent({
        text: userText,
        messageId: 'msg-123',
        senderOpenId: 'user-456',
        attachments,
      }, 'chat-789');

      // Should include user's text
      expect(result).toContain(userText);

      // Should list all attachments
      expect(result).toContain('design-v1.png');
      expect(result).toContain('design-v2.png');

      // Should show attachment count
      expect(result).toContain('2 file(s)');

      // Should include image analyzer hint
      expect(result).toContain('## 🖼️ Image Analysis Required');
    });

    it('should handle multiple images with different formats', () => {
      const attachments: FileRef[] = [
        createImageAttachment('screenshot.png', 'image/png'),
        createImageAttachment('photo.jpg', 'image/jpeg'),
      ];
      const userText = 'Compare these two images';

      const result = messageBuilder.buildEnhancedContent({
        text: userText,
        messageId: 'msg-123',
        attachments,
      }, 'chat-789');

      expect(result).toContain('screenshot.png');
      expect(result).toContain('photo.jpg');
      expect(result).toContain('image/png');
      expect(result).toContain('image/jpeg');
    });

    it('should handle three or more images', () => {
      const attachments: FileRef[] = [
        createImageAttachment('ui-1.png', 'image/png'),
        createImageAttachment('ui-2.png', 'image/png'),
        createImageAttachment('ui-3.png', 'image/png'),
      ];
      const userText = 'Compare all three UI designs';

      const result = messageBuilder.buildEnhancedContent({
        text: userText,
        messageId: 'msg-123',
        attachments,
      }, 'chat-789');

      expect(result).toContain('3 file(s)');
      expect(result).toContain('ui-1.png');
      expect(result).toContain('ui-2.png');
      expect(result).toContain('ui-3.png');
    });
  });

  describe('Scenario 3: Image + text mixed message', () => {
    it('should handle image with detailed text context', () => {
      const imageAttachment = createImageAttachment('dashboard.png', 'image/png');
      const userText = `我上传了一张仪表盘截图，请帮我：
1. 分析当前的数据趋势
2. 找出异常值
3. 给出改进建议

这是上周的销售数据。`;

      const result = messageBuilder.buildEnhancedContent({
        text: userText,
        messageId: 'msg-123',
        senderOpenId: 'user-456',
        attachments: [imageAttachment],
      }, 'chat-789');

      // Should preserve all text content
      expect(result).toContain('仪表盘截图');
      expect(result).toContain('分析当前的数据趋势');
      expect(result).toContain('找出异常值');
      expect(result).toContain('给出改进建议');

      // Should include attachment info
      expect(result).toContain('dashboard.png');
    });

    it('should handle image with code snippet in text', () => {
      const imageAttachment = createImageAttachment('error-screenshot.png', 'image/png');
      const userText = `这是错误截图。相关代码：

\`\`\`typescript
const data = JSON.parse(response);
console.log(data.value);
\`\`\`

为什么会报错？`;

      const result = messageBuilder.buildEnhancedContent({
        text: userText,
        messageId: 'msg-123',
        attachments: [imageAttachment],
      }, 'chat-789');

      expect(result).toContain('错误截图');
      expect(result).toContain('JSON.parse');
      expect(result).toContain('error-screenshot.png');
    });
  });

  describe('Scenario 4: Screenshot for code explanation', () => {
    it('should handle code screenshot for explanation', () => {
      const screenshotAttachment = createImageAttachment('code-screenshot.png', 'image/png');
      const userText = '这是我的代码截图，请解释这段代码的作用';

      const result = messageBuilder.buildEnhancedContent({
        text: userText,
        messageId: 'msg-123',
        senderOpenId: 'user-456',
        attachments: [screenshotAttachment],
      }, 'chat-789');

      expect(result).toContain(userText);
      expect(result).toContain('code-screenshot.png');
      expect(result).toContain('analyze_image');
    });

    it('should handle error screenshot for debugging', () => {
      const errorScreenshot = createImageAttachment('error-message.png', 'image/png');
      const userText = '这个错误怎么解决？';

      const result = messageBuilder.buildEnhancedContent({
        text: userText,
        messageId: 'msg-123',
        attachments: [errorScreenshot],
      }, 'chat-789');

      expect(result).toContain('error-message.png');
      expect(result).toContain(userText);
    });

    it('should handle UI mockup screenshot', () => {
      const mockupAttachment = createImageAttachment('ui-mockup.png', 'image/png');
      const userText = '根据这个 UI 设计稿，生成对应的 HTML/CSS 代码';

      const result = messageBuilder.buildEnhancedContent({
        text: userText,
        messageId: 'msg-123',
        attachments: [mockupAttachment],
      }, 'chat-789');

      expect(result).toContain('ui-mockup.png');
      expect(result).toContain('HTML/CSS');
    });
  });

  describe('Image type detection', () => {
    it('should correctly identify image types', async () => {
      const { Config } = await import('../../config/index.js');
      vi.mocked(Config.getMcpServersConfig).mockReturnValue({
        '4_5v_mcp': { command: 'test-command' },
      } as any);

      const imageTypes = [
        { mimeType: 'image/png', fileName: 'test.png' },
        { mimeType: 'image/jpeg', fileName: 'test.jpg' },
        { mimeType: 'image/gif', fileName: 'test.gif' },
        { mimeType: 'image/webp', fileName: 'test.webp' },
        { mimeType: 'image/svg+xml', fileName: 'test.svg' },
        { mimeType: 'image/bmp', fileName: 'test.bmp' },
      ];

      for (const { mimeType, fileName } of imageTypes) {
        const attachment = createImageAttachment(fileName, mimeType);
        const result = messageBuilder.buildEnhancedContent({
          text: 'Test',
          messageId: 'msg-123',
          attachments: [attachment],
        }, 'chat-789');

        expect(result).toContain('## 🖼️ Image Analysis Required');
        expect(result).toContain(mimeType);
      }
    });

    it('should not show image hint for non-image files', async () => {
      const { Config } = await import('../../config/index.js');
      vi.mocked(Config.getMcpServersConfig).mockReturnValue({
        '4_5v_mcp': { command: 'test-command' },
      } as any);

      const pdfAttachment: FileRef = {
        id: 'test-id',
        fileName: 'document.pdf',
        mimeType: 'application/pdf',
        size: 1024000,
        localPath: '/tmp/document.pdf',
        source: 'user',
        createdAt: Date.now(),
      };

      const result = messageBuilder.buildEnhancedContent({
        text: 'Read this document',
        messageId: 'msg-123',
        attachments: [pdfAttachment],
      }, 'chat-789');

      expect(result).not.toContain('## 🖼️ Image Analysis Required');
      expect(result).toContain('document.pdf');
    });
  });

  describe('File size formatting', () => {
    it('should format file sizes correctly', () => {
      const testCases = [
        { size: 512, expected: '0.5 KB' },
        { size: 1024, expected: '1.0 KB' },
        { size: 15360, expected: '15.0 KB' },
        { size: 1048576, expected: '1024.0 KB' }, // 1 MB shown as KB
      ];

      for (const { size, expected } of testCases) {
        const attachment = createImageAttachment('test.png', 'image/png', size);
        const result = messageBuilder.buildEnhancedContent({
          text: 'Test',
          messageId: 'msg-123',
          attachments: [attachment],
        }, 'chat-789');

        expect(result).toContain(expected);
      }
    });
  });
});
