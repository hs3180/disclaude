import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';

/** Read-only projection of an explicitly bound project's file convention. */
export function projectWorkIndex(projectDir: string): string[] {
  const directory = join(projectDir, 'tasks');
  try {
    if (lstatSync(directory).isSymbolicLink()) {return ['任务目录不可读取：不跟随符号链接。'];}
    const root = realpathSync(directory);
    const names = readdirSync(root).sort();
    const lines: string[] = [];
    let omitted = false;
    for (const name of names) {
      if (!/^[\p{L}\p{N}][\p{L}\p{N}_-]{0,127}$/u.test(name)) {continue;}
      const task = join(root, name);
      let fd: number | undefined;
      try {
        const info = lstatSync(task);
        if (!info.isDirectory() || info.isSymbolicLink()) {continue;}
        const file = join(task, 'TASK.md');
        const fileInfo = lstatSync(file);
        if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) {continue;}
        const resolved = realpathSync(file);
        if (!resolved.startsWith(root + sep)) {continue;}
        fd = openSync(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
        if (!fstatSync(fd).isFile()) {continue;}
        if (lines.length >= 10) {omitted = true; break;}
        // Bound memory and chat output even for an unexpectedly large task file.
        const buffer = Buffer.alloc(16_384);
        const source = buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0)).toString('utf8');
        const heading = source.match(/^#\s+(.+)$/m)?.[1] ?? name;
        const title = heading.replace(/[\[\]<>`*_\\]/g, '').trim().slice(0, 100);
        const rawLink = source.match(/https:\/\/[^\s<>"'()]+\/(?:docx|wiki)\/[a-zA-Z0-9]+/)?.[0];
        let link = '';
        if (rawLink && rawLink.length <= 512) {
          try {
            const url = new URL(rawLink);
            if (!url.username && !url.password && /(^|\.)(feishu\.cn|larksuite\.com)$/.test(url.hostname)) {
              link = ` · [文档](${url.href})`;
            }
          } catch { /* Malformed content is not a navigation target. */ }
        }
        lines.push(`- ${title || name}（${name}）${link}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          return [...lines, '部分任务记录不可读取；原文件未修改。'];
        }
      } finally { if (fd !== undefined) {closeSync(fd);} }
    }
    if (omitted) {lines.push('仅列出前 10 项；可在聊天中指定任务名称继续定位。');}
    return lines;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? [] : ['任务目录不可读取；原文件未修改。'];
  }
}
