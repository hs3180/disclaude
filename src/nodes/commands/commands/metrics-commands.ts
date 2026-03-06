/**
 * Metrics Commands - TTFR and performance metrics.
 *
 * Provides commands for viewing TTFR (Time to First Response) statistics.
 *
 * Issue #855: 添加用户消息第一响应时间考核指标
 */

import type { Command, CommandContext, CommandResult } from '../types.js';
import { getTTFRTracker, getTTFRRating } from '../../../metrics/index.js';

/**
 * TTFR Stats Command - View TTFR statistics.
 */
export class TtfrStatsCommand implements Command {
  readonly name = 'ttfr';
  readonly category = 'debug' as const;
  readonly description = '查看响应时间统计';

  execute(context: CommandContext): CommandResult {
    const { args } = context;
    const tracker = getTTFRTracker();

    // Parse time range (default: last 24 hours)
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const startTime = now - dayMs;

    // Get stats
    const stats = tracker.getGlobalStats(startTime, now);

    if (!stats || stats.count === 0) {
      return {
        success: true,
        message: `📊 **TTFR 统计** (最近 24 小时)

暂无数据

使用提示：
- 数据会在用户发送消息并收到 Agent 回复后自动记录
- 支持查看不同时间段的统计`,
      };
    }

    const avgRating = getTTFRRating(stats.avgMs);
    const p50Rating = getTTFRRating(stats.p50Ms);
    const p90Rating = getTTFRRating(stats.p90Ms);

    const formatMs = (ms: number) => {
      if (ms < 1000) {
        return `${ms}ms`;
      }
      return `${(ms / 1000).toFixed(2)}s`;
    };

    // Check if user wants detailed view
    const showDetails = args.length > 0 && args[0] === 'detail';

    let message = `📊 **TTFR 统计** (最近 24 小时)

| 指标 | 值 | 评级 |
|------|-----|------|
| 记录数 | ${stats.count} | - |
| 平均响应 | ${formatMs(stats.avgMs)} | ${avgRating.emoji} ${avgRating.label} |
| P50 (中位数) | ${formatMs(stats.p50Ms)} | ${p50Rating.emoji} ${p50Rating.label} |
| P90 | ${formatMs(stats.p90Ms)} | ${p90Rating.emoji} ${p90Rating.label} |
| 最快 | ${formatMs(stats.minMs)} | - |
| 最慢 | ${formatMs(stats.maxMs)} | - |

**评级标准**:
🟢 优秀 < 3s | 🟡 良好 < 5s | 🟠 及格 < 10s | 🔴 需改进`;

    if (showDetails) {
      const recentRecords = tracker.getRecordsFiltered({ limit: 10 });
      if (recentRecords.length > 0) {
        message += `\n\n**最近 ${recentRecords.length} 条记录**:\n`;
        for (const record of recentRecords) {
          const rating = getTTFRRating(record.ttfrMs);
          const time = new Date(record.userMessageTime).toLocaleString('zh-CN');
          message += `\n- ${rating.emoji} ${formatMs(record.ttfrMs)} - ${time}`;
        }
      }
      message += '\n\n💡 使用 `/ttfr` 查看简略统计';
    } else {
      message += '\n\n💡 使用 `/ttfr detail` 查看详细记录';
    }

    return {
      success: true,
      message,
    };
  }
}

/**
 * TTFR Clear Command - Clear TTFR records.
 */
export class TtfrClearCommand implements Command {
  readonly name = 'ttfr-clear';
  readonly category = 'debug' as const;
  readonly description = '清除 TTFR 统计数据';

  execute(_context: CommandContext): CommandResult {
    const tracker = getTTFRTracker();
    tracker.clear();

    return {
      success: true,
      message: '✅ **TTFR 数据已清除**\n\n所有统计数据已被重置',
    };
  }
}
