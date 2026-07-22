/**
 * Tests for tool-definitions — structural validation of MCP tool schemas.
 *
 * Ensures every tool definition in toolDefinitions has the required fields
 * and valid structure for MCP tools/list responses.
 */

import { describe, it, expect } from 'vitest';
import { toolDefinitions } from './tool-definitions.js';

describe('toolDefinitions', () => {
  it('should have at least 5 tool definitions', () => {
    expect(toolDefinitions.length).toBeGreaterThanOrEqual(5);
  });

  it('every tool should have a non-empty name', () => {
    for (const tool of toolDefinitions) {
      expect(tool.name).toBeTruthy();
      expect(typeof tool.name).toBe('string');
      expect(tool.name.length).toBeGreaterThan(0);
    }
  });

  it('every tool should have a non-empty description', () => {
    for (const tool of toolDefinitions) {
      expect(tool.description).toBeTruthy();
      expect(typeof tool.description).toBe('string');
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });

  it('every tool should have inputSchema with type=object', () => {
    for (const tool of toolDefinitions) {
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe('object');
    }
  });

  it('every tool should have inputSchema.properties as a Record', () => {
    for (const tool of toolDefinitions) {
      expect(tool.inputSchema.properties).toBeDefined();
      expect(typeof tool.inputSchema.properties).toBe('object');
    }
  });

  it('every required field should exist in properties (required ⊆ properties)', () => {
    // TS types `required` as `string[]` but cannot enforce that each entry is
    // actually a key of `properties` — this is a real runtime schema bug class.
    for (const tool of toolDefinitions) {
      const { required } = tool.inputSchema;
      if (!required) {
        continue; // required is optional
      }
      expect(Array.isArray(required)).toBe(true);
      const propKeys = Object.keys(tool.inputSchema.properties);
      for (const field of required) {
        expect(propKeys, `tool "${tool.name}" requires unknown field "${field}"`).toContain(field);
      }
    }
  });

  it('tool names should be unique', () => {
    const names = toolDefinitions.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('should include send_text tool', () => {
    expect(toolDefinitions.some((t) => t.name === 'send_text')).toBe(true);
  });
});
