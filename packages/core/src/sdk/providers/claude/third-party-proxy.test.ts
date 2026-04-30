/**
 * Tests for Third-party API Compatibility Proxy (Issue #2948)
 *
 * Tests tool definition extraction from system prompt XML format
 * and conversion to Anthropic API `tools` parameter format.
 */

import { describe, it, expect } from 'vitest';
import {
  extractToolsFromSystemPrompt,
  isThirdPartyEndpoint,
} from './third-party-proxy.js';

describe('ThirdPartyProxy - extractToolsFromSystemPrompt', () => {
  it('should return empty result for empty system prompt', () => {
    const result = extractToolsFromSystemPrompt('');
    expect(result.found).toBe(false);
    expect(result.tools).toHaveLength(0);
    expect(result.cleanedSystem).toBe('');
  });

  it('should return empty result for system prompt without tools', () => {
    const prompt = 'You are a helpful assistant. Please help the user.';
    const result = extractToolsFromSystemPrompt(prompt);
    expect(result.found).toBe(false);
    expect(result.tools).toHaveLength(0);
    expect(result.cleanedSystem).toBe(prompt);
  });

  it('should extract single tool from <tools> block', () => {
    const prompt = [
      'You are a helpful assistant.',
      '<tools>',
      '<tool name="Bash">',
      '<description>Executes a bash command</description>',
      '<parameters>{"type":"object","properties":{"command":{"type":"string"}},"required":["command"]}</parameters>',
      '</tool>',
      '</tools>',
      'Please help the user.',
    ].join('\n');

    const result = extractToolsFromSystemPrompt(prompt);

    expect(result.found).toBe(true);
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('Bash');
    expect(result.tools[0].description).toBe('Executes a bash command');
    expect(result.tools[0].input_schema.type).toBe('object');
    expect(result.cleanedSystem).toContain('helpful assistant');
    expect(result.cleanedSystem).toContain('Please help');
    expect(result.cleanedSystem).not.toContain('<tools>');
    expect(result.cleanedSystem).not.toContain('<tool');
  });

  it('should extract multiple tools from <tools> block', () => {
    const prompt = [
      'System instructions here.',
      '<tools>',
      '<tool name="Bash">',
      '<description>Run bash commands</description>',
      '<parameters>{"type":"object","properties":{"command":{"type":"string"}},"required":["command"]}</parameters>',
      '</tool>',
      '<tool name="Read">',
      '<description>Read a file</description>',
      '<parameters>{"type":"object","properties":{"file_path":{"type":"string"}},"required":["file_path"]}</parameters>',
      '</tool>',
      '<tool name="Write">',
      '<description>Write to a file</description>',
      '<parameters>{"type":"object","properties":{"file_path":{"type":"string"},"content":{"type":"string"}},"required":["file_path","content"]}</parameters>',
      '</tool>',
      '</tools>',
      'End of instructions.',
    ].join('\n');

    const result = extractToolsFromSystemPrompt(prompt);

    expect(result.found).toBe(true);
    expect(result.tools).toHaveLength(3);

    const toolNames = result.tools.map(t => t.name);
    expect(toolNames).toContain('Bash');
    expect(toolNames).toContain('Read');
    expect(toolNames).toContain('Write');

    // System prompt should be cleaned
    expect(result.cleanedSystem).not.toContain('<tools>');
    expect(result.cleanedSystem).toContain('System instructions');
    expect(result.cleanedSystem).toContain('End of instructions');
  });

  it('should handle tool with multiline description', () => {
    const prompt = [
      '<tools>',
      '<tool name="Grep">',
      '<description>Search for patterns in files',
      'Supports regex patterns and various output modes.</description>',
      '<parameters>{"type":"object","properties":{"pattern":{"type":"string"}},"required":["pattern"]}</parameters>',
      '</tool>',
      '</tools>',
    ].join('\n');

    const result = extractToolsFromSystemPrompt(prompt);

    expect(result.found).toBe(true);
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('Grep');
    expect(result.tools[0].description).toContain('Search for patterns');
    expect(result.tools[0].description).toContain('regex');
  });

  it('should handle tool without parameters', () => {
    const prompt = [
      '<tools>',
      '<tool name="SimpleTool">',
      '<description>A simple tool</description>',
      '</tool>',
      '</tools>',
    ].join('\n');

    const result = extractToolsFromSystemPrompt(prompt);

    expect(result.found).toBe(true);
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('SimpleTool');
    expect(result.tools[0].input_schema).toEqual({ type: 'object', properties: {} });
  });

  it('should handle tool_description format (fallback)', () => {
    const prompt = [
      'System prompt.',
      '<tool_description name="CustomTool">',
      '<description>A custom tool</description>',
      '<parameters>{"type":"object","properties":{"input":{"type":"string"}}}</parameters>',
      '</tool_description>',
      'More instructions.',
    ].join('\n');

    const result = extractToolsFromSystemPrompt(prompt);

    expect(result.found).toBe(true);
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('CustomTool');
    expect(result.cleanedSystem).not.toContain('<tool_description');
  });

  it('should preserve surrounding text in cleaned prompt', () => {
    const prompt = 'Before tools section.\n<tools><tool name="Test"><description>Test</description></tool></tools>\nAfter tools section.';

    const result = extractToolsFromSystemPrompt(prompt);

    expect(result.cleanedSystem).toContain('Before tools');
    expect(result.cleanedSystem).toContain('After tools');
    expect(result.cleanedSystem).not.toContain('<tools>');
  });

  it('should handle malformed XML gracefully', () => {
    const prompt = '<tools><tool name="Bash"><description>Test</description><parameters>not valid json{</parameters></tool></tools>';

    const result = extractToolsFromSystemPrompt(prompt);

    // Should still extract the tool, just with default schema
    expect(result.found).toBe(true);
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('Bash');
    // Default schema used when JSON parsing fails
    expect(result.tools[0].input_schema).toEqual({ type: 'object', properties: {} });
  });

  it('should handle null/undefined input', () => {
    expect(extractToolsFromSystemPrompt(null as unknown as string).found).toBe(false);
    expect(extractToolsFromSystemPrompt(undefined as unknown as string).found).toBe(false);
  });
});

describe('ThirdPartyProxy - isThirdPartyEndpoint', () => {
  it('should return false for Anthropic official endpoint', () => {
    expect(isThirdPartyEndpoint('https://api.anthropic.com')).toBe(false);
    expect(isThirdPartyEndpoint('https://api.anthropic.com/v1')).toBe(false);
  });

  it('should return false for Anthropic console', () => {
    expect(isThirdPartyEndpoint('https://console.anthropic.com')).toBe(false);
  });

  it('should return true for GLM endpoint', () => {
    expect(isThirdPartyEndpoint('https://open.bigmodel.cn/api/anthropic')).toBe(true);
  });

  it('should return true for other third-party endpoints', () => {
    expect(isThirdPartyEndpoint('https://api.openai.com/v1')).toBe(true);
    expect(isThirdPartyEndpoint('https://litellm.example.com')).toBe(true);
    expect(isThirdPartyEndpoint('http://localhost:8080/api')).toBe(true);
  });

  it('should return false for empty string', () => {
    expect(isThirdPartyEndpoint('')).toBe(false);
  });

  it('should return true for invalid URL', () => {
    expect(isThirdPartyEndpoint('not-a-url')).toBe(true);
  });
});
