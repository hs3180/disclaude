/**
 * Budget Commands - Agent credit account management.
 *
 * Provides commands for managing agent budgets and credits.
 *
 * @see Issue #538 - 积分系统 - 身价与消费
 */

import type { Command, CommandContext, CommandResult } from '../types.js';
import type { AgentAccount } from '../../../experts/types.js';

/**
 * Format account for display.
 */
function formatAccount(account: AgentAccount): string {
  const lines: string[] = [
    '💰 **积分账户**',
    '',
    `🤖 Agent: \`${account.agentId}\``,
    `💵 余额: ${account.balance} 积分`,
    `📊 每日上限: ${account.dailyLimit} 积分`,
    `📈 今日已用: ${account.usedToday} 积分`,
    `📅 剩余可用: ${Math.max(0, account.dailyLimit - account.usedToday)} 积分`,
    '',
    `🕐 创建时间: ${new Date(account.createdAt).toLocaleString('zh-CN')}`,
    `🔄 更新时间: ${new Date(account.updatedAt).toLocaleString('zh-CN')}`,
  ];

  return lines.join('\n');
}

/**
 * Budget Balance Command - Check agent balance.
 *
 * @see Issue #538 - 积分系统 - 身价与消费
 */
export class BudgetBalanceCommand implements Command {
  readonly name = 'budget-balance';
  readonly category = 'expert' as const;
  readonly description = '查看 Agent 积分余额';
  readonly usage = 'budget-balance <agentId>';

  execute(context: CommandContext): CommandResult {
    const { services, args } = context;

    if (args.length < 1) {
      return {
        success: false,
        error: '用法: `/budget-balance <agentId>`\n\n示例: `/budget-balance chat-agent-001`',
      };
    }

    const [agentId] = args;
    const account = services.getBudgetAccount(agentId);

    if (!account) {
      return {
        success: false,
        error: `Agent \`${agentId}\` 尚未创建积分账户`,
      };
    }

    return {
      success: true,
      message: formatAccount(account),
    };
  }
}

/**
 * Budget Recharge Command - Recharge agent credits.
 *
 * @see Issue #538 - 积分系统 - 身价与消费
 */
export class BudgetRechargeCommand implements Command {
  readonly name = 'budget-recharge';
  readonly category = 'expert' as const;
  readonly description = '为 Agent 充值积分';
  readonly usage = 'budget-recharge <agentId> <积分>';

  execute(context: CommandContext): CommandResult {
    const { services, args } = context;

    if (args.length < 2) {
      return {
        success: false,
        error: '用法: `/budget-recharge <agentId> <积分>`\n\n示例: `/budget-recharge chat-agent-001 100`',
      };
    }

    const [agentId, creditsStr] = args;
    const credits = parseInt(creditsStr, 10);

    if (isNaN(credits) || credits <= 0) {
      return { success: false, error: '积分必须是正整数' };
    }

    const account = services.rechargeBudget({
      agentId,
      credits,
    });

    if (!account) {
      return {
        success: false,
        error: `Agent \`${agentId}\` 尚未创建积分账户`,
      };
    }

    return {
      success: true,
      message: `✅ **充值成功**\n\n充值: ${credits} 积分\n当前余额: ${account.balance} 积分`,
    };
  }
}

/**
 * Budget Limit Command - Set daily limit.
 *
 * @see Issue #538 - 积分系统 - 身价与消费
 */
export class BudgetLimitCommand implements Command {
  readonly name = 'budget-limit';
  readonly category = 'expert' as const;
  readonly description = '设置 Agent 每日消费上限';
  readonly usage = 'budget-limit <agentId> <每日上限>';

  execute(context: CommandContext): CommandResult {
    const { services, args } = context;

    if (args.length < 2) {
      return {
        success: false,
        error: '用法: `/budget-limit <agentId> <每日上限>`\n\n示例: `/budget-limit chat-agent-001 50`',
      };
    }

    const [agentId, limitStr] = args;
    const dailyLimit = parseInt(limitStr, 10);

    if (isNaN(dailyLimit) || dailyLimit < 0) {
      return { success: false, error: '每日上限必须是非负整数' };
    }

    const account = services.setBudgetDailyLimit({
      agentId,
      dailyLimit,
    });

    if (!account) {
      return {
        success: false,
        error: `Agent \`${agentId}\` 尚未创建积分账户`,
      };
    }

    return {
      success: true,
      message: `✅ **每日上限设置成功**\n\nAgent: ${agentId}\n每日上限: ${dailyLimit} 积分`,
    };
  }
}

/**
 * Budget List Command - List all accounts.
 *
 * @see Issue #538 - 积分系统 - 身价与消费
 */
export class BudgetListCommand implements Command {
  readonly name = 'budget-list';
  readonly category = 'expert' as const;
  readonly description = '列出所有 Agent 积分账户';
  readonly usage = 'budget-list';

  execute(context: CommandContext): CommandResult {
    const { services } = context;
    const accounts = services.listBudgetAccounts();

    if (accounts.length === 0) {
      return {
        success: true,
        message: '💰 **积分账户列表**\n\n暂无账户',
      };
    }

    const lines: string[] = [
      `💰 **积分账户列表** (共 ${accounts.length} 个)`,
      '',
    ];

    for (const account of accounts) {
      const remaining = Math.max(0, account.dailyLimit - account.usedToday);
      lines.push(
        `• \`${account.agentId}\` - 余额: ${account.balance} | 今日: ${account.usedToday}/${account.dailyLimit} | 剩余: ${remaining}`
      );
    }

    return { success: true, message: lines.join('\n') };
  }
}

/**
 * Budget Create Command - Create a new account.
 *
 * @see Issue #538 - 积分系统 - 身价与消费
 */
export class BudgetCreateCommand implements Command {
  readonly name = 'budget-create';
  readonly category = 'expert' as const;
  readonly description = '创建 Agent 积分账户';
  readonly usage = 'budget-create <agentId> [初始余额] [每日上限]';

  execute(context: CommandContext): CommandResult {
    const { services, args } = context;

    if (args.length < 1) {
      return {
        success: false,
        error: '用法: `/budget-create <agentId> [初始余额] [每日上限]`\n\n示例:\n• `/budget-create chat-agent-001`\n• `/budget-create chat-agent-001 100 50`',
      };
    }

    const [agentId, balanceStr, limitStr] = args;
    const initialBalance = balanceStr ? parseInt(balanceStr, 10) : 0;
    const dailyLimit = limitStr ? parseInt(limitStr, 10) : 100;

    if (isNaN(initialBalance) || initialBalance < 0) {
      return { success: false, error: '初始余额必须是非负整数' };
    }

    if (isNaN(dailyLimit) || dailyLimit < 0) {
      return { success: false, error: '每日上限必须是非负整数' };
    }

    const account = services.createBudgetAccount(agentId, initialBalance, dailyLimit);

    return {
      success: true,
      message: `✅ **账户创建成功**\n\nAgent: ${agentId}\n初始余额: ${account.balance} 积分\n每日上限: ${account.dailyLimit} 积分`,
    };
  }
}
