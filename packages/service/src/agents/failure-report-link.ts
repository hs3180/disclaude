import {
  createPrefilledIssueUrl,
  DEFAULT_ISSUE_REPOSITORY,
  type ChatFailureRecord,
} from '@disclaude/core';

/** Append reporting without ever replacing or throwing away the original diagnostic. */
export function appendFailureReportLink(
  diagnostic: string,
  record: ChatFailureRecord,
  version: string,
  supportsMarkdown: boolean,
  repository = DEFAULT_ISSUE_REPOSITORY,
): string {
  try {
    const url = createPrefilledIssueUrl(record, version, repository);
    return supportsMarkdown
      ? `${diagnostic}\n[打开预填 GitHub issue 上报此故障](${url})`
      : `${diagnostic}\n复制链接打开预填 GitHub issue（提交前请核对脱敏摘要）：\n${url}`;
  } catch {
    return `${diagnostic}\n预填上报链接生成失败；原始错误不受影响，请前往 https://github.com/${DEFAULT_ISSUE_REPOSITORY}/issues/new 并仅粘贴上方脱敏诊断。`;
  }
}
