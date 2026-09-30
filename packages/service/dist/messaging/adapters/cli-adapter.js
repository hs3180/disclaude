/**
 * CLI Channel Adapter - Converts UMF to console output.
 *
 * This adapter handles message conversion and output for CLI mode.
 * It converts Universal Message Format to human-readable text for console.
 *
 * Issue #515: Universal Message Format + Channel Adapters (Phase 2)
 */
import { createLogger } from "../../../../core/dist/index.js";
import { cardToText } from '../channel-adapter.js';
const logger = createLogger('CliAdapter');
/**
 * CLI Adapter - Converts UMF to text and outputs to console.
 */
export class CliAdapter {
    name = 'cli';
    capabilities = {
        supportsCard: false,
        supportsThread: false,
        supportsFile: false,
        supportsMarkdown: true,
        maxMessageLength: Infinity,
        supportedContentTypes: ['text', 'markdown'],
        supportsUpdate: false,
        supportsDelete: false,
        supportsMention: false,
        supportsReactions: false,
    };
    /**
     * Check if this adapter can handle the given chatId.
     * CLI chat IDs start with 'cli-'.
     */
    canHandle(chatId) {
        return chatId.startsWith('cli-');
    }
    /**
     * Convert Universal Message to CLI format.
     */
    convert(message) {
        const { content } = message;
        switch (content.type) {
            case 'text':
                return content.text;
            case 'markdown':
                return content.text;
            case 'card':
                return cardToText(content);
            case 'file':
                return `[File: ${content.name || content.path}]`;
            case 'done':
                const prefix = content.success ? '✅' : '❌';
                const msg = content.success ? content.message : content.error;
                return `${prefix} ${msg || 'Task completed'}`;
            default:
                return `Unknown message type: ${content.type}`;
        }
    }
    /**
     * Send a message to the console.
     */
    send(message) {
        try {
            const text = this.convert(message);
            // Output to console
            console.log(`\n${text}\n`);
            logger.debug({ chatId: message.chatId }, 'CLI message displayed');
            return Promise.resolve({
                success: true,
                // CLI doesn't have real message IDs, generate a pseudo one
                messageId: `cli-${Date.now()}`,
            });
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.error({ err: error, chatId: message.chatId }, 'Failed to display CLI message');
            return Promise.resolve({
                success: false,
                error: errorMessage,
            });
        }
    }
}
/**
 * Create a new CLI adapter instance.
 */
export function createCliAdapter() {
    return new CliAdapter();
}
