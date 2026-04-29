/**
 * Tests for GLM API Proxy.
 *
 * @module sdk/glm-proxy.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GLMProxyManager } from './glm-proxy.js';

// ---------------------------------------------------------------------------
// extractToolsFromSystem – unit tests
// ---------------------------------------------------------------------------

describe('GLMProxyManager.extractToolsFromSystem', () => {
  let proxy: GLMProxyManager;

  beforeEach(() => {
    GLMProxyManager.resetInstance();
    proxy = GLMProxyManager.getInstance({ targetBaseUrl: 'http://127.0.0.1:1' });
  });

  afterEach(() => {
    GLMProxyManager.resetInstance();
  });

  it('should extract a single tool definition', () => {
    const system = [
      'You are a helpful assistant.',
      '<functions>',
      '<function>{"name":"Bash","description":"Execute a bash command","parameters":{"type":"object","properties":{"command":{"type":"string","description":"The command to execute"}},"required":["command"]}}</function>',
      '</functions>',
      'Please follow instructions.',
    ].join('\n');

    const { tools, cleanSystem } = proxy.extractToolsFromSystem(system);

    expect(tools).toHaveLength(1);
    expect(tools[0]).toEqual({
      name: 'Bash',
      description: 'Execute a bash command',
      input_schema: {
        type: 'object',
        properties: { command: { type: 'string', description: 'The command to execute' } },
        required: ['command'],
      },
    });
    expect(cleanSystem).not.toContain('<functions>');
    expect(cleanSystem).toContain('You are a helpful assistant.');
    expect(cleanSystem).toContain('Please follow instructions.');
  });

  it('should extract multiple tool definitions', () => {
    const system = [
      '<functions>',
      '<function>{"name":"Bash","description":"Run bash","parameters":{"type":"object"}}</function>',
      '<function>{"name":"Read","description":"Read a file","parameters":{"type":"object"}}</function>',
      '<function>{"name":"Write","description":"Write a file","parameters":{"type":"object"}}</function>',
      '</functions>',
    ].join('\n');

    const { tools } = proxy.extractToolsFromSystem(system);

    expect(tools).toHaveLength(3);
    expect(tools.map(t => t.name)).toEqual(['Bash', 'Read', 'Write']);
  });

  it('should return empty tools when no <functions> block exists', () => {
    const system = 'Just a normal system prompt with no tools.';
    const { tools, cleanSystem } = proxy.extractToolsFromSystem(system);

    expect(tools).toHaveLength(0);
    expect(cleanSystem).toBe(system);
  });

  it('should skip malformed function definitions', () => {
    const system = [
      '<functions>',
      '<function>{"name":"Bash","description":"Run bash","parameters":{"type":"object"}}</function>',
      '<function>not valid json</function>',
      '<function>{"name":"Read","description":"Read a file","parameters":{"type":"object"}}</function>',
      '</functions>',
    ].join('\n');

    const { tools } = proxy.extractToolsFromSystem(system);

    expect(tools).toHaveLength(2);
    expect(tools.map(t => t.name)).toEqual(['Bash', 'Read']);
  });

  it('should skip function definitions without a name', () => {
    const system = [
      '<functions>',
      '<function>{"description":"No name tool","parameters":{"type":"object"}}</function>',
      '</functions>',
    ].join('\n');

    const { tools } = proxy.extractToolsFromSystem(system);

    expect(tools).toHaveLength(0);
  });

  it('should use default values for missing description and parameters', () => {
    const system = [
      '<functions>',
      '<function>{"name":"SimpleTool"}</function>',
      '</functions>',
    ].join('\n');

    const { tools } = proxy.extractToolsFromSystem(system);

    expect(tools).toHaveLength(1);
    expect(tools[0]).toEqual({
      name: 'SimpleTool',
      description: '',
      input_schema: { type: 'object', properties: {} },
    });
  });
});

// ---------------------------------------------------------------------------
// transformRequest – unit tests
// ---------------------------------------------------------------------------

describe('GLMProxyManager.transformRequest', () => {
  let proxy: GLMProxyManager;

  beforeEach(() => {
    GLMProxyManager.resetInstance();
    proxy = GLMProxyManager.getInstance({ targetBaseUrl: 'http://127.0.0.1:1' });
  });

  afterEach(() => {
    GLMProxyManager.resetInstance();
  });

  it('should transform system field and add tools', () => {
    const body = {
      model: 'glm-5.1',
      system: '<functions><function>{"name":"Bash","description":"Run","parameters":{"type":"object"}}</function></functions>Do stuff.',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 1024,
    };

    const result = proxy.transformRequest(body) as Record<string, unknown>;

    expect(result.system).toBe('Do stuff.');
    expect(result.tools).toEqual([
      { name: 'Bash', description: 'Run', input_schema: { type: 'object' } },
    ]);
    expect(result.model).toBe('glm-5.1');
    expect(result.messages).toEqual(body.messages);
  });

  it('should merge with existing tools array', () => {
    const body = {
      model: 'glm-5.1',
      system: '<functions><function>{"name":"Bash","description":"Run","parameters":{"type":"object"}}</function></functions>Do stuff.',
      messages: [],
      tools: [{ name: 'ExistingTool', description: 'Already there', input_schema: { type: 'object' } }],
    };

    const result = proxy.transformRequest(body) as Record<string, unknown>;
    const tools = result.tools as Array<Record<string, unknown>>;

    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe('ExistingTool');
    expect(tools[1].name).toBe('Bash');
  });

  it('should return body unchanged when system is not a string', () => {
    const body = {
      model: 'glm-5.1',
      system: [{ type: 'text', text: 'Hello' }],
      messages: [],
    };

    const result = proxy.transformRequest(body);
    expect(result).toEqual(body);
  });

  it('should return body unchanged when no functions block found', () => {
    const body = {
      model: 'glm-5.1',
      system: 'No tools here.',
      messages: [],
    };

    const result = proxy.transformRequest(body);
    expect(result).toEqual(body);
  });
});

// ---------------------------------------------------------------------------
// Proxy lifecycle tests
// ---------------------------------------------------------------------------

describe('GLMProxyManager lifecycle', () => {
  let proxy: GLMProxyManager;

  beforeEach(() => {
    GLMProxyManager.resetInstance();
    proxy = GLMProxyManager.getInstance({ targetBaseUrl: 'http://127.0.0.1:1' });
  });

  afterEach(async () => {
    await proxy.stop();
    GLMProxyManager.resetInstance();
  });

  it('should start and return a proxy URL', async () => {
    const url = await proxy.start();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(proxy.isRunning).toBe(true);
    expect(proxy.url).toBe(url);
  });

  it('should return same URL on double start', async () => {
    const url1 = await proxy.start();
    const url2 = await proxy.start();
    expect(url1).toBe(url2);
  });

  it('should stop cleanly', async () => {
    await proxy.start();
    await proxy.stop();
    expect(proxy.isRunning).toBe(false);
    expect(proxy.url).toBeNull();
  });

  it('should handle stop when not started', async () => {
    await expect(proxy.stop()).resolves.toBeUndefined();
  });

  it('should use singleton pattern', () => {
    const a = GLMProxyManager.getInstance({ targetBaseUrl: 'http://a.com' });
    const b = GLMProxyManager.getInstance({ targetBaseUrl: 'http://b.com' });
    expect(a).toBe(b);
  });

  it('should reset singleton', () => {
    const a = GLMProxyManager.getInstance({ targetBaseUrl: 'http://a.com' });
    GLMProxyManager.resetInstance();
    const b = GLMProxyManager.getInstance({ targetBaseUrl: 'http://b.com' });
    expect(a).not.toBe(b);
  });
});
