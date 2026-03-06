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
 * @see Issue #538 - 积分系统
 */

import type { Command, CommandContext, CommandResult } from '../types.js';
import { getExpertService, type AgentAccount, type CreditTransaction } from '../../../experts/index.js';

/**
 * Format agent account for display.
 */
function formatAccount(account: AgentAccount): string {
  const lines: string[] = [
    `💰 **${account.name || account.agentId}**`,
    `   ID: \`${account.agentId}\``,
    `   💵 余额: ${account.balance} 积分`,
    `   📊 每日上限: ${account.dailyLimit === 0 ? '无限制' : `${account.dailyLimit} 积分`}`,
    `   📅 今日已用: ${account.usedToday} 积分`,
    `   🕐 创建时间: ${new Date(account.createdAt).toLocaleDateString('zh-CN')}`,
  ];
  return lines.join('\n');
}

/**
 * Format transaction for display.
 */
function formatTransaction(txn: CreditTransaction, index: number): string {
  const typeEmoji = {
    deduct: '➖',
    recharge: '➕',
    refund: '↩️',
  };
  const emoji = typeEmoji[txn.type] || '💱';
  const amountStr = txn.amount >= 0 ? `+${txn.amount}` : `${txn.amount}`;
  const date = new Date(txn.timestamp).toLocaleString('zh-CN');

  return `${index + 1}. ${emoji} ${amountStr} 积分 | 余额: ${txn.balanceAfter} | ${txn.description} | ${date}`;
}

/**
 * Budget Command - Admin credit management.
 *
 * Usage:
 * - /budget balance <agent> - View agent balance
 * - /budget recharge <agent> <credits> - Recharge agent credits
 * - /budget limit <agent> <daily> - Set daily limit
 * - /budget list - List all agent accounts
 * - /budget history <agent> [count] - View transaction history
 */
export class BudgetCommand implements Command {
  readonly name = 'budget';
  readonly category = 'admin' as const;
  readonly description = 'Agent积分账户管理（管理员）';
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
          error: `❌ 未知子命令: ${subCommand || '(未指定)'}\n\n用法:\n- /budget balance <agent> - 查看余额\n- /budget recharge <agent> <积分> - 充值\n- /budget limit <agent> <每日上限> - 设置每日上限\n- /budget list - 列出所有账户\n- /budget history <agent> [条数] - 查看交易记录`,
        };
    }
  }

  private handleBalance(context: CommandContext): CommandResult {
    const { args } = context;
    const expertService = getExpertService();

    const [, agentId] = args;
    if (!agentId) {
      return { success: false, error: '❌ 请指定 Agent ID\n\n用法: /budget balance <agent>' };
    }

    const account = expertService.getAccount(agentId);
    if (!account) {
      return {
        success: false,
        error: `❌ Agent "${agentId}" 账户不存在\n\n使用 /budget recharge ${agentId} <积分> 创建并充值`,
      };
    }

    return {
      success: true,
      message: formatAccount(account),
    };
  }

  private handleRecharge(context: CommandContext): CommandResult {
    const { args } = context;
    const expertService = getExpertService();

    const [, agentId, creditsStr] = args;

    if (!agentId) {
      return { success: false, error: '❌ 请指定 Agent ID\n\n用法: /budget recharge <agent> <积分>' };
    }

    if (!creditsStr) {
      return { success: false, error: '❌ 请指定充值积分\n\n用法: /budget recharge <agent> <积分>' };
    }

    const credits = parseInt(creditsStr, 10);
    if (isNaN(credits) || credits <= 0) {
      return { success: false, error: '❌ 积分必须是大于 0 的数字\n\n用法: /budget recharge <agent> <积分>' };
    }

    // Get or create account (recharge will also create if not exists)
    expertService.getOrCreateAccount(agentId);
    const updatedAccount = expertService.recharge(agentId, credits);

    if (!updatedAccount) {
      return { success: false, error: '❌ 充值失败' };
    }

    return {
      success: true,
      message: `✅ **充值成功**\n\n为 \`${agentId}\` 充值 ${credits} 积分\n\n${formatAccount(updatedAccount)}`,
    };
  }

  private handleLimit(context: CommandContext): CommandResult {
    const { args } = context;
    const expertService = getExpertService();

    const [, agentId, limitStr] = args;

    if (!agentId) {
      return { success: false, error: '❌ 请指定 Agent ID\n\n用法: /budget limit <agent> <每日上限>' };
    }

    if (!limitStr) {
      return { success: false, error: '❌ 请指定每日上限\n\n用法: /budget limit <agent> <每日上限>\n\n提示: 设置为 0 表示无限制' };
    }

    const dailyLimit = parseInt(limitStr, 10);
    if (isNaN(dailyLimit) || dailyLimit < 0) {
      return { success: false, error: '❌ 每日上限必须是非负整数\n\n用法: /budget limit <agent> <每日上限>' };
    }

    const account = expertService.getAccount(agentId);
    if (!account) {
      return {
        success: false,
        error: `❌ Agent "${agentId}" 账户不存在\n\n使用 /budget recharge ${agentId} <积分> 创建并充值`,
      };
    }

    const updatedAccount = expertService.setDailyLimit(agentId, dailyLimit);
    if (!updatedAccount) {
      return { success: false, error: '❌ 设置每日上限失败' };
    }

    return {
      success: true,
      message: `✅ **每日上限已设置**\n\n\`${agentId}\` 的每日上限设置为 ${dailyLimit === 0 ? '无限制' : `${dailyLimit} 积分`}\n\n${formatAccount(updatedAccount)}`,
    };
  }

  private handleList(_context: CommandContext): CommandResult {
    const expertService = getExpertService();
    const accounts = expertService.listAccounts();

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
      const limitStr = account.dailyLimit === 0 ? '无限制' : `${account.dailyLimit}`;
      lines.push(`- **${account.name || account.agentId}** | 余额: ${account.balance} | 上限: ${limitStr} | 今日: ${account.usedToday}`);
    }

    return {
      success: true,
      message: lines.join('\n'),
    };
  }

  private handleHistory(context: CommandContext): CommandResult {
    const { args } = context;
    const expertService = getExpertService();

    const [, agentId, countStr] = args;
    const count = countStr ? parseInt(countStr, 10) : 20;

    if (!agentId) {
      return { success: false, error: '❌ 请指定 Agent ID\n\n用法: /budget history <agent> [条数]' };
    }

    if (isNaN(count) || count <= 0 || count > 100) {
      return { success: false, error: '❌ 条数必须是 1-100 之间的数字\n\n用法: /budget history <agent> [条数]' };
    }

    const account = expertService.getAccount(agentId);
    if (!account) {
      return {
        success: false,
        error: `❌ Agent "${agentId}" 账户不存在`,
      };
    }

    const transactions = expertService.getTransactionHistory(agentId, count);

    if (transactions.length === 0) {
      return {
        success: true,
        message: `📜 **${account.name || agentId}** 暂无交易记录`,
      };
    }

    const lines: string[] = [
      `📜 **${account.name || agentId} 交易记录** (最近 ${transactions.length} 条)`,
      `💰 当前余额: ${account.balance} 积分`,
      '',
    ];

    for (let i = 0; i < transactions.length; i++) {
      lines.push(formatTransaction(transactions[i], i));
    }

    return {
      success: true,
      message: lines.join('\n'),
    };
  }
}
