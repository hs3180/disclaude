import { describe, expect, it } from 'vitest';
import { validateConfig } from './loader.js';
import type { DisclaudeConfig } from './types.js';

describe('removed execution role settings', () => {
  it.each(['primaryNode', 'primary', 'worker', 'nodeType', 'nodeId', 'nodeName', 'enableLocalExec'])('rejects %s explicitly', (key) => {
    expect(validateConfig({ [key]: true } as DisclaudeConfig)).toBe(false);
  });
  it('preserves agent, channel and workspace configuration', () => {
    expect(validateConfig({ agent: { agentBackend: 'claude' }, channels: { feishu: { enabled: false } }, workspace: { dir: '/tmp/workspace' } } as DisclaudeConfig)).toBe(true);
  });
});
