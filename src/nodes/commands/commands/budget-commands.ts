/**
 * Budget Commands - Admin commands for managing agent credits.
 *
 * Provides commands for:
 * - /budget balance <agent> - Check agent balance
 * - /budget recharge <agent> <credits> - Recharge agent credits
 * - /budget limit <agent> <daily> - Set daily limit
 * - /budget list - List all accounts
 *
 * @see Issue #538 - 积分系统 - 身价与消费
 */

import type { Command, CommandContext, CommandResult } from '../types.js';
import { getCreditsService, type AgentAccount } from '../../../credits/index.js';

/**
 * Format account for display.
 */
function formatAccount(account: AgentAccount | undefined): string {
  if (!account) {
    return '❌ 未找到账户';
  }

  const lines: string[] = [
    `🤖 **${account.name || account.agentId}**`,
    `   ID: \`${account.agentId}\``,
    `   💰 余额: ${account.balance} 积分`,
  ];

  if (account.dailyLimit > 0) {
    const remaining = account.dailyLimit - account.spentToday;
    lines.push(`   📊 每日上限: ${account.dailyLimit} (已用: ${account.spentToday}, 剩余: ${remaining})`);
  } else {
    lines.push('   📊 每日上限: 无限制');
  }

  lines.push(`   📅 创建时间: ${new Date(account.createdAt).toLocaleDateString('zh-CN')}`);

  return lines.join('\n');
}

/**
 * Budget Command - Admin credit management.
 *
 * Usage:
 * - /budget balance <agent> - Check balance
 * - /budget recharge <agent> <credits> - Recharge
 * - /budget limit <agent> <daily> - Set daily limit
 * - /budget list - List all accounts
 */
export class BudgetCommand implements Command {
  readonly name = 'budget';
  readonly category = 'skill' as const;
  readonly description = '管理员积分管理';
  readonly usage = 'budget <balance|recharge|limit|list>';

  execute(context: CommandContext): CommandResult {
    const { args } = context;
    const creditsService = getCreditsService();

    const [firstArg] = args;
    const subCommand = firstArg?.toLowerCase();

    switch (subCommand) {
      case 'balance':
        return this.handleBalance(context, creditsService);
      case 'recharge':
        return this.handleRecharge(context, creditsService);
      case 'limit':
        return this.handleLimit(context, creditsService);
      case 'list':
        return this.handleList(context, creditsService);
      default:
        return {
          success: false,
          error: `❌ 未知子命令: ${subCommand || '(未指定)'}\n\n用法:\n- /budget balance <agent> - 查看余额\n- /budget recharge <agent> <积分> - 充值\n- /budget limit <agent> <每日上限> - 设置每日上限\n- /budget list - 列出所有账户`,
        };
    }
  }

  private handleBalance(context: CommandContext, creditsService: ReturnType<typeof getCreditsService>): CommandResult {
    const { args } = context;
    const [, agentId] = args;

    if (!agentId) {
      return { success: false, error: '❌ 请指定 Agent ID\n\n用法: /budget balance <agent>' };
    }

    const account = creditsService.getAccount(agentId);

    if (!account) {
      return {
        success: false,
        error: `❌ Agent \`${agentId}\` 账户不存在\n\n使用 \`/budget recharge ${agentId} <积分>\` 创建账户`,
      };
    }

    return {
      success: true,
      message: formatAccount(account),
    };
  }

  private handleRecharge(context: CommandContext, creditsService: ReturnType<typeof getCreditsService>): CommandResult {
    const { args } = context;
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

    // Create account if not exists
    let account = creditsService.getAccount(agentId);
    if (!account) {
      account = creditsService.getOrCreateAccount(agentId);
    }

    creditsService.recharge(agentId, credits);

    return {
      success: true,
      message: `✅ **充值成功**\n\n${formatAccount(creditsService.getAccount(agentId))}\n\n充值金额: +${credits} 积分`,
    };
  }

  private handleLimit(context: CommandContext, creditsService: ReturnType<typeof getCreditsService>): CommandResult {
    const { args } = context;
    const [, agentId, limitStr] = args;

    if (!agentId) {
      return { success: false, error: '❌ 请指定 Agent ID\n\n用法: /budget limit <agent> <每日上限>' };
    }

    if (!limitStr) {
      return { success: false, error: '❌ 请指定每日上限\n\n用法: /budget limit <agent> <每日上限>\n\n设为 0 表示无限制' };
    }

    const limit = parseInt(limitStr, 10);
    if (isNaN(limit) || limit < 0) {
      return { success: false, error: '❌ 每日上限必须是非负整数\n\n用法: /budget limit <agent> <每日上限>\n\n设为 0 表示无限制' };
    }

    // Create account if not exists
    let account = creditsService.getAccount(agentId);
    if (!account) {
      account = creditsService.getOrCreateAccount(agentId);
    }

    const updated = creditsService.setDailyLimit(agentId, limit);

    return {
      success: true,
      message: `✅ **每日上限已设置**\n\n${formatAccount(updated)}`,
    };
  }

  private handleList(_context: CommandContext, creditsService: ReturnType<typeof getCreditsService>): CommandResult {
    const accounts = creditsService.listAccounts();

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
      const limitStr = account.dailyLimit > 0
        ? `上限: ${account.dailyLimit}/日`
        : '无上限';
      lines.push(`- **${account.name || account.agentId}** - 余额: ${account.balance} (${limitStr})`);
    }

    return {
      success: true,
      message: lines.join('\n'),
    };
  }
}
