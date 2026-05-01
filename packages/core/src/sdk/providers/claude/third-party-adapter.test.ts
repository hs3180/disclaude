/**
 * Tests for Third-party Tool Adapter (Issue #2948)
 *
 * Tests tool extraction from system prompt XML format and
 * conversion to the `tools` API parameter format.
 */

import { describe, it, expect } from 'vitest';
import {
  extractToolsFromSystemPrompt,
  transformRequestBodyForThirdParty,
} from './third-party-adapter.js';

// ============================================================================
// extractToolsFromSystemPrompt
// ============================================================================

describe('extractToolsFromSystemPrompt', () => {
  it('should extract tools from <functions> XML format', () => {
    const systemPrompt = `You are Claude Code, an AI assistant.

<functions>
<function>{"description": "Execute a bash command", "name": "Bash", "parameters": {"type": "object", "properties": {"command": {"type": "string", "description": "The bash command to run"}}, "required": ["command"]}}</function>
<function>{"description": "Read a file", "name": "Read", "parameters": {"type": "object", "properties": {"file_path": {"type": "string", "description": "The absolute path"}}, "required": ["file_path"]}}</function>
</functions>

Use these tools to help the user.`;

    const result = extractToolsFromSystemPrompt(systemPrompt);

    expect(result.found).toBe(true);
    expect(result.tools).toHaveLength(2);
    expect(result.tools[0].name).toBe('Bash');
    expect(result.tools[0].description).toBe('Execute a bash command');
    expect(result.tools[0].input_schema.type).toBe('object');
    expect(result.tools[0].input_schema.required).toEqual(['command']);
    expect(result.tools[1].name).toBe('Read');
  });

  it('should extract tools from <available_tools> XML format', () => {
    const systemPrompt = `You have access to tools.

<available_tools>
<tool>{"description": "Edit a file", "name": "Edit", "parameters": {"type": "object", "properties": {"file_path": {"type": "string"}}, "required": ["file_path"]}}</tool>
<tool>{"description": "Write a file", "name": "Write", "parameters": {"type": "object", "properties": {"file_path": {"type": "string"}, "content": {"type": "string"}}, "required": ["file_path", "content"]}}</tool>
</available_tools>`;

    const result = extractToolsFromSystemPrompt(systemPrompt);

    expect(result.found).toBe(true);
    expect(result.tools).toHaveLength(2);
    expect(result.tools[0].name).toBe('Edit');
    expect(result.tools[1].name).toBe('Write');
  });

  it('should handle tools with input_schema field instead of parameters', () => {
    const systemPrompt = `<functions>
<function>{"description": "Search for patterns", "name": "Grep", "input_schema": {"type": "object", "properties": {"pattern": {"type": "string"}}, "required": ["pattern"]}}</function>
</functions>`;

    const result = extractToolsFromSystemPrompt(systemPrompt);

    expect(result.found).toBe(true);
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('Grep');
    expect(result.tools[0].input_schema.required).toEqual(['pattern']);
  });

  it('should return empty result for system prompt without tools', () => {
    const systemPrompt = 'You are a helpful assistant. Answer questions to the best of your ability.';
    const result = extractToolsFromSystemPrompt(systemPrompt);

    expect(result.found).toBe(false);
    expect(result.tools).toHaveLength(0);
  });

  it('should return empty result for empty string', () => {
    const result = extractToolsFromSystemPrompt('');
    expect(result.found).toBe(false);
    expect(result.tools).toHaveLength(0);
  });

  it('should skip malformed JSON in function tags', () => {
    const systemPrompt = `<functions>
<function>not valid json</function>
<function>{"description": "A tool", "name": "ValidTool", "parameters": {"type": "object", "properties": {}}}</function>
</functions>`;

    const result = extractToolsFromSystemPrompt(systemPrompt);

    expect(result.found).toBe(true);
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('ValidTool');
  });

  it('should skip function definitions missing required fields', () => {
    const systemPrompt = `<functions>
<function>{"name": "NoDesc"}</function>
<function>{"description": "NoName"}</function>
<function>{"description": "Valid", "name": "Valid", "parameters": {"type": "object"}}</function>
</functions>`;

    const result = extractToolsFromSystemPrompt(systemPrompt);

    expect(result.found).toBe(true);
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('Valid');
  });

  it('should handle complex tool parameters with nested properties', () => {
    const systemPrompt = `<functions>
<function>{"description": "Search files", "name": "Glob", "parameters": {"type": "object", "properties": {"pattern": {"type": "string", "description": "Glob pattern"}, "path": {"type": "string", "description": "Base directory"}}, "required": ["pattern"]}}</function>
</functions>`;

    const result = extractToolsFromSystemPrompt(systemPrompt);

    expect(result.found).toBe(true);
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('Glob');
    expect(result.tools[0].input_schema.properties).toHaveProperty('pattern');
    expect(result.tools[0].input_schema.properties).toHaveProperty('path');
  });

  it('should extract many tools at once', () => {
    const tools = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch'];
    const toolDefs = tools.map(name =>
      `<function>{"description": "${name} tool", "name": "${name}", "parameters": {"type": "object", "properties": {"input": {"type": "string"}}}}</function>`
    ).join('\n');

    const systemPrompt = `<functions>\n${toolDefs}\n</functions>`;
    const result = extractToolsFromSystemPrompt(systemPrompt);

    expect(result.found).toBe(true);
    expect(result.tools).toHaveLength(8);
    expect(result.tools.map(t => t.name).sort()).toEqual(tools.sort());
  });
});

// ============================================================================
// transformRequestBodyForThirdParty
// ============================================================================

describe('transformRequestBodyForThirdParty', () => {
  const systemPromptWithTools = `<functions>
<function>{"description": "Execute a bash command", "name": "Bash", "parameters": {"type": "object", "properties": {"command": {"type": "string", "description": "The command"}}, "required": ["command"]}}</function>
<function>{"description": "Read a file", "name": "Read", "parameters": {"type": "object", "properties": {"file_path": {"type": "string", "description": "File path"}}, "required": ["file_path"]}}</function>
</functions>`;

  it('should inject extracted tools into request body with string system', () => {
    const body = JSON.stringify({
      model: 'glm-5.1',
      system: systemPromptWithTools,
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 4096,
    });

    const result = transformRequestBodyForThirdParty(body);
    const parsed = JSON.parse(result);

    expect(parsed.tools).toBeDefined();
    expect(parsed.tools).toHaveLength(2);
    expect(parsed.tools[0].name).toBe('Bash');
    expect(parsed.tools[1].name).toBe('Read');
    // Original fields should be preserved
    expect(parsed.model).toBe('glm-5.1');
    expect(parsed.system).toBe(systemPromptWithTools);
    expect(parsed.max_tokens).toBe(4096);
  });

  it('should inject extracted tools into request body with array system', () => {
    const body = JSON.stringify({
      model: 'glm-5.1',
      system: [
        { type: 'text', text: systemPromptWithTools },
        { type: 'text', text: 'Additional context' },
      ],
      messages: [{ role: 'user', content: 'Hello' }],
    });

    const result = transformRequestBodyForThirdParty(body);
    const parsed = JSON.parse(result);

    expect(parsed.tools).toBeDefined();
    expect(parsed.tools).toHaveLength(2);
    expect(parsed.tools[0].name).toBe('Bash');
  });

  it('should merge with existing tools in request body', () => {
    const existingMcpTool = {
      name: 'send_text',
      description: 'Send a text message',
      input_schema: { type: 'object', properties: { text: { type: 'string' } } },
    };

    const body = JSON.stringify({
      model: 'glm-5.1',
      system: systemPromptWithTools,
      messages: [],
      tools: [existingMcpTool],
    });

    const result = transformRequestBodyForThirdParty(body);
    const parsed = JSON.parse(result);

    expect(parsed.tools).toHaveLength(3); // 2 extracted + 1 existing
    expect(parsed.tools.map((t: {name: string}) => t.name)).toContain('send_text');
    expect(parsed.tools.map((t: {name: string}) => t.name)).toContain('Bash');
    expect(parsed.tools.map((t: {name: string}) => t.name)).toContain('Read');
  });

  it('should not duplicate tools already in tools parameter', () => {
    const existingBash = {
      name: 'Bash',
      description: 'Execute a bash command',
      input_schema: { type: 'object', properties: {} },
    };

    const body = JSON.stringify({
      model: 'glm-5.1',
      system: systemPromptWithTools,
      messages: [],
      tools: [existingBash],
    });

    const result = transformRequestBodyForThirdParty(body);
    const parsed = JSON.parse(result);

    const bashTools = parsed.tools.filter((t: { name: string }) => t.name === 'Bash');
    expect(bashTools).toHaveLength(1); // No duplicate
    expect(parsed.tools.map((t: { name: string }) => t.name)).toContain('Read');
  });

  it('should return original body when no system prompt', () => {
    const body = JSON.stringify({
      model: 'glm-5.1',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 100,
    });

    const result = transformRequestBodyForThirdParty(body);
    expect(result).toBe(body);
  });

  it('should return original body when no tools in system prompt', () => {
    const body = JSON.stringify({
      model: 'glm-5.1',
      system: 'You are a helpful assistant.',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    const result = transformRequestBodyForThirdParty(body);
    expect(result).toBe(body);
  });

  it('should return original body for invalid JSON', () => {
    const body = 'not valid json {{{';
    const result = transformRequestBodyForThirdParty(body);
    expect(result).toBe(body);
  });

  it('should preserve all original request fields', () => {
    const body = JSON.stringify({
      model: 'glm-5.1',
      system: systemPromptWithTools,
      messages: [{ role: 'user', content: 'Test' }],
      max_tokens: 8192,
      stream: true,
      temperature: 0.7,
      metadata: { user_id: 'test' },
    });

    const result = transformRequestBodyForThirdParty(body);
    const parsed = JSON.parse(result);

    expect(parsed.model).toBe('glm-5.1');
    expect(parsed.max_tokens).toBe(8192);
    expect(parsed.stream).toBe(true);
    expect(parsed.temperature).toBe(0.7);
    expect(parsed.metadata).toEqual({ user_id: 'test' });
    expect(parsed.tools).toHaveLength(2);
  });

  it('should handle empty system string', () => {
    const body = JSON.stringify({
      model: 'glm-5.1',
      system: '',
      messages: [],
    });

    const result = transformRequestBodyForThirdParty(body);
    expect(result).toBe(body);
  });

  it('should handle system array with non-text blocks', () => {
    const body = JSON.stringify({
      model: 'glm-5.1',
      system: [
        { type: 'image', source: { type: 'base64' } },
        { type: 'text', text: systemPromptWithTools },
      ],
      messages: [],
    });

    const result = transformRequestBodyForThirdParty(body);
    const parsed = JSON.parse(result);

    expect(parsed.tools).toBeDefined();
    expect(parsed.tools).toHaveLength(2);
  });
});
