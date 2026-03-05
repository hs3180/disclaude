/**
 * Command System - DI-based command registration and discovery.
 *
 * Issue #463: 帮助消息系统 - 入群/私聊引导 + 指令注册
 * Issue #696: 拆分 builtin-commands.ts
 */

import type { Command } from './types.js';

// Import individual command classes for registration
import { ResetCommand, StatusCommand, HelpCommand } from './session-commands.js';
import { ListNodesCommand, SwitchNodeCommand, RestartCommand } from './node-commands.js';
import {
  CreateGroupCommand,
  AddGroupMemberCommand,
  RemoveGroupMemberCommand,
  ListGroupMembersCommand,
  ListGroupCommand,
  DissolveGroupCommand,
  PassiveCommand,
} from './group-commands.js';
import { SetDebugCommand, ShowDebugCommand, ClearDebugCommand } from './debug-commands.js';
import { ScheduleCommand } from './schedule-command.js';
import { TaskCommand } from './task-command.js';

// Re-export types and registry
export * from './types.js';
export * from './command-registry.js';

// Re-export individual command classes
export { ResetCommand, StatusCommand, HelpCommand } from './session-commands.js';
export { ListNodesCommand, SwitchNodeCommand, RestartCommand } from './node-commands.js';
export {
  CreateGroupCommand,
  AddGroupMemberCommand,
  RemoveGroupMemberCommand,
  ListGroupMembersCommand,
  ListGroupCommand,
  DissolveGroupCommand,
  PassiveCommand,
} from './group-commands.js';
export { SetDebugCommand, ShowDebugCommand, ClearDebugCommand } from './debug-commands.js';
export { ScheduleCommand } from './schedule-command.js';
export { TaskCommand } from './task-command.js';

/**
 * Register default commands to a registry.
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
