/**
 * Budget Commands - Agent credit account management.
 *
 * Provides admin commands for:
 * - /budget balance <agent> - View agent balance
 * - /budget recharge <agent> <credits> - Recharge agent credits
 * - /budget limit <agent> <daily> - Set daily limit
 * - /budget list - List all agent accounts
 * - /budget history <agent> - View transaction history
 *
 * @see Issue #538 - 积分系统 - 身价与消费
 */

import type { Command, CommandContext, CommandResult } from '../types.js';
import { getCreditService, type AgentAccount, type CreditTransaction } from '../../../experts/credit-service.js';

/**
 * Format agent account for display.
 */
function formatAccount(account: AgentAccount): string {
  const lines: string[] = [
    `🤖 **Agent: ${account.agentId}**`,
    `   💰 余额: ${account.balance} 积分`,
    `   📊 每日上限: ${account.dailyLimit === 0 ? '无限制' : `${account.dailyLimit} 积分`}`,
    `   📈 今日已用: ${account.usedToday} 积分`,
    `   📅 创建时间: ${new Date(account.createdAt).toLocaleDateString('zh-CN')}`,
  ];
  return lines.join('\n');
}

/**
 * Format transaction for display.
 */
function formatTransaction(txn: CreditTransaction): string {
  const typeEmoji = {
    spend: '💸',
    recharge: '🔋',
    refund: '↩️',
    adjust: '⚙️',
  };
  const emoji = typeEmoji[txn.type] || '💰';
  const amount = txn.amount >= 0 ? `+${txn.amount}` : `${txn.amount}`;
  const date = new Date(txn.timestamp).toLocaleString('zh-CN');
  return `${emoji} ${amount} → ${txn.balanceAfter} | ${txn.description} (${date})`;
}

/**
 * Budget Command - Admin credit account management.
 *
 * Usage:
 * - /budget balance <agent> - View agent balance
 * - /budget recharge <agent> <credits> - Recharge credits
 * - /budget limit <agent> <daily> - Set daily limit
 * - /budget list - List all accounts
 * - /budget history <agent> - View transaction history
 */
export class BudgetCommand implements Command {
  readonly name = 'budget';
  readonly category = 'skill' as const;
  readonly description = 'Agent 积分账户管理 (管理员)';
  readonly usage = 'budget <balance|recharge|limit|list|history>';

  execute(context: CommandContext): CommandResult {
    const { args } = context;

    const subCommand = args[0]?.toLowerCase();

    switch (subCommand) {
      case 'balance':
        return this.handleBalance(context);
      case 'recharge':
        return this.handleRecharge(context);
      case 'limit':
        return this.handleLimit(context);
      case 'list':
        return this.handleList(context);
      case 'history':
        return this.handleHistory(context);
      default:
        return {
          success: false,
          error: `❌ 未知子命令: ${subCommand || '(未指定)'}\n\n用法:\n- /budget balance <agent> - 查看余额\n- /budget recharge <agent> <积分> - 充值\n- /budget limit <agent> <每日上限> - 设置每日上限\n- /budget list - 列出所有账户\n- /budget history <agent> - 查看交易记录`,
        };
    }
  }

  private handleBalance(context: CommandContext): CommandResult {
    const { args } = context;
    const creditService = getCreditService();

    const [, agentId] = args;

    if (!agentId) {
      return { success: false, error: '❌ 请指定 Agent ID\n\n用法: /budget balance <agent>' };
    }

    const account = creditService.getAccount(agentId);

    if (!account) {
      return {
        success: true,
        message: `🤖 Agent \`${agentId}\` 尚未创建账户\n\n首次充值时将自动创建账户`,
      };
    }

    return {
      success: true,
      message: formatAccount(account),
    };
  }

  private handleRecharge(context: CommandContext): CommandResult {
    const { args } = context;
    const creditService = getCreditService();

    const [, agentId, creditsStr] = args;

    if (!agentId) {
      return { success: false, error: '❌ 请指定 Agent ID\n\n用法: /budget recharge <agent> <积分>' };
    }

    if (!creditsStr) {
      return { success: false, error: '❌ 请指定充值金额\n\n用法: /budget recharge <agent> <积分>' };
    }

    const credits = parseInt(creditsStr, 10);

    if (isNaN(credits) || credits <= 0) {
      return { success: false, error: '❌ 充值金额必须是正整数\n\n用法: /budget recharge <agent> <积分>' };
    }

    const account = creditService.recharge(agentId, credits);

    if (!account) {
      return { success: false, error: '❌ 充值失败' };
    }

    return {
      success: true,
      message: `✅ **充值成功**\n\n${formatAccount(account)}`,
    };
  }

  private handleLimit(context: CommandContext): CommandResult {
    const { args } = context;
    const creditService = getCreditService();

    const [, agentId, limitStr] = args;

    if (!agentId) {
      return { success: false, error: '❌ 请指定 Agent ID\n\n用法: /budget limit <agent> <每日上限>' };
    }

    if (!limitStr) {
      return { success: false, error: '❌ 请指定每日上限\n\n用法: /budget limit <agent> <每日上限>\n\n提示: 设置为 0 表示无限制' };
    }

    const limit = parseInt(limitStr, 10);

    if (isNaN(limit) || limit < 0) {
      return { success: false, error: '❌ 每日上限必须是非负整数\n\n用法: /budget limit <agent> <每日上限>\n\n提示: 设置为 0 表示无限制' };
    }

    const account = creditService.setDailyLimit(agentId, limit);

    if (!account) {
      return { success: false, error: '❌ 设置失败' };
    }

    return {
      success: true,
      message: `✅ **每日上限已设置**\n\n${formatAccount(account)}`,
    };
  }

  private handleList(_context: CommandContext): CommandResult {
    const creditService = getCreditService();
    const accounts = creditService.listAccounts();

    if (accounts.length === 0) {
      return {
        success: true,
        message: '📋 暂无 Agent 账户',
      };
    }

    const lines: string[] = [
      `📋 **Agent 账户列表** (${accounts.length} 个)`,
      '',
    ];

    for (const account of accounts) {
      const limitText = account.dailyLimit === 0 ? '∞' : `${account.dailyLimit}`;
      lines.push(`- **${account.agentId}**: ${account.balance} 积分 (上限: ${limitText}, 今日: ${account.usedToday})`);
    }

    return {
      success: true,
      message: lines.join('\n'),
    };
  }

  private handleHistory(context: CommandContext): CommandResult {
    const { args } = context;
    const creditService = getCreditService();

    const [, agentId, limitStr] = args;

    if (!agentId) {
      return { success: false, error: '❌ 请指定 Agent ID\n\n用法: /budget history <agent> [数量]' };
    }

    const limit = limitStr ? parseInt(limitStr, 10) : 20;

    if (isNaN(limit) || limit <= 0) {
      return { success: false, error: '❌ 数量必须是正整数' };
    }

    const transactions = creditService.getTransactionHistory(agentId, limit);

    if (transactions.length === 0) {
      return {
        success: true,
        message: `📋 Agent \`${agentId}\` 暂无交易记录`,
      };
    }

    const lines: string[] = [
      `📋 **${agentId} 交易记录** (最近 ${transactions.length} 条)`,
      '',
    ];

    for (const txn of transactions) {
      lines.push(formatTransaction(txn));
    }

    return {
      success: true,
      message: lines.join('\n'),
    };
  }
}
