/**
 * Control handler factory.
 *
 * @module control/handler
 */

import type { ControlCommand, ControlResponse } from '../types/channel.js';
import type { ControlHandlerContext } from './types.js';
import { commandRegistry } from './commands/index.js';

/**
 * 创建控制命令处理器
 */
export function createControlHandler(
  context: ControlHandlerContext
): (command: ControlCommand) => Promise<ControlResponse> {
  return async (command: ControlCommand): Promise<ControlResponse> => {
    const definition = commandRegistry.find(c => c.type === command.type);

    if (!definition) {
      return {
        success: false,
        error: `Unknown command: ${command.type}`,
      };
    }

    try {
      if (context.isCommandAllowed && !context.isCommandAllowed(command)) {
        return { success: false, message: '当前权限不允许此命令。请联系服务维护者确认权限。' };
      }
      if (definition.isAvailable && !definition.isAvailable(context, command)) {
        return { success: false, message: '此命令当前不可用。请用 `/help` 查看已配置的命令。' };
      }
      return await definition.handler(command, context);
    } catch (error) {
      context.logger?.error({ error, command }, 'Command handler error');
      let guidance = '';
      try {
        if ((!context.isCommandAllowed || context.isCommandAllowed({ ...command, type: 'help' })) &&
          (!context.guidance || (context.guidance.isEnabled(command.chatId) &&
            (!context.guidance.claimPrompt || context.guidance.claimPrompt(command.chatId))))) {
          guidance = ' 可用 `/help` 查看当前可用命令。';
        }
      } catch { /* A failing access policy must not expose help or replace the failure. */ }
      return {
        success: false,
        message: `命令执行失败，请联系服务维护者核对配置与权限。${guidance}`,
        error: `Command failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  };
}
