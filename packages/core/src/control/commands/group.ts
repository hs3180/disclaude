import type { ControlResponse } from '../../types/channel.js';
import type { CommandHandler } from '../types.js';

/** 开发中提示 */
const WIP_MESSAGE = '⏳ 此命令尚在开发中，敬请期待。';

/**
 * /list-group 命令处理
 */
export const handleListGroup: CommandHandler = (): ControlResponse => ({
  success: true,
  message: WIP_MESSAGE,
});

/**
 * /create-group 命令处理
 */
export const handleCreateGroup: CommandHandler = (): ControlResponse => ({
  success: true,
  message: WIP_MESSAGE,
});

/**
 * /add-group-member 命令处理
 */
export const handleAddGroupMember: CommandHandler = (): ControlResponse => ({
  success: true,
  message: WIP_MESSAGE,
});

/**
 * /remove-group-member 命令处理
 */
export const handleRemoveGroupMember: CommandHandler = (): ControlResponse => ({
  success: true,
  message: WIP_MESSAGE,
});

/**
 * /dissolve-group 命令处理
 */
export const handleDissolveGroup: CommandHandler = (): ControlResponse => ({
  success: true,
  message: WIP_MESSAGE,
});
