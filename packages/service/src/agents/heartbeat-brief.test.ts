import { describe, it, expect } from 'vitest';
import {
  buildHeartbeatBrief,
  cleanHeartbeatLabel,
  HEARTBEAT_BRIEF_MAX_LINE,
  HEARTBEAT_BRIEF_PREFIX,
  labelForToolUse,
  normalizeHeartbeatDetail,
  type HeartbeatToolNote,
} from './heartbeat-brief.js';

const note = (toolName: string, label?: string, source?: HeartbeatToolNote['source']): HeartbeatToolNote =>
  ({ toolName, ...(label === undefined ? {} : { label, source }) });

describe('Issue #5762 (T-120): heartbeat brief label whitelist', () => {
  it('reads Bash.description only — never the command body (SECRET stays internal)', () => {
    const labelled = labelForToolUse('Bash', { command: 'curl -H "Authorization: Bearer SECRET-TOKEN-123"', description: '校验调色板对比度' });
    expect(labelled).toEqual({ label: '校验调色板对比度', source: 'bash-desc' });
    // No description → no label; the command is never a fallback.
    expect(labelForToolUse('Bash', { command: 'pnpm test' })).toBeUndefined();
  });

  it('prefers the in-progress todo activeForm, then its content', () => {
    expect(labelForToolUse('TodoWrite', {
      todos: [{ content: '已完成', status: 'completed' }, { content: '修复表格溢出', status: 'in_progress', activeForm: '正在修复表格' }],
    })).toEqual({ label: '正在修复表格', source: 'todo' });
    expect(labelForToolUse('TodoWrite', { todos: [{ content: '修复表格溢出', status: 'in_progress' }] }))
      .toEqual({ label: '修复表格溢出', source: 'todo' });
    expect(labelForToolUse('TodoWrite', { todos: [{ content: '全部完成', status: 'completed' }] })).toBeUndefined();
  });

  it('publishes file basenames only, and only for file tools', () => {
    expect(labelForToolUse('Edit', { file_path: '/home/user/secret-project/src/app.js', old_string: 'PRIVATE', new_string: 'PRIVATE' }))
      .toEqual({ label: 'app.js', source: 'file' });
    expect(labelForToolUse('Read', { file_path: 'C:\\work\\deep\\notes.md' })).toEqual({ label: 'notes.md', source: 'file' });
    expect(labelForToolUse('WebFetch', { url: 'https://user:pass@example.com/x' })).toBeUndefined();
    expect(labelForToolUse('Skill', { skill: 'dataviz' })).toEqual({ label: 'dataviz', source: 'skill' });
    expect(labelForToolUse('Agent', { description: 'review:palette', subagent_type: 'explore', prompt: 'PRIVATE' }))
      .toEqual({ label: 'review:palette（explore）', source: 'agent-desc' });
  });

  it('fails closed: URLs, credential-looking assignments and malformed input yield no label', () => {
    expect(cleanHeartbeatLabel('打开 https://user:pass@example.com/docs')).toBeUndefined();
    expect(cleanHeartbeatLabel('设置 API_KEY=sk-live-123')).toBeUndefined();
    expect(cleanHeartbeatLabel('   ')).toBeUndefined();
    expect(cleanHeartbeatLabel(42)).toBeUndefined();
    expect(cleanHeartbeatLabel('a\nb\tc')).toBe('a b c');
    // Same guard applies inside every tool.
    expect(labelForToolUse('Bash', { description: 'export token=abc', command: 'x' })).toBeUndefined();
    expect(labelForToolUse('Bash', 'not-an-object')).toBeUndefined();
  });
});

describe('Issue #5762 (T-120): heartbeat brief line', () => {
  const usage = new Map([['Bash', 10], ['Edit', 12], ['Read', 9], ['Playwright', 6], ['Grep', 1]]);

  it('off = the pre-#5762 heartbeat: no line at all', () => {
    expect(buildHeartbeatBrief('off', { notes: [note('Bash', 'x', 'bash-desc')], usage })).toEqual({ source: 'off', length: 0 });
    expect(normalizeHeartbeatDetail(undefined)).toBe('labels');
    expect(normalizeHeartbeatDetail('bogus')).toBe('labels');
    expect(normalizeHeartbeatDetail('tools')).toBe('tools');
  });

  it('labels (default): last distinct labels oldest → newest with the window tool mix, source = newest label', () => {
    const brief = buildHeartbeatBrief('labels', {
      notes: [note('TodoWrite', '修复 390px 表格溢出', 'todo'), note('Bash', '重跑渲染检查', 'bash-desc'), note('Edit', 'app.js', 'file'), note('Grep')],
      usage,
    });
    expect(brief.source).toBe('file');
    expect(brief.line).toBe(`${HEARTBEAT_BRIEF_PREFIX}修复 390px 表格溢出 → 重跑渲染检查 → app.js（Edit×12、Bash×10、Read×9、Playwright×6）`);
    expect(brief.length).toBe(brief.line?.length);
  });

  it('tools: the window tool mix only', () => {
    const brief = buildHeartbeatBrief('tools', { notes: [note('Bash', '重跑渲染检查', 'bash-desc')], usage });
    expect(brief.source).toBe('tool-mix');
    expect(brief.line).toBe(`${HEARTBEAT_BRIEF_PREFIX}Edit×12、Bash×10、Read×9、Playwright×6`);
  });

  it('falls back to the tool mix without labels, and to none without either', () => {
    expect(buildHeartbeatBrief('labels', { notes: [note('gh'), note('gh')], usage: new Map([['gh', 2]]) }))
      .toEqual({ line: `${HEARTBEAT_BRIEF_PREFIX}gh×2`, source: 'tool-mix', length: `${HEARTBEAT_BRIEF_PREFIX}gh×2`.length });
    expect(buildHeartbeatBrief('labels', { notes: [], usage: new Map() })).toEqual({ source: 'none', length: 0 });
    expect(buildHeartbeatBrief('tools', { notes: [], usage: new Map() })).toEqual({ source: 'none', length: 0 });
  });

  it('timer backstop names the awaited tool (#5719) with its elapsed wait', () => {
    const brief = buildHeartbeatBrief('labels', {
      notes: [], usage: new Map(), waiting: { toolName: 'Browser', label: '渲染 390px 截图', source: 'bash-desc', elapsedText: '10 分钟' },
    });
    expect(brief).toMatchObject({ line: `${HEARTBEAT_BRIEF_PREFIX}等待「渲染 390px 截图」（Browser，已 10 分钟）`, source: 'bash-desc' });
    expect(brief.length).toBe(brief.line?.length);
    // Unlabelled tool → tool name only.
    expect(buildHeartbeatBrief('labels', { notes: [], usage: new Map(), waiting: { toolName: 'gh', elapsedText: '30 秒' } }).line)
      .toBe(`${HEARTBEAT_BRIEF_PREFIX}等待「gh」（gh，已 30 秒）`);
  });

  it('is bounded to one line of at most 80 code units with an ellipsis, mix dropped first', () => {
    const long = (c: string) => c.repeat(30);
    const brief = buildHeartbeatBrief('labels', {
      notes: [note('Bash', long('甲'), 'bash-desc'), note('Bash', long('乙'), 'bash-desc'), note('Bash', long('丙'), 'bash-desc')],
      usage,
    });
    expect(brief.line?.startsWith(HEARTBEAT_BRIEF_PREFIX)).toBe(true);
    expect(brief.line?.length).toBeLessThanOrEqual(HEARTBEAT_BRIEF_MAX_LINE);
    expect(brief.line?.endsWith('…')).toBe(true);
    expect(brief.line).not.toContain('Edit×12');
    // Exactly at the cap without truncation: no ellipsis is added.
    const fitting = buildHeartbeatBrief('labels', { notes: [note('Bash', '乙', 'bash-desc')], usage: new Map([['Bash', 1]]) });
    expect(fitting.line).toBe(`${HEARTBEAT_BRIEF_PREFIX}乙（Bash×1）`);
    expect(fitting.length).toBe(fitting.line?.length);
  });
});
