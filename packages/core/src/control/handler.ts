/**
 * Control handler factory.
 *
 * @module control/handler
 */

import type { ControlCommand, ControlResponse } from '../types/channel.js';
import type { ControlHandlerContext } from './types.js';
import { getHandler } from './commands/index.js';

/**
 * 创建控制命令处理器
 */
export function createControlHandler(
  context: ControlHandlerContext
): (command: ControlCommand) => Promise<ControlResponse> {
  return async (command: ControlCommand): Promise<ControlResponse> => {
    const handler = getHandler(command.type);

    if (!handler) {
      return {
        success: false,
        error: `Unknown command: ${command.type}`,
      };
    }

    try {
      return await handler(command, context);
    } catch (error) {
      context.logger?.error({ error, command }, 'Command handler error');
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        message: `❌ 命令执行失败: ${errorMsg}`,
        error: `Command failed: ${errorMsg}`,
      };
    }
  };
}
