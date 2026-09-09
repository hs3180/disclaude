import type { ControlCommand, ControlResponse } from '../../types/channel.js';
import type { CommandHandler, ControlHandlerContext } from '../types.js';

export const handleSteer: CommandHandler<'steer'> = async (
  command: ControlCommand<'steer'>,
  context: ControlHandlerContext
): Promise<ControlResponse> => {
  const prompt = command.data?.prompt?.trim();
  if (!prompt) {
    return { success: false, message: 'Usage: `/steer <instruction>`' };
  }
  if (!context.agentPool.steer) {
    return {
      success: false,
      message: 'This node does not expose runtime steer capability. Send a normal message to queue it, or use `/stop` first.',
    };
  }
  const result = await context.agentPool.steer(command.chatId, prompt, command.threadRootId);
  return result.ok
    ? { success: true, message: result.message }
    : { success: false, message: result.error };
};
