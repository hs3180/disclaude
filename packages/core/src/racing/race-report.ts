/**
 * Agent Framework Racing - Race Report Generator
 *
 * Generates human-readable reports from race results.
 * Supports plain text and Markdown output formats.
 *
 * @module racing/race-report
 */

import type {
  RaceResult,
  RaceRanking,
  RaceParticipantMetrics,
} from './types.js';

// ============================================================================
// Report Configuration
// ============================================================================

/**
 * Configuration for report generation.
 */
export interface ReportConfig {
  /** Output format */
  format: 'text' | 'markdown';
  /** Whether to include raw output text in the report */
  includeRawOutput?: boolean;
  /** Whether to include per-task breakdowns */
  includeTaskBreakdown?: boolean;
  /** Maximum output text length to include (in characters) */
  maxOutputLength?: number;
  /** Custom section title for the report */
  title?: string;
}

// ============================================================================
// Report Generator
// ============================================================================

/**
 * Generates race reports from race results.
 *
 * @example
 * ```typescript
 * const report = RaceReportGenerator.generate(result, {
 *   format: 'markdown',
 *   includeTaskBreakdown: true,
 * });
 * console.log(report);
 * ```
 */
export class RaceReportGenerator {
  /**
   * Generate a race report.
   *
   * @param result - Race result to report
   * @param config - Report configuration
   * @returns Formatted report string
   */
  static generate(result: RaceResult, config: ReportConfig = { format: 'markdown' }): string {
    switch (config.format) {
      case 'markdown':
        return RaceReportGenerator.generateMarkdown(result, config);
      case 'text':
        return RaceReportGenerator.generateText(result, config);
      default:
        return RaceReportGenerator.generateMarkdown(result, config);
    }
  }

  // ==========================================================================
  // Markdown Format
  // ==========================================================================

  private static generateMarkdown(result: RaceResult, config: ReportConfig): string {
    const lines: string[] = [];
    const title = config.title ?? `🏎️ Race Report: ${result.config.name}`;

    lines.push(`# ${title}`);
    lines.push('');
    if (result.config.description) {
      lines.push(result.config.description);
      lines.push('');
    }

    // Overview
    lines.push('## Overview');
    lines.push('');
    lines.push(`- **Participants**: ${result.config.participants.length}`);
    lines.push(`- **Tasks**: ${result.config.tasks.length}`);
    lines.push(`- **Duration**: ${formatDuration(result.totalDurationMs)}`);
    lines.push(`- **Date**: ${new Date(result.startedAt).toISOString()}`);
    lines.push('');

    // Overall Standings
    lines.push('## 🏆 Overall Standings');
    lines.push('');
    lines.push(RaceReportGenerator.formatStandingsTable(result.overallStandings));
    lines.push('');

    // Per-task breakdowns
    if (config.includeTaskBreakdown !== false) {
      lines.push('## 📊 Task Breakdown');
      lines.push('');

      for (const taskResult of result.taskResults) {
        lines.push(`### ${taskResult.task.description}`);
        lines.push('');
        lines.push(`Category: ${taskResult.task.category} | Mode: ${taskResult.task.mode}`);
        lines.push('');

        // Task rankings
        lines.push(RaceReportGenerator.formatStandingsTable(taskResult.rankings));
        lines.push('');

        // Per-participant metrics
        for (const pr of taskResult.participantResults) {
          lines.push(`#### ${pr.participant.name}`);
          lines.push('');
          lines.push(RaceReportGenerator.formatMetricsTable(pr.metrics));
          lines.push('');

          if (pr.quality) {
            const icon = pr.quality.passed ? '✅' : '❌';
            lines.push(`Quality: ${icon} Score: ${((pr.quality.score ?? 0) * 100).toFixed(0)}%`);
            if (pr.quality.feedback) {
              lines.push(`> ${pr.quality.feedback}`);
            }
            lines.push('');
          }

          if (config.includeRawOutput && pr.outputText) {
            const maxLen = config.maxOutputLength ?? 500;
            const output = pr.outputText.length > maxLen
              ? pr.outputText.slice(0, maxLen) + '...'
              : pr.outputText;
            lines.push('<details>');
            lines.push('<summary>Output</summary>');
            lines.push('');
            lines.push('```');
            lines.push(output);
            lines.push('```');
            lines.push('</details>');
            lines.push('');
          }
        }
      }
    }

    return lines.join('\n');
  }

  // ==========================================================================
  // Plain Text Format
  // ==========================================================================

  private static generateText(result: RaceResult, config: ReportConfig): string {
    const lines: string[] = [];
    const title = config.title ?? `Race Report: ${result.config.name}`;
    const separator = '='.repeat(60);

    lines.push(separator);
    lines.push(title);
    lines.push(separator);
    lines.push('');
    lines.push(`Participants: ${result.config.participants.length}`);
    lines.push(`Tasks: ${result.config.tasks.length}`);
    lines.push(`Duration: ${formatDuration(result.totalDurationMs)}`);
    lines.push(`Date: ${new Date(result.startedAt).toISOString()}`);
    lines.push('');

    // Overall Standings
    lines.push('-'.repeat(40));
    lines.push('OVERALL STANDINGS');
    lines.push('-'.repeat(40));
    for (const ranking of result.overallStandings) {
      const medal = ranking.rank === 1 ? '🥇' : ranking.rank === 2 ? '🥈' : ranking.rank === 3 ? '🥉' : `#${ranking.rank}`;
      lines.push(`${medal} ${ranking.participantName} - Score: ${(ranking.score * 100).toFixed(1)}%`);
      lines.push(`   Speed: ${(ranking.scoreBreakdown.speed * 100).toFixed(0)}% | Cost: ${(ranking.scoreBreakdown.cost * 100).toFixed(0)}% | Quality: ${(ranking.scoreBreakdown.quality * 100).toFixed(0)}% | Tokens: ${(ranking.scoreBreakdown.tokens * 100).toFixed(0)}%`);
      if (ranking.highlight) lines.push(`   ${ranking.highlight}`);
    }
    lines.push('');

    // Per-task breakdowns
    if (config.includeTaskBreakdown !== false) {
      lines.push('-'.repeat(40));
      lines.push('TASK BREAKDOWN');
      lines.push('-'.repeat(40));
      lines.push('');

      for (const taskResult of result.taskResults) {
        lines.push(`[${taskResult.task.category}] ${taskResult.task.description}`);
        lines.push('');

        for (const ranking of taskResult.rankings) {
          const medal = ranking.rank === 1 ? '🥇' : ranking.rank === 2 ? '🥈' : ranking.rank === 3 ? '🥉' : `#${ranking.rank}`;
          lines.push(`  ${medal} ${ranking.participantName} - Score: ${(ranking.score * 100).toFixed(1)}%`);
          if (ranking.highlight) lines.push(`     ${ranking.highlight}`);
        }

        lines.push('');
        for (const pr of taskResult.participantResults) {
          lines.push(`  ${pr.participant.name}:`);
          lines.push(`    Time: ${formatDuration(pr.metrics.totalElapsedMs)} | Cost: $${pr.metrics.costUsd.toFixed(4)} | Tokens: ${pr.metrics.inputTokens + pr.metrics.outputTokens}`);
          if (pr.quality) {
            lines.push(`    Quality: ${pr.quality.passed ? 'PASS' : 'FAIL'} (${((pr.quality.score ?? 0) * 100).toFixed(0)}%)`);
          }
        }
        lines.push('');
      }
    }

    return lines.join('\n');
  }

  // ==========================================================================
  // Formatting Helpers
  // ==========================================================================

  /**
   * Format standings as a Markdown table.
   */
  private static formatStandingsTable(rankings: RaceRanking[]): string {
    if (rankings.length === 0) return 'No results.';

    const medals = ['🥇', '🥈', '🥉'];
    const medal = (rank: number) => rank <= 3 ? medals[rank - 1] : `#${rank}`;

    const lines: string[] = [];
    lines.push('| Rank | Participant | Score | Speed | Cost | Quality | Tokens |');
    lines.push('|------|-------------|-------|-------|------|---------|--------|');

    for (const r of rankings) {
      lines.push(
        `| ${medal(r.rank)} | ${r.participantName} | ${(r.score * 100).toFixed(1)}% | ` +
        `${(r.scoreBreakdown.speed * 100).toFixed(0)}% | ` +
        `${(r.scoreBreakdown.cost * 100).toFixed(0)}% | ` +
        `${(r.scoreBreakdown.quality * 100).toFixed(0)}% | ` +
        `${(r.scoreBreakdown.tokens * 100).toFixed(0)}% |`
      );
    }

    return lines.join('\n');
  }

  /**
   * Format metrics as a Markdown table.
   */
  private static formatMetricsTable(metrics: RaceParticipantMetrics): string {
    const lines: string[] = [];
    lines.push('| Metric | Value |');
    lines.push('|--------|-------|');
    lines.push(`| Total Time | ${formatDuration(metrics.totalElapsedMs)} |`);
    lines.push(`| TTFB | ${metrics.timeToFirstTokenMs ? `${metrics.timeToFirstTokenMs}ms` : 'N/A'} |`);
    lines.push(`| Time to Last Token | ${metrics.timeToLastTokenMs ? `${metrics.timeToLastTokenMs}ms` : 'N/A'} |`);
    lines.push(`| Input Tokens | ${metrics.inputTokens.toLocaleString()} |`);
    lines.push(`| Output Tokens | ${metrics.outputTokens.toLocaleString()} |`);
    lines.push(`| Total Tokens | ${(metrics.inputTokens + metrics.outputTokens).toLocaleString()} |`);
    lines.push(`| Cost | $${metrics.costUsd.toFixed(4)} |`);
    lines.push(`| Tool Calls | ${metrics.toolCallCount} |`);
    lines.push(`| Messages | ${metrics.messageCount} |`);
    if (metrics.timedOut) lines.push('| Status | ⏱️ Timed Out |');
    if (metrics.hasError) lines.push(`| Status | ❌ Error: ${metrics.errorMessage} |`);

    return lines.join('\n');
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Format milliseconds to human-readable duration.
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = ((ms % 60_000) / 1000).toFixed(0);
  return `${minutes}m ${seconds}s`;
}
