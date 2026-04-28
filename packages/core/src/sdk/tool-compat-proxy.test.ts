/**
 * Unit tests for Tool Compatibility Proxy (Issue #2943).
 *
 * Tests the proxy's request transformation logic (tool injection)
 * and proxy lifecycle management.
 *
 * HTTP integration tests are placed in tests/integration/ since
 * the global nock setup blocks localhost connections in unit tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  injectToolDefinitions,
  SYSTEM_TOOL_DEFINITIONS,
  startToolCompatProxy,
  stopToolCompatProxy,
  getActiveProxy,
} from './tool-compat-proxy.js';

describe('injectToolDefinitions', () => {
  it('should inject system tools when request has no existing tools', () => {
    const body = {
      model: 'glm-5.1',
      messages: [{ role: 'user', content: 'hello' }],
      system: 'You are a helpful assistant.',
    };

    const result = injectToolDefinitions(body);

    expect(result.tools).toBeDefined();
    expect(Array.isArray(result.tools)).toBe(true);
    expect((result.tools as unknown[]).length).toBe(SYSTEM_TOOL_DEFINITIONS.length);
    expect(result.model).toBe('glm-5.1');
    expect(result.system).toBe('You are a helpful assistant.');

    // Verify tool names
    const toolNames = (result.tools as Array<{ name: string }>).map(t => t.name);
    expect(toolNames).toContain('Bash');
    expect(toolNames).toContain('Read');
    expect(toolNames).toContain('Write');
    expect(toolNames).toContain('Edit');
    expect(toolNames).toContain('Glob');
    expect(toolNames).toContain('Grep');
  });

  it('should merge system tools with existing tools (system tools first)', () => {
    const existingTools = [
      {
        name: 'mcp__playwright__navigate',
        description: 'Navigate to URL',
        input_schema: { type: 'object', properties: { url: { type: 'string' } } },
      },
    ];

    const body = {
      model: 'glm-5.1',
      messages: [{ role: 'user', content: 'hello' }],
      tools: existingTools,
    };

    const result = injectToolDefinitions(body);

    expect(result.tools).toBeDefined();
    const tools = result.tools as Array<{ name: string }>;
    expect(tools.length).toBe(SYSTEM_TOOL_DEFINITIONS.length + 1);

    // System tools should come first
    expect(tools[0].name).toBe('Bash');
    expect(tools[1].name).toBe('Read');

    // Existing MCP tool should be preserved at the end
    expect(tools[tools.length - 1].name).toBe('mcp__playwright__navigate');
  });

  it('should not duplicate tools when system tools already exist', () => {
    const existingTools = [
      {
        name: 'Bash',
        description: 'Already existing Bash tool',
        input_schema: { type: 'object', properties: {} },
      },
    ];

    const body = {
      model: 'glm-5.1',
      messages: [{ role: 'user', content: 'hello' }],
      tools: existingTools,
    };

    const result = injectToolDefinitions(body);

    const tools = result.tools as Array<{ name: string }>;
    const bashCount = tools.filter(t => t.name === 'Bash').length;
    expect(bashCount).toBe(1);

    // Original Bash tool should be preserved
    const bashTool = tools.find(t => t.name === 'Bash') as { name: string; description: string } | undefined;
    expect(bashTool?.description).toBe('Already existing Bash tool');

    // Other system tools should still be injected
    expect(tools.some(t => t.name === 'Read')).toBe(true);
    expect(tools.some(t => t.name === 'Write')).toBe(true);
  });

  it('should preserve all other request fields', () => {
    const body = {
      model: 'glm-5.1',
      max_tokens: 4096,
      stream: true,
      messages: [{ role: 'user', content: 'hello' }],
      system: 'You are a helpful assistant.',
      metadata: { user_id: 'test' },
    };

    const result = injectToolDefinitions(body);

    expect(result.model).toBe('glm-5.1');
    expect(result.max_tokens).toBe(4096);
    expect(result.stream).toBe(true);
    expect(result.messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect(result.system).toBe('You are a helpful assistant.');
    expect(result.metadata).toEqual({ user_id: 'test' });
  });

  it('should return unchanged body when all system tools already exist', () => {
    const body = {
      model: 'glm-5.1',
      messages: [{ role: 'user', content: 'hello' }],
      tools: SYSTEM_TOOL_DEFINITIONS.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
      })),
    };

    const result = injectToolDefinitions(body);

    const tools = result.tools as Array<{ name: string }>;
    expect(tools.length).toBe(SYSTEM_TOOL_DEFINITIONS.length);
  });

  it('should handle partial overlap (some tools exist, some missing)', () => {
    const existingTools = [
      { name: 'Bash', description: 'Bash', input_schema: {} },
      { name: 'Read', description: 'Read', input_schema: {} },
    ];

    const body = {
      model: 'glm-5.1',
      messages: [{ role: 'user', content: 'hello' }],
      tools: existingTools,
    };

    const result = injectToolDefinitions(body);

    const tools = result.tools as Array<{ name: string }>;
    // Bash and Read already exist, so only the remaining tools are injected
    expect(tools.length).toBe(SYSTEM_TOOL_DEFINITIONS.length);
    // No duplicates
    const names = tools.map(t => t.name);
    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toBe(names.length);
  });
});

describe('SYSTEM_TOOL_DEFINITIONS', () => {
  it('should have all required system tools', () => {
    const names = SYSTEM_TOOL_DEFINITIONS.map(t => t.name);
    expect(names).toContain('Bash');
    expect(names).toContain('Read');
    expect(names).toContain('Write');
    expect(names).toContain('Edit');
    expect(names).toContain('Glob');
    expect(names).toContain('Grep');
    expect(names).toContain('NotebookEdit');
    expect(names).toContain('WebSearch');
    expect(names).toContain('WebFetch');
    expect(names).toContain('TodoWrite');
    expect(names).toContain('AskUserQuestion');
  });

  it('each tool should have valid Anthropic API format', () => {
    for (const tool of SYSTEM_TOOL_DEFINITIONS) {
      expect(tool.name).toBeTruthy();
      expect(typeof tool.name).toBe('string');
      expect(tool.description).toBeTruthy();
      expect(typeof tool.description).toBe('string');
      expect(tool.input_schema).toBeDefined();
      expect((tool.input_schema as Record<string, unknown>).type).toBe('object');
      expect((tool.input_schema as Record<string, unknown>).properties).toBeDefined();
    }
  });

  it('Bash tool should have command as required property', () => {
    const bash = SYSTEM_TOOL_DEFINITIONS.find(t => t.name === 'Bash');
    expect(bash).toBeDefined();
    const schema = bash!.input_schema as { required: string[] };
    expect(schema.required).toContain('command');
  });

  it('Read tool should have file_path as required property', () => {
    const read = SYSTEM_TOOL_DEFINITIONS.find(t => t.name === 'Read');
    expect(read).toBeDefined();
    const schema = read!.input_schema as { required: string[] };
    expect(schema.required).toContain('file_path');
  });

  it('Write tool should have file_path and content as required properties', () => {
    const write = SYSTEM_TOOL_DEFINITIONS.find(t => t.name === 'Write');
    expect(write).toBeDefined();
    const schema = write!.input_schema as { required: string[] };
    expect(schema.required).toContain('file_path');
    expect(schema.required).toContain('content');
  });

  it('Edit tool should have required properties', () => {
    const edit = SYSTEM_TOOL_DEFINITIONS.find(t => t.name === 'Edit');
    expect(edit).toBeDefined();
    const schema = edit!.input_schema as { required: string[] };
    expect(schema.required).toContain('file_path');
    expect(schema.required).toContain('old_string');
    expect(schema.required).toContain('new_string');
  });

  it('all tool names should be unique', () => {
    const names = SYSTEM_TOOL_DEFINITIONS.map(t => t.name);
    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toBe(names.length);
  });
});

describe('Proxy lifecycle', () => {
  beforeEach(() => {
    stopToolCompatProxy();
  });

  afterEach(() => {
    stopToolCompatProxy();
  });

  it('should start proxy and return proxy URL', async () => {
    const proxy = await startToolCompatProxy('https://open.bigmodel.cn/api/anthropic');

    expect(proxy.proxyUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(proxy.targetUrl).toBe('https://open.bigmodel.cn/api/anthropic');
    expect(proxy.stopped).toBe(false);

    stopToolCompatProxy();
  });

  it('should return existing proxy for same target URL', async () => {
    const proxy1 = await startToolCompatProxy('https://open.bigmodel.cn/api/anthropic');
    const proxy2 = await startToolCompatProxy('https://open.bigmodel.cn/api/anthropic');

    expect(proxy1.proxyUrl).toBe(proxy2.proxyUrl);
    expect(proxy1).toBe(proxy2); // Same instance

    stopToolCompatProxy();
  });

  it('getActiveProxy should return null when no proxy is running', () => {
    expect(getActiveProxy()).toBeNull();
  });

  it('getActiveProxy should return proxy when running', async () => {
    const proxy = await startToolCompatProxy('https://open.bigmodel.cn/api/anthropic');
    const active = getActiveProxy();

    expect(active).toBe(proxy);

    stopToolCompatProxy();
  });

  it('stopToolCompatProxy should stop the proxy', async () => {
    const proxy = await startToolCompatProxy('https://open.bigmodel.cn/api/anthropic');
    expect(proxy.stopped).toBe(false);

    stopToolCompatProxy();
    expect(getActiveProxy()).toBeNull();
  });

  it('stopToolCompatProxy should be idempotent', () => {
    // Should not throw when no proxy is running
    stopToolCompatProxy();
    stopToolCompatProxy();
  });
});
