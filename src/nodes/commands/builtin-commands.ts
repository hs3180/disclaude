/**
 * Built-in Commands - Default command registration.
 *
 * This file serves as the central registration point for all built-in commands.
 * Commands are organized in separate files by category for maintainability.
 *
 * Issue #463: 帮助消息系统 - 入群/私聊引导 + 指令注册
 * Issue #537: 完成所有指令的 DI 重构
 * Issue #696: 拆分 builtin-commands.ts
 */

import type { Command } from './types.js';

// Session commands
import { ResetCommand, StatusCommand, HelpCommand } from './session-commands.js';

// Node commands
import { ListNodesCommand, SwitchNodeCommand, RestartCommand } from './node-commands.js';

// Group commands
import {
  CreateGroupCommand,
  AddGroupMemberCommand,
  RemoveGroupMemberCommand,
  ListGroupMembersCommand,
  ListGroupCommand,
  DissolveGroupCommand,
} from './group-commands.js';

// Passive command
import { PassiveCommand } from './passive-command.js';

// Debug commands
import { SetDebugCommand, ShowDebugCommand, ClearDebugCommand } from './debug-commands.js';

// Schedule command
import { ScheduleCommand } from './schedule-command.js';

// Task command
import { TaskCommand } from './task-command.js';

// Re-export all commands for backward compatibility
export { ResetCommand, StatusCommand, HelpCommand } from './session-commands.js';
export { ListNodesCommand, SwitchNodeCommand, RestartCommand } from './node-commands.js';
export {
  CreateGroupCommand,
  AddGroupMemberCommand,
  RemoveGroupMemberCommand,
  ListGroupMembersCommand,
  ListGroupCommand,
  DissolveGroupCommand,
} from './group-commands.js';
export { PassiveCommand } from './passive-command.js';
export { SetDebugCommand, ShowDebugCommand, ClearDebugCommand } from './debug-commands.js';
export { ScheduleCommand } from './schedule-command.js';
export { TaskCommand } from './task-command.js';

/**
 * Register default commands to a registry.
 *
 * This function registers all built-in commands to the provided registry.
 * The registry must implement the `register` method.
 */
export function registerDefaultCommands(
  registry: { register: (cmd: Command) => void },
  generateHelpText: () => string
): void {
  // Session commands
  registry.register(new ResetCommand());
  registry.register(new StatusCommand());
  registry.register(new HelpCommand(generateHelpText));

  // Node commands
  registry.register(new ListNodesCommand());
  registry.register(new SwitchNodeCommand());
  registry.register(new RestartCommand());

  // Group commands
  registry.register(new CreateGroupCommand());
  registry.register(new AddGroupMemberCommand());
  registry.register(new RemoveGroupMemberCommand());
  registry.register(new ListGroupMembersCommand());
  registry.register(new ListGroupCommand());
  registry.register(new DissolveGroupCommand());
  registry.register(new PassiveCommand());

  // Debug commands
  registry.register(new SetDebugCommand());
  registry.register(new ShowDebugCommand());
  registry.register(new ClearDebugCommand());

  // Schedule command (Issue #469)
  registry.register(new ScheduleCommand());

  // Task command (Issue #468)
  registry.register(new TaskCommand());
}
