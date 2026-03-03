/**
 * Budget Command - Admin commands for credit management.
 *
 * @see Issue #538 - 积分系统 - 身价与消费
 */

import type { Command, CommandContext, CommandResult } from './types.js';
import { getCreditManager } from '../../human-loop/index.js';

/**
 * Budget Command - Admin commands for managing agent credits.
 *
 * Subcommands:
 * - balance <agent>: Check agent balance
 * - recharge <agent> <credits>: Recharge agent account
 * - limit <agent> <daily>: Set daily limit
 * - list: List all accounts
 */
export class BudgetCommand implements Command {
  readonly name = 'budget';
  readonly category = 'expert' as const;
  readonly description = '积分管理（管理员）';
  readonly usage = 'budget <balance|recharge|limit|list>';

  async execute(context: CommandContext): Promise<CommandResult> {
    const subCommand = context.args[0]?.toLowerCase();

    // If no subcommand, show help
    if (!subCommand) {
      return {
        success: true,
        message: this.getHelpText(),
      };
    }

    // Validate subcommand
    const validSubcommands = ['balance', 'recharge', 'limit', 'list'];
    if (!validSubcommands.includes(subCommand)) {
      return {
        success: false,
        error: `未知的子命令: \`${subCommand}\`

可用子命令: ${validSubcommands.map(c => `\`${c}\``).join(', ')}`,
      };
    }

    const creditManager = getCreditManager();

    switch (subCommand) {
      case 'balance':
        return this.handleBalance(creditManager, context.args.slice(1));

      case 'recharge':
        return this.handleRecharge(creditManager, context.args.slice(1));

      case 'limit':
        return this.handleLimit(creditManager, context.args.slice(1));

      case 'list':
        return this.handleList(creditManager);

      default:
        return { success: false, error: '未知子命令' };
    }
  }

  /**
   * Get help text for the command.
   */
  private getHelpText(): string {
    return `💰 **积分管理指令（管理员）**

用法: \`/budget <子命令>\`

**可用子命令:**

- \`balance <agent>\` - 查看账户余额
- \`recharge <agent> <积分>\` - 充值积分
- \`limit <agent> <每日上限>\` - 设置每日消费上限
- \`list\` - 列出所有账户

**示例:**
\`\`\`
/budget balance agent_001
/budget recharge agent_001 100
/budget limit agent_001 50
/budget list
\`\`\`

**注意:** 此命令仅供管理员使用。`;
  }

  /**
   * Handle balance subcommand.
   */
  private async handleBalance(
    creditManager: ReturnType<typeof getCreditManager>,
    args: string[]
  ): Promise<CommandResult> {
    if (args.length < 1) {
      return {
        success: false,
        error: '用法: `/budget balance <agent>`\n\n示例: `/budget balance agent_001`',
      };
    }

    const agentId = args[0];
    const account = await creditManager.getAccount(agentId);

    if (!account) {
      return {
        success: false,
        error: `账户 \`${agentId}\` 不存在\n\n使用 \`/budget recharge ${agentId} <积分>\` 创建并充值`,
      };
    }

    const dailyRemaining = account.dailyLimit - account.usedToday;

    return {
      success: true,
      message: `💰 **账户余额**

**账户 ID:** \`${account.agentId}\`
**名称:** ${account.name || '未设置'}
**当前余额:** ${account.balance} 积分
**每日上限:** ${account.dailyLimit} 积分
**今日已用:** ${account.usedToday} 积分
**今日剩余:** ${dailyRemaining} 积分`,
    };
  }

  /**
   * Handle recharge subcommand.
   */
  private async handleRecharge(
    creditManager: ReturnType<typeof getCreditManager>,
    args: string[]
  ): Promise<CommandResult> {
    if (args.length < 2) {
      return {
        success: false,
        error: '用法: `/budget recharge <agent> <积分>`\n\n示例: `/budget recharge agent_001 100`',
      };
    }

    const agentId = args[0];
    const amount = parseInt(args[1], 10);

    if (isNaN(amount) || amount <= 0) {
      return {
        success: false,
        error: '充值金额必须是大于 0 的整数',
      };
    }

    const result = await creditManager.recharge(agentId, amount);

    if (result.success) {
      return {
        success: true,
        message: `✅ **充值成功**

**账户:** \`${agentId}\`
**充值金额:** ${amount} 积分
**当前余额:** ${result.newBalance} 积分`,
      };
    }

    return { success: false, error: result.error || '充值失败' };
  }

  /**
   * Handle limit subcommand.
   */
  private async handleLimit(
    creditManager: ReturnType<typeof getCreditManager>,
    args: string[]
  ): Promise<CommandResult> {
    if (args.length < 2) {
      return {
        success: false,
        error: '用法: `/budget limit <agent> <每日上限>`\n\n示例: `/budget limit agent_001 50`',
      };
    }

    const agentId = args[0];
    const limit = parseInt(args[1], 10);

    if (isNaN(limit) || limit < 0) {
      return {
        success: false,
        error: '每日上限必须是非负整数',
      };
    }

    const result = await creditManager.setDailyLimit(agentId, limit);

    if (result.success) {
      return {
        success: true,
        message: `✅ **每日上限已设置**

**账户:** \`${agentId}\`
**每日上限:** ${limit} 积分
**当前余额:** ${result.newBalance} 积分`,
      };
    }

    return { success: false, error: result.error || '设置上限失败' };
  }

  /**
   * Handle list subcommand.
   */
  private async handleList(
    creditManager: ReturnType<typeof getCreditManager>
  ): Promise<CommandResult> {
    const accounts = await creditManager.getAllAccounts();

    if (accounts.length === 0) {
      return {
        success: true,
        message: '💰 **账户列表**\n\n暂无账户。\n\n使用 `/budget recharge <agent> <积分>` 创建第一个账户',
      };
    }

    const accountsList = accounts.map(a => {
      const dailyRemaining = a.dailyLimit - a.usedToday;
      return `- **${a.name || a.agentId}** \`${a.agentId.slice(0, 12)}...\`
  余额: ${a.balance} 积分 | 今日剩余: ${dailyRemaining}/${a.dailyLimit}`;
    }).join('\n\n');

    return {
      success: true,
      message: `💰 **账户列表** (${accounts.length} 个)

${accountsList}

---
💡 使用 \`/budget balance <agent>\` 查看详情`,
    };
  }
}
