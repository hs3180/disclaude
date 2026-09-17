import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectWorkIndex } from './work-index.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) {rmSync(root, { recursive: true, force: true });} });
function root() { const p = mkdtempSync(join(tmpdir(), 'work-index-')); roots.push(p); return p; }
function task(p: string, id: string, text: string) {
  const dir = join(p, 'tasks', id); mkdirSync(dir, { recursive: true });
  const file = join(dir, 'TASK.md'); writeFileSync(file, text); return file;
}
describe('project file work index', () => {
  it('projects current files and document links without modifying or caching task content', () => {
    const p = root();
    const file = task(p, 'archive', '# Archive options\nhttps://tenant.feishu.cn/docx/abc123\nStill investigating.');
    const before = readFileSync(file, 'utf8');
    expect(projectWorkIndex(p)).toEqual(['- Archive options（archive） · [文档](https://tenant.feishu.cn/docx/abc123)']);
    expect(readFileSync(file, 'utf8')).toBe(before);
    writeFileSync(file, '# Revised scope\n');
    expect(projectWorkIndex(p)).toEqual(['- Revised scope（archive）']);
    expect(projectWorkIndex(root())).toEqual([]);
  });
  it('does not traverse linked task directories, task files or task roots', () => {
    const outside = root(), p = root(); task(outside, 'private', '# PRIVATE');
    mkdirSync(join(p, 'tasks'));
    symlinkSync(join(outside, 'tasks', 'private'), join(p, 'tasks', 'linked'));
    mkdirSync(join(p, 'tasks', 'file'));
    symlinkSync(join(outside, 'tasks', 'private', 'TASK.md'), join(p, 'tasks', 'file', 'TASK.md'));
    expect(projectWorkIndex(p)).toEqual([]);
    const linkedRoot = root(); symlinkSync(join(outside, 'tasks'), join(linkedRoot, 'tasks'));
    expect(projectWorkIndex(linkedRoot).join('')).not.toContain('PRIVATE');
    expect(projectWorkIndex(linkedRoot).join('')).toContain('符号链接');
  });
  it('bounds output and does not turn hostile titles or unrelated URLs into links', () => {
    const p = root();
    for (let n = 0; n < 12; n++) {task(p, `task-${n}`, '# [Click](anything)*\nhttps://feishu.cn.evil.invalid/docx/abc');}
    const lines = projectWorkIndex(p);
    expect(lines).toHaveLength(11);
    expect(lines.join('\n')).not.toContain('[文档]');
    expect(lines[0]).not.toContain('[Click]');
    expect(lines[10]).toContain('前 10 项');
  });
});
