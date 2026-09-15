import type { ResearchProject } from './project.js';

export function resultParagraphs(project: ResearchProject, at: string): string[] {
  const kinds = { fact: '来源事实', inference: '研究推断', uncertain: '尚不确定' };
  const lines = [`研究成果快照 · ${project.title}`, `生成时间：${at}`, '结论', project.summary, '发现与证据'];
  for (const direction of project.directions) {
    if (!direction.findings.length) { continue; }
    lines.push(direction.title);
    for (const finding of direction.findings) {
      lines.push(`${kinds[finding.kind]}：${finding.claim}`);
      for (const source of finding.sources) { lines.push(source.title, source.location, source.excerpt); }
      if (finding.caveat) { lines.push(`限制或反证：${finding.caveat}`); }
    }
  }
  lines.push('尚未解决的问题', ...project.questions);
  if (project.feedback.length) { lines.push('意见处理记录'); }
  const states = { pending: '待处理', applied: '已采纳至计划', rejected: '未采纳', 'needs-clarification': '待澄清' };
  for (const feedback of project.feedback) { lines.push(`${states[feedback.status]}：${feedback.text}`, feedback.reason ?? ''); }
  const chunks = lines.flatMap(line => line.split('\n')).filter(line => line.trim()).flatMap(line => {
    const chars = Array.from(line), chunks: string[] = [];
    for (let i = 0; i < chars.length; i += 2000) { chunks.push(chars.slice(i, i + 2000).join('')); }
    return chunks;
  });
  const paragraphs: string[] = [];
  for (const chunk of chunks) {
    const last = paragraphs.length - 1;
    if (last >= 0 && paragraphs[last].length + chunk.length + 1 <= 2000) { paragraphs[last] += `\n${chunk}`; }
    else { paragraphs.push(chunk); }
  }
  if (paragraphs.length > 50 || paragraphs.join('\n').length > 48_000) { throw new Error('成果超过单次文档追加限制；完整成果仍保留在项目中。'); }
  return paragraphs;
}

export async function documentDeadline<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Document operation timed out')), 30_000);
    })]);
  } finally { clearTimeout(timer); }
}
