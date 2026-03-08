/**
 * Budget Commands - Agent credit account management.
 *
 * Provides commands for:
 * - /budget balance [agent] - Check account balance
 * - /budget recharge <agent> <credits> - Recharge credits (admin only)
 * - /budget limit <agent> <daily> - Set daily limit (admin only)
 * - /budget history [agent] - View transaction history
 *
 * @see Issue #538 - 积分系统 - 身价与消费
 */

import type { Command, CommandContext, CommandResult } from '../types.js';
import { getCreditService, type AgentAccount } from '../../../experts/index.js';

/**
 * Format account info for display.
 */
function formatAccount(account: AgentAccount): string {
  const lines: string[] = [
    '💳 **账户信息**',
    `   Agent: \`${account.agentId}\``,
    `   💰 余额: ${account.balance} 积分`,
    `   📊 每日限额: ${account.dailyLimit === 0 ? '无限制' : `${account.dailyLimit} 积分`}`,
    `   📈 今日已用: ${account.usedToday} 积分`,
  ];

  if (account.dailyLimit > 0) {
    const remaining = Math.max(0, account.dailyLimit - account.usedToday);
    lines.push(`   ✅ 今日剩余: ${remaining} 积分`);
  }

  return lines.join('\n');
}

/**
 * Budget Command - Agent credit management.
 *
 * Usage:
 * - /budget balance [agent] - Check balance (default: current chat)
 * - /budget recharge <agent> <credits> - Recharge credits (admin)
 * - /budget limit <agent> <daily> - Set daily limit (admin)
 * - /budget history [agent] - View transaction history
 */
export class BudgetCommand implements Command {
  readonly name = 'budget';
  readonly category = 'skill' as const;
  readonly description = 'Agent 积分账户管理';
  readonly usage = 'budget <balance|recharge|limit|history>';

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
      case 'history':
        return this.handleHistory(context);
      default:
        return {
          success: false,
          error: `❌ 未知子命令: ${subCommand || '(未指定)'}\n\n用法:\n- /budget balance [agent] - 查看余额\n- /budget recharge <agent> <积分> - 充值 (管理员)\n- /budget limit <agent> <每日限额> - 设置限额 (管理员)\n- /budget history [agent] - 交易记录`,
        };
    }
  }

  private handleBalance(context: CommandContext): CommandResult {
    const { args, chatId } = context;
    const creditService = getCreditService();

    // Use provided agentId or current chatId
    const agentId = args[1] || chatId;
    const account = creditService.getAccount(agentId);

    if (!account) {
      return {
        success: true,
        message: `💳 账户 \`${agentId}\` 尚未初始化\n\n使用 Agent 发起咨询后将自动创建账户`,
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

    // TODO: Add admin check when admin system is implemented
    // For now, allow anyone to recharge for testing purposes

    const [, agentId, amountStr] = args;

    if (!agentId) {
      return { success: false, error: '❌ 请指定 Agent ID\n\n用法: /budget recharge <agent> <积分>' };
    }

    if (!amountStr) {
      return { success: false, error: '❌ 请指定充值金额\n\n用法: /budget recharge <agent> <积分>' };
    }

    const amount = parseInt(amountStr, 10);
    if (isNaN(amount) || amount <= 0) {
      return { success: false, error: '❌ 充值金额必须是正整数\n\n用法: /budget recharge <agent> <积分>' };
    }

    const account = creditService.recharge(agentId, amount);

    return {
      success: true,
      message: `✅ **充值成功**\n\n💰 充值: ${amount} 积分\n📊 新余额: ${account.balance} 积分`,
    };
  }

  private handleLimit(context: CommandContext): CommandResult {
    const { args } = context;
    const creditService = getCreditService();

    // TODO: Add admin check when admin system is implemented

    const [, agentId, limitStr] = args;

    if (!agentId) {
      return { success: false, error: '❌ 请指定 Agent ID\n\n用法: /budget limit <agent> <每日限额>\n\n提示: 设为 0 表示无限制' };
    }

    if (!limitStr) {
      // Show current limit
      const account = creditService.getAccount(agentId);
      if (!account) {
        return { success: false, error: `❌ 账户 \`${agentId}\` 不存在` };
      }
      return {
        success: true,
        message: `📊 Agent \`${agentId}\` 的每日限额: ${account.dailyLimit === 0 ? '无限制' : `${account.dailyLimit  } 积分`}`,
      };
    }

    const limit = parseInt(limitStr, 10);
    if (isNaN(limit) || limit < 0) {
      return { success: false, error: '❌ 每日限额必须是非负整数\n\n用法: /budget limit <agent> <每日限额>\n\n提示: 设为 0 表示无限制' };
    }

    const account = creditService.setDailyLimit(agentId, limit);

    if (!account) {
      return { success: false, error: `❌ 账户 \`${agentId}\` 不存在` };
    }

    return {
      success: true,
      message: `✅ **每日限额已设置**\n\n📊 Agent: \`${agentId}\`\n💰 每日限额: ${limit === 0 ? '无限制' : `${limit  } 积分`}`,
    };
  }

  private handleHistory(context: CommandContext): CommandResult {
    const { args, chatId } = context;
    const creditService = getCreditService();

    const agentId = args[1] || chatId;
    const transactions = creditService.getTransactionHistory(agentId, 10);

    if (transactions.length === 0) {
      return {
        success: true,
        message: `📋 Agent \`${agentId}\` 暂无交易记录`,
      };
    }

    const lines: string[] = [
      `📋 **交易记录** (Agent: \`${agentId}\`)`,
      '',
    ];

    for (const txn of transactions) {
      const date = new Date(txn.timestamp).toLocaleString('zh-CN');
      const amountStr = txn.amount >= 0 ? `+${txn.amount}` : `${txn.amount}`;
      const typeEmoji = {
        recharge: '💰',
        consultation: '💸',
        refund: '↩️',
        admin_adjust: '🔧',
      }[txn.type];

      lines.push(`${typeEmoji} ${amountStr} 积分 | ${txn.description}`);
      lines.push(`   ${date} | 余额: ${txn.balanceAfter}`);
      lines.push('');
    }

    return {
      success: true,
      message: lines.join('\n').trim(),
    };
  }
}
