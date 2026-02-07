/**
 * Dialogue Message Tracker - Tracks user messages sent during a dialogue.
 *
 * This module is responsible for tracking whether any user-facing messages
 * were sent during a dialogue, and generating appropriate warnings when
 * no messages were sent.
 */

/**
 * Tracks user messages sent during a dialogue.
 *
 * Used to detect when a dialogue completes without sending any messages
 * to the user, which may indicate a configuration problem or that all
 * work was done via internal tools.
 */
export class DialogueMessageTracker {
  private messageSent = false;

  /**
   * Record that a user message was sent.
   *
   * Called by the output adapter or message sender when a message
   * is successfully delivered to the user.
   */
  recordMessageSent(): void {
    this.messageSent = true;
  }

  /**
   * Check if any user message has been sent.
   *
   * @returns true if at least one message was sent to the user
   */
  hasAnyMessage(): boolean {
    return this.messageSent;
  }

  /**
   * Reset the tracking state.
   *
   * Call this when starting a new dialogue to ensure clean state.
   */
  reset(): void {
    this.messageSent = false;
  }

  /**
   * Build a warning message when task completes without sending any user message.
   *
   * @param reason - Why the task ended (e.g., 'task_done', 'max_iterations', 'error')
   * @param taskId - Optional task ID for context
   * @returns Formatted warning message
   */
  buildWarning(reason: string, taskId?: string): string {
    const parts = [
      '⚠️ **任务完成但无反馈消息**',
      '',
      `结束原因: ${reason}`,
    ];

    if (taskId) {
      parts.push(`任务 ID: ${taskId}`);
    }

    parts.push('', '这可能表示:');
    parts.push('- Agent 没有生成任何输出');
    parts.push('- 所有消息都通过内部工具处理');
    parts.push('- 可能存在配置问题');

    return parts.join('\n');
  }
}
