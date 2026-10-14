/** DSH-owned public stage policy; never accepts tool arguments or results. */
export class DshTaskProgress {
  private sent = 0;
  private lastAt = Number.NEGATIVE_INFINITY;
  private readonly seen = new Set<string>();

  constructor(private readonly now: () => number = Date.now) {}

  reset(): void {
    this.sent = 0;
    this.lastAt = Number.NEGATIVE_INFINITY;
    this.seen.clear();
  }

  next(publicSummary: string, toolName: string): string | undefined {
    let summary = publicSummary.trim().replace(/\s+/g, ' ');
    if (!summary || /^[\s🤔⏳🔄]*(?:thinking|working|compacting|正在思考|思考中|处理中)[\s.!…。]*$/i.test(summary) ||
      /^(?:```|\{|\[)/.test(summary)) {
      summary = /bash|shell|exec/i.test(toolName) ? '正在执行命令。' :
        /read/i.test(toolName) ? '正在读取材料。' :
        /search|grep|find/i.test(toolName) ? '正在查找相关信息。' :
        /write|edit/i.test(toolName) ? '正在更新任务文件。' : '正在执行下一步工具操作。';
    }
    summary = summary.length > 240 ? `${summary.slice(0, 239)}…` : summary;
    const key = summary.replace(/[.!！。…]+$/, '').toLowerCase();
    const at = this.now();
    if (this.sent >= 4 || this.seen.has(key) || at - this.lastAt < 15_000) { return undefined; }
    // Reserve before delivery, including uncertain sends; do not replay progress.
    this.sent++;
    this.lastAt = at;
    this.seen.add(key);
    return `⏳ ${summary}`;
  }
}
