import { describe, expect, it } from 'vitest';
import { validateConfig } from './loader.js';
import type { DisclaudeConfig } from './types.js';

describe('removed execution role settings', () => {
  it.each(['primaryNode', 'primary', 'worker', 'nodeType', 'nodeId', 'nodeName', 'enableLocalExec', 'transport', 'runMode'])('rejects %s explicitly', (key) => {
    expect(validateConfig({ [key]: true } as DisclaudeConfig)).toBe(false);
  });
  it('preserves agent, channel and workspace configuration', () => {
    expect(validateConfig({
      workspace: { dir: '/tmp/workspace' },
      agents: { default: { backend: 'claude', llm: 'default' } },
      llms: { default: { model: 'sonnet', api: { protocol: 'anthropic' } } },
      channels: { feishu: { enabled: false } },
    } as DisclaudeConfig)).toBe(true);
  });
});
