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
 *
 * Issue #696: 拆分 builtin-commands.ts
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
  ExpertRegisterCommand,
  ExpertProfileCommand,
  ExpertSkillAddCommand,
  ExpertSkillRemoveCommand,
  ExpertAvailabilityCommand,
  ExpertListCommand,
  ExpertUnregisterCommand,
  ExpertPriceCommand,
  BudgetBalanceCommand,
  BudgetRechargeCommand,
  BudgetLimitCommand,
  BudgetListCommand,
  BudgetCreateCommand,
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
  ExpertRegisterCommand,
  ExpertProfileCommand,
  ExpertSkillAddCommand,
  ExpertSkillRemoveCommand,
  ExpertAvailabilityCommand,
  ExpertListCommand,
  ExpertUnregisterCommand,
  ExpertPriceCommand,
  BudgetBalanceCommand,
  BudgetRechargeCommand,
  BudgetLimitCommand,
  BudgetListCommand,
  BudgetCreateCommand,
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
  // Issue #535: Expert registration and skill declaration commands
  registry.register(new ExpertRegisterCommand());
  registry.register(new ExpertProfileCommand());
  registry.register(new ExpertSkillAddCommand());
  registry.register(new ExpertSkillRemoveCommand());
  registry.register(new ExpertAvailabilityCommand());
  registry.register(new ExpertListCommand());
  registry.register(new ExpertUnregisterCommand());
  // Issue #538: Expert price and budget commands
  registry.register(new ExpertPriceCommand());
  registry.register(new BudgetBalanceCommand());
  registry.register(new BudgetRechargeCommand());
  registry.register(new BudgetLimitCommand());
  registry.register(new BudgetListCommand());
  registry.register(new BudgetCreateCommand());
}
