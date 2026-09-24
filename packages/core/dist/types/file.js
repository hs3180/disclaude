/**
 * Unified file transfer types.
 *
 * This module consolidates file-related types from across the codebase.
 *
 * @see Issue #194 - Refactor: 统一文件传输系统架构
 */
import { v4 as uuidv4 } from 'uuid';
/**
 * Factory function to create a FileRef.
 */
export function createFileRef(fileName, source, options) {
    const now = Date.now();
    return {
        id: uuidv4(),
        fileName,
        mimeType: options?.mimeType,
        size: options?.size,
        source,
        localPath: options?.localPath,
        platformKey: options?.platformKey,
        createdAt: now,
        expiresAt: options?.expiresInMs ? now + options.expiresInMs : undefined,
    };
}
/**
 * Factory function to create an InboundAttachment.
 */
export function createInboundAttachment(fileName, chatId, fileType, options) {
    const fileRef = createFileRef(fileName, 'user', {
        ...options,
        chatId,
        fileType,
    });
    return {
        ...fileRef,
        source: 'user',
        chatId,
        messageId: options?.messageId,
        fileType,
    };
}
/**
 * Factory function to create an OutboundFile.
 */
export function createOutboundFile(fileName, options) {
    const fileRef = createFileRef(fileName, 'agent', options);
    return {
        ...fileRef,
        source: 'agent',
        chatId: options?.chatId,
        threadId: options?.threadId,
    };
}
