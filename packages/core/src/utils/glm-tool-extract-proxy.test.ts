/**
 * Tests for GLM Tool Extract Proxy.
 *
 * @module utils/glm-tool-extract-proxy.test
 */

import { describe, it, expect } from 'vitest';
import {
  extractToolsFromSystemPrompt,
  transformRequestBody,
  type AnthropicRequestBody,
} from './glm-tool-extract-proxy.js';

describe('extractToolsFromSystemPrompt', () => {
  it('should extract tools in Format A (<tool name="...">)', () => {
    const systemPrompt = `You are a helpful assistant.

<tool name="Bash">
<description>Executes a given bash command</description>
<parameters>{"type":"object","properties":{"command":{"type":"string","description":"The command to execute"}},"required":["command"]}</parameters>
</tool>

<tool name="Read">
<description>Reads a file from the filesystem</description>
<parameters>{"type":"object","properties":{"file_path":{"type":"string","description":"The path to read"}},"required":["file_path"]}</parameters>
</tool>

Please assist the user.`;

    const result = extractToolsFromSystemPrompt(systemPrompt);

    expect(result.tools).toHaveLength(2);
    expect(result.tools[0]).toEqual({
      name: 'Bash',
      description: 'Executes a given bash command',
      input_schema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command to execute' },
        },
        required: ['command'],
      },
    });
    expect(result.tools[1]).toEqual({
      name: 'Read',
      description: 'Reads a file from the filesystem',
      input_schema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'The path to read' },
        },
        required: ['file_path'],
      },
    });

    // Verify system prompt is cleaned
    expect(result.cleanedSystem).not.toContain('<tool');
    expect(result.cleanedSystem).not.toContain('</tool>');
    expect(result.cleanedSystem).toContain('You are a helpful assistant.');
    expect(result.cleanedSystem).toContain('Please assist the user.');
  });

  it('should extract tools in Format B (<tool_description>)', () => {
    const systemPrompt = `System prompt here.

<tool_description>
<tool_name>Edit</tool_name>
<description>Edits a file</description>
<parameters>{"type":"object","properties":{"file_path":{"type":"string"}}}</parameters>
</tool_description>

End of prompt.`;

    const result = extractToolsFromSystemPrompt(systemPrompt);

    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('Edit');
    expect(result.tools[0].description).toBe('Edits a file');
    expect(result.tools[0].input_schema).toEqual({
      type: 'object',
      properties: { file_path: { type: 'string' } },
    });
  });

  it('should handle mixed format A and B tools', () => {
    const systemPrompt = `<tool name="Glob">
<description>Find files</description>
<parameters>{"type":"object","properties":{"pattern":{"type":"string"}}}</parameters>
</tool>

<tool_description>
<tool_name>Grep</tool_name>
<description>Search content</description>
<parameters>{"type":"object","properties":{"pattern":{"type":"string"}}}</parameters>
</tool_description>`;

    const result = extractToolsFromSystemPrompt(systemPrompt);

    expect(result.tools).toHaveLength(2);
    expect(result.tools[0].name).toBe('Glob');
    expect(result.tools[1].name).toBe('Grep');
  });

  it('should return empty tools for system prompt without XML blocks', () => {
    const systemPrompt = 'You are a helpful coding assistant. Use the available tools to help the user.';

    const result = extractToolsFromSystemPrompt(systemPrompt);

    expect(result.tools).toHaveLength(0);
    expect(result.cleanedSystem).toBe(systemPrompt);
  });

  it('should skip tool blocks without parameters', () => {
    const systemPrompt = `<tool name="BrokenTool">
<description>A tool without parameters</description>
</tool>`;

    const result = extractToolsFromSystemPrompt(systemPrompt);

    expect(result.tools).toHaveLength(0);
  });

  it('should skip tool blocks with invalid JSON parameters', () => {
    const systemPrompt = `<tool name="BadJson">
<description>A tool with bad JSON</description>
<parameters>not valid json{</parameters>
</tool>`;

    const result = extractToolsFromSystemPrompt(systemPrompt);

    expect(result.tools).toHaveLength(0);
  });

  it('should handle empty description', () => {
    const systemPrompt = `<tool_description>
<tool_name>MinimalTool</tool_name>
<parameters>{"type":"object","properties":{}}</parameters>
</tool_description>`;

    const result = extractToolsFromSystemPrompt(systemPrompt);

    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('MinimalTool');
    expect(result.tools[0].description).toBe('');
  });

  it('should clean up excessive blank lines in the result', () => {
    const systemPrompt = `Start

<tool name="Bash">
<description>Runs bash</description>
<parameters>{"type":"object"}</parameters>
</tool>



<tool name="Read">
<description>Reads file</description>
<parameters>{"type":"object"}</parameters>
</tool>


End`;

    const result = extractToolsFromSystemPrompt(systemPrompt);

    // Should not have 3+ consecutive newlines
    expect(result.cleanedSystem).not.toMatch(/\n{3,}/);
    expect(result.cleanedSystem).toContain('Start');
    expect(result.cleanedSystem).toContain('End');
  });
});

describe('transformRequestBody', () => {
  it('should extract tools from string system field', () => {
    const body: AnthropicRequestBody = {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8192,
      system: `<tool name="Bash">
<description>Execute command</description>
<parameters>{"type":"object","properties":{"command":{"type":"string"}}}</parameters>
</tool>`,
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
    };

    const modified = transformRequestBody(body);

    expect(modified).toBe(true);
    expect(body.tools).toHaveLength(1);
    expect(body.tools![0].name).toBe('Bash');
    expect(body.system).not.toContain('<tool');
  });

  it('should extract tools from array system field', () => {
    const body: AnthropicRequestBody = {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8192,
      system: [
        {
          type: 'text',
          text: `<tool name="Write">
<description>Write file</description>
<parameters>{"type":"object"}</parameters>
</tool>`,
        },
      ],
      messages: [{ role: 'user', content: 'hello' }],
    };

    const modified = transformRequestBody(body);

    expect(modified).toBe(true);
    expect(body.tools).toHaveLength(1);
    expect(body.tools![0].name).toBe('Write');
  });

  it('should merge extracted tools with existing tools (no duplicates)', () => {
    const body: AnthropicRequestBody = {
      model: 'claude-sonnet-4-20250514',
      system: `<tool name="Bash">
<description>Execute command</description>
<parameters>{"type":"object"}</parameters>
</tool>
<tool name="Read">
<description>Read file</description>
<parameters>{"type":"object"}</parameters>
</tool>`,
      messages: [],
      tools: [
        { name: 'Bash', description: 'Existing bash', input_schema: { type: 'object' } },
      ],
    };

    const modified = transformRequestBody(body);

    expect(modified).toBe(true);
    // Bash already exists, so only Read should be added
    expect(body.tools).toHaveLength(2);
    const toolNames = body.tools!.map((t) => t.name);
    expect(toolNames).toContain('Bash');
    expect(toolNames).toContain('Read');
  });

  it('should return false when no system field exists', () => {
    const body: AnthropicRequestBody = {
      model: 'claude-sonnet-4-20250514',
      messages: [{ role: 'user', content: 'hello' }],
    };

    const modified = transformRequestBody(body);

    expect(modified).toBe(false);
  });

  it('should return false when system has no tool definitions', () => {
    const body: AnthropicRequestBody = {
      model: 'claude-sonnet-4-20250514',
      system: 'You are a helpful assistant.',
      messages: [{ role: 'user', content: 'hello' }],
    };

    const modified = transformRequestBody(body);

    expect(modified).toBe(false);
    expect(body.tools).toBeUndefined();
  });

  it('should handle all six system tools', () => {
    const body: AnthropicRequestBody = {
      model: 'claude-sonnet-4-20250514',
      system: `<tool name="Bash">
<description>Execute bash</description>
<parameters>{"type":"object","properties":{"command":{"type":"string"}}}</parameters>
</tool>
<tool name="Read">
<description>Read file</description>
<parameters>{"type":"object","properties":{"file_path":{"type":"string"}}}</parameters>
</tool>
<tool name="Write">
<description>Write file</description>
<parameters>{"type":"object","properties":{"file_path":{"type":"string"}}}</parameters>
</tool>
<tool name="Edit">
<description>Edit file</description>
<parameters>{"type":"object","properties":{"file_path":{"type":"string"}}}</parameters>
</tool>
<tool name="Glob">
<description>Find files</description>
<parameters>{"type":"object","properties":{"pattern":{"type":"string"}}}</parameters>
</tool>
<tool name="Grep">
<description>Search content</description>
<parameters>{"type":"object","properties":{"pattern":{"type":"string"}}}</parameters>
</tool>`,
      messages: [],
      tools: [],
    };

    const modified = transformRequestBody(body);

    expect(modified).toBe(true);
    expect(body.tools).toHaveLength(6);
    const toolNames = body.tools!.map((t) => t.name);
    expect(toolNames).toEqual(
      expect.arrayContaining(['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep']),
    );
  });
});
