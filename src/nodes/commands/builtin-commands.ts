/**
 * Built-in Commands - Default command registration.
 *
 * This module provides the registerDefaultCommands function for registering
 * all built-in commands to a registry.
 *
 * Individual command implementations are organized in the commands/ subdirectory:
 * - session-commands.ts: ResetCommand, StatusCommand, HelpCommand
 * - node-commands.ts: ListNodesCommand, SwitchNodeCommand, RestartCommand
 * - group-commands.ts: CreateGroupCommand, AddGroupMemberCommand, etc.
 * - passive-command.ts: PassiveCommand
 * - debug-commands.ts: SetDebugCommand, ShowDebugCommand, ClearDebugCommand
 * - schedule-command.ts: ScheduleCommand
 * - task-command.ts: TaskCommand
 * - topic-group-command.ts: TopicGroupCommand
 *
 * Issue #696: 拆分 builtin-commands.ts
 * Issue #721: 话题群基础设施 - BBS 模式支持
 * Issue #463: 帮助消息系统 - 入群/私聊引导 + 指令注册
 * Issue #537: 完成所有指令的 DI 重构
 */

import type { Command } from './types.js';

// Import all command classes from modular files
import {
  ResetCommand,
  StatusCommand,
  HelpCommand,
  ListNodesCommand,
  SwitchNodeCommand,
  RestartCommand,
  CreateGroupCommand,
  AddGroupMemberCommand,
  RemoveGroupMemberCommand,
  ListGroupMembersCommand,
  ListGroupCommand,
  DissolveGroupCommand,
  PassiveCommand,
  SetDebugCommand,
  ShowDebugCommand,
  ClearDebugCommand,
  ScheduleCommand,
  TaskCommand,
  TopicGroupCommand,
} from './commands/index.js';

// Re-export all command classes for backward compatibility
export {
  ResetCommand,
  StatusCommand,
  HelpCommand,
  ListNodesCommand,
  SwitchNodeCommand,
  RestartCommand,
  CreateGroupCommand,
  AddGroupMemberCommand,
  RemoveGroupMemberCommand,
  ListGroupMembersCommand,
  ListGroupCommand,
  DissolveGroupCommand,
  PassiveCommand,
  SetDebugCommand,
  ShowDebugCommand,
  ClearDebugCommand,
  ScheduleCommand,
  TaskCommand,
  TopicGroupCommand,
};

/**
 * Register default commands to a registry.
 */
export function registerDefaultCommands(
  registry: { register: (cmd: Command) => void },
  generateHelpText: () => string
): void {
  registry.register(new ResetCommand());
  registry.register(new StatusCommand());
  registry.register(new HelpCommand(generateHelpText));
  registry.register(new ListNodesCommand());
  registry.register(new SwitchNodeCommand());
  registry.register(new RestartCommand());
  registry.register(new CreateGroupCommand());
  registry.register(new AddGroupMemberCommand());
  registry.register(new RemoveGroupMemberCommand());
  registry.register(new ListGroupMembersCommand());
  registry.register(new ListGroupCommand());
  registry.register(new DissolveGroupCommand());
  registry.register(new PassiveCommand());
  registry.register(new SetDebugCommand());
  registry.register(new ShowDebugCommand());
  registry.register(new ClearDebugCommand());
  // Issue #469: Schedule management command
  registry.register(new ScheduleCommand());
  // Issue #468: Task control command
  registry.register(new TaskCommand());
  // Issue #721: Topic group command for BBS mode
  registry.register(new TopicGroupCommand());
}
