/**
 * Budget Command - Manage agent credits and budgets.
 *
 * Subcommands:
 * - balance <agent>: View agent's balance
 * - recharge <agent> <credits>: Recharge agent's credits
 * - limit <agent> <daily>: Set agent's daily limit
 * - list: List all agent accounts
 * - log [agent]: View consumption log
 *
 * Issue #538: 积分系统 - 身价与消费
 */

import type { Command, CommandContext, CommandResult } from '../nodes/commands/types.js';
import { getBudgetManager } from './budget-manager.js';

/**
 * Budget Command - Manage agent credits and budgets.
 */
export class BudgetCommand implements Command {
  readonly name = 'budget';
  readonly category = 'group' as const;
  readonly description = '积分预算管理';
  readonly usage = 'budget <balance|recharge|limit|list|log>';

  async execute(context: CommandContext): Promise<CommandResult> {
    const subCommand = context.args[0]?.toLowerCase();

    // If no subcommand, show help
    if (!subCommand) {
      return this.showHelp();
    }

    // Handle subcommands
    switch (subCommand) {
      case 'balance':
        return await this.handleBalance(context);
      case 'recharge':
        return await this.handleRecharge(context);
      case 'limit':
        return await this.handleLimit(context);
      case 'list':
        return await this.handleList();
      case 'log':
        return await this.handleLog(context);
      default:
        return {
          success: false,
          error: `未知子命令: \`${subCommand}\`\n\n${this.getUsageText()}`,
        };
    }
  }

  private showHelp(): CommandResult {
    return {
      success: true,
      message: `💰 **积分预算管理**

用法: \`/budget <子命令> [参数]\`

**可用子命令:**

- \`balance <agent>\` - 查看 Agent 积分余额
- \`recharge <agent> <积分>\` - 为 Agent 充值积分
- \`limit <agent> <每日上限>\` - 设置 Agent 每日消费上限
- \`list\` - 列出所有 Agent 账户
- \`log [agent]\` - 查看消费记录

**示例:**
\`\`\`
/budget balance agent_001
/budget recharge agent_001 500
/budget limit agent_001 100
/budget list
/budget log
/budget log agent_001
\`\`\``,
    };
  }

  private getUsageText(): string {
    return `用法: \`/budget <balance|recharge|limit|list|log>\`

输入 \`/budget\` 查看完整帮助。`;
  }

  private async handleBalance(context: CommandContext): Promise<CommandResult> {
    const [, agentId] = context.args;

    if (!agentId) {
      return {
        success: false,
        error: '请指定 Agent ID。\n\n用法: `/budget balance <agent>`',
      };
    }

    const manager = getBudgetManager();
    const account = await manager.getAccount(agentId);

    if (!account) {
      return {
        success: true,
        message: `💰 **积分余额**

Agent: \`${agentId}\`
状态: 账户不存在

使用 \`/budget recharge ${agentId} <积分>\` 创建账户并充值。`,
      };
    }

    const remainingDaily = account.dailyLimit - account.usedToday;

    return {
      success: true,
      message: `💰 **积分余额**

Agent: \`${account.agentId}\`
余额: **${account.balance}** 积分
每日上限: ${account.dailyLimit} 积分
今日已用: ${account.usedToday} 积分
今日剩余: ${remainingDaily} 积分

创建时间: ${new Date(account.createdAt).toLocaleString('zh-CN')}
更新时间: ${new Date(account.updatedAt).toLocaleString('zh-CN')}`,
    };
  }

  private async handleRecharge(context: CommandContext): Promise<CommandResult> {
    const [, agentId, amountStr] = context.args;

    if (!agentId) {
      return {
        success: false,
        error: '请指定 Agent ID。\n\n用法: `/budget recharge <agent> <积分>`',
      };
    }

    if (!amountStr) {
      return {
        success: false,
        error: '请指定充值金额。\n\n用法: `/budget recharge <agent> <积分>`',
      };
    }

    const amount = parseInt(amountStr, 10);
    if (isNaN(amount) || amount <= 0) {
      return {
        success: false,
        error: '充值金额必须是正整数。',
      };
    }

    const manager = getBudgetManager();
    const account = await manager.recharge(agentId, amount);

    return {
      success: true,
      message: `✅ **充值成功**

Agent: \`${account.agentId}\`
充值金额: **${amount}** 积分
新余额: **${account.balance}** 积分`,
    };
  }

  private async handleLimit(context: CommandContext): Promise<CommandResult> {
    const [, agentId, limitStr] = context.args;

    if (!agentId) {
      return {
        success: false,
        error: '请指定 Agent ID。\n\n用法: `/budget limit <agent> <每日上限>`',
      };
    }

    if (!limitStr) {
      return {
        success: false,
        error: '请指定每日上限。\n\n用法: `/budget limit <agent> <每日上限>`',
      };
    }

    const limit = parseInt(limitStr, 10);
    if (isNaN(limit) || limit < 0) {
      return {
        success: false,
        error: '每日上限必须是非负整数。',
      };
    }

    const manager = getBudgetManager();
    const account = await manager.setDailyLimit(agentId, limit);

    if (!account) {
      return {
        success: false,
        error: `Agent \`${agentId}\` 账户不存在。请先充值创建账户。`,
      };
    }

    return {
      success: true,
      message: `✅ **每日上限已设置**

Agent: \`${account.agentId}\`
每日上限: **${limit}** 积分
今日已用: ${account.usedToday} 积分`,
    };
  }

  private async handleList(): Promise<CommandResult> {
    const manager = getBudgetManager();
    const accounts = await manager.listAccounts();

    if (accounts.length === 0) {
      return {
        success: true,
        message: `💰 **Agent 账户列表**

暂无账户。

使用 \`/budget recharge <agent> <积分>\` 创建账户。`,
      };
    }

    const accountsList = accounts.map(a => {
      const remainingDaily = a.dailyLimit - a.usedToday;
      return `- \`${a.agentId}\`: 余额 **${a.balance}**, 今日剩余 ${remainingDaily}/${a.dailyLimit}`;
    }).join('\n');

    const totalBalance = accounts.reduce((sum, a) => sum + a.balance, 0);

    return {
      success: true,
      message: `💰 **Agent 账户列表**

${accountsList}

共 ${accounts.length} 个账户，总余额: **${totalBalance}** 积分`,
    };
  }

  private async handleLog(context: CommandContext): Promise<CommandResult> {
    const [, agentId] = context.args;
    const manager = getBudgetManager();
    const logs = await manager.getConsumptionLog(agentId, 20);

    if (logs.length === 0) {
      return {
        success: true,
        message: `📜 **消费记录**

${agentId ? `Agent: \`${agentId}\`\n\n` : ''}暂无消费记录。`,
      };
    }

    const logsList = logs.map(l => {
      const date = new Date(l.timestamp).toLocaleString('zh-CN');
      return `- [${date}] \`${l.agentId}\` → \`${l.expertId}\`: **-${l.amount}** 积分${l.description ? ` (${l.description})` : ''}`;
    }).join('\n');

    return {
      success: true,
      message: `📜 **消费记录**

${agentId ? `Agent: \`${agentId}\`\n\n` : ''}${logsList}

显示最近 ${logs.length} 条记录。`,
    };
  }
}
