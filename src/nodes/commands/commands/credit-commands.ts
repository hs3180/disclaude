/**
 * Budget Command - Manage agent credits accounts.
 *
 * @see Issue #538 - 积分系统 - 身价与消费
 */

import type { Command, CommandContext, CommandResult, CommandServices } from '../types.js';

/**
 * Budget command for managing agent credits.
 *
 * Usage:
 * - /budget balance <agent>         - View balance
 * - /budget recharge <agent> <credits> - Recharge credits
 * - /budget limit <agent> <daily>   - Set daily limit
 * - /budget list                    - List all accounts
 */
export class BudgetCommand implements Command {
  readonly name = 'budget';
  readonly category = 'credit' as const;
  readonly description = '管理 Agent 积分账户 (管理员)';
  readonly usage = '/budget <balance|recharge|limit|list> [agent] [credits]';

  execute(context: CommandContext): CommandResult | Promise<CommandResult> {
    const { args, services } = context;
    const subCommand = args[0]?.toLowerCase();

    switch (subCommand) {
      case 'balance':
        return this.handleBalance(args, services);
      case 'recharge':
        return this.handleRecharge(args, services);
      case 'limit':
        return this.handleLimit(args, services);
      case 'list':
        return this.handleList(services);
      default:
        return {
          success: false,
          error: `用法: ${this.usage}`,
        };
    }
  }

  private handleBalance(args: string[], services: CommandServices): CommandResult {
    const agentId = args[1];
    if (!agentId) {
      return { success: false, error: '请指定 agent ID' };
    }

    const account = services.getCreditAccount(agentId);
    if (!account) {
      return { success: false, error: `账户不存在: ${agentId}` };
    }

    return {
      success: true,
      message: `💰 账户: ${agentId}\n` +
        `余额: ${account.balance} 积分\n` +
        `每日上限: ${account.dailyLimit}\n` +
        `今日已用: ${account.usedToday}`,
    };
  }

  private handleRecharge(args: string[], services: CommandServices): CommandResult {
    const agentId = args[1];
    const credits = parseInt(args[2], 10);

    if (!agentId) {
      return { success: false, error: '请指定 agent ID' };
    }
    if (isNaN(credits) || credits <= 0) {
      return { success: false, error: '请输入有效的积分数 (正整数)' };
    }

    // Ensure account exists
    if (!services.hasCreditAccount(agentId)) {
      services.createCreditAccount({ agentId });
    }

    const account = services.rechargeCredits({ agentId, credits });
    if (!account) {
      return { success: false, error: `充值失败: ${agentId}` };
    }

    return {
      success: true,
      message: `✅ 已充值 ${credits} 积分给 ${agentId}\n新余额: ${account.balance} 积分`,
    };
  }

  private handleLimit(args: string[], services: CommandServices): CommandResult {
    const agentId = args[1];
    const dailyLimit = parseInt(args[2], 10);

    if (!agentId) {
      return { success: false, error: '请指定 agent ID' };
    }
    if (isNaN(dailyLimit) || dailyLimit < 0) {
      return { success: false, error: '请输入有效的每日上限 (非负整数)' };
    }

    // Ensure account exists
    if (!services.hasCreditAccount(agentId)) {
      services.createCreditAccount({ agentId, dailyLimit });
    }

    const account = services.setCreditDailyLimit({ agentId, dailyLimit });
    if (!account) {
      return { success: false, error: `设置失败: ${agentId}` };
    }

    return {
      success: true,
      message: `✅ 已设置 ${agentId} 每日上限为 ${dailyLimit} 积分`,
    };
  }

  private handleList(services: CommandServices): CommandResult {
    const accounts = services.listCreditAccounts();

    if (accounts.length === 0) {
      return { success: true, message: '暂无积分账户' };
    }

    const lines = accounts.map((a) =>
      `${a.agentId}: ${a.balance} 积分 (今日 ${a.usedToday}/${a.dailyLimit})`
    );

    return {
      success: true,
      message: `📋 积分账户列表 (${accounts.length})\n` + lines.join('\n'),
    };
  }
}
