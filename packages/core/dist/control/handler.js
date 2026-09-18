/**
 * Control handler factory.
 *
 * @module control/handler
 */
import { getHandler } from './commands/index.js';
/**
 * 创建控制命令处理器
 */
export function createControlHandler(context) {
    return async (command) => {
        const handler = getHandler(command.type);
        if (!handler) {
            return {
                success: false,
                error: `Unknown command: ${command.type}`,
            };
        }
        try {
            return await handler(command, context);
        }
        catch (error) {
            context.logger?.error({ error, command }, 'Command handler error');
            return {
                success: false,
                error: `Command failed: ${error instanceof Error ? error.message : String(error)}`,
            };
        }
    };
}
