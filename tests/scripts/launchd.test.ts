/**
 * Smoke tests for scripts/launchd.mjs
 *
 * Validates plist generation output format and command routing.
 * These tests run in any environment (not macOS-specific) by testing
 * the plist XML structure directly without requiring launchd.
 *
 * @see Issue #2894 - Add test coverage for scripts/launchd.mjs
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';

// ---------------------------------------------------------------------------
// Dynamic import — the module has a main-guard so importing won't execute CLI
// ---------------------------------------------------------------------------

const launchd = await import('../../scripts/launchd.mjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse simple key/value pairs from plist XML.
 * Not a full plist parser — sufficient for smoke tests.
 */
function extractPlistValue(xml: string, key: string): string | null {
  const regex = new RegExp(`<key>${key}</key>\\s*<(\\w+)[^>]*>([^<]*)</\\1>`, 's');
  const match = xml.match(regex);
  return match ? match[2].trim() : null;
}

/**
 * Extract array items following a given key in plist XML.
 */
function extractPlistArray(xml: string, key: string): string[] {
  const regex = new RegExp(`<key>${key}</key>\\s*<array>([\\s\\S]*?)</array>`);
  const match = xml.match(regex);
  if (!match) return [];
  const items: string[] = [];
  const itemRegex = /<string>([^<]*)<\/string>/g;
  let item;
  while ((item = itemRegex.exec(match[1])) !== null) {
    items.push(item[1]);
  }
  return items;
}

/**
 * Extract dict entries following a given key in plist XML.
 */
function extractPlistDict(xml: string, key: string): Record<string, string> {
  const regex = new RegExp(`<key>${key}</key>\\s*<dict>([\\s\\S]*?)</dict>`);
  const match = xml.match(regex);
  if (!match) return {};
  const result: Record<string, string> = {};
  const pairRegex = /<key>([^<]+)<\/key>\s*<string>([^<]*)<\/string>/g;
  let pair;
  while ((pair = pairRegex.exec(match[1])) !== null) {
    result[pair[1]] = pair[2];
  }
  return result;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('scripts/launchd.mjs', () => {
  const fakeNodePath = '/usr/local/bin/node';

  // -----------------------------------------------------------------------
  // Plist content generation
  // -----------------------------------------------------------------------

  describe('generatePlistContent', () => {
    let plistXml: string;

    beforeEach(() => {
      plistXml = launchd.generatePlistContent(fakeNodePath);
    });

    it('should produce valid XML declaration', () => {
      expect(plistXml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    });

    it('should include plist DOCTYPE', () => {
      expect(plistXml).toContain(
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      );
    });

    it('should have correct plist root element', () => {
      expect(plistXml).toContain('<plist version="1.0">');
      expect(plistXml).toContain('</plist>');
    });

    it('should contain top-level dict', () => {
      expect(plistXml).toContain('<dict>');
      expect(plistXml).toContain('</dict>');
    });

    it('should set Label to com.disclaude.primary', () => {
      expect(extractPlistValue(plistXml, 'Label')).toBe('com.disclaude.primary');
    });

    it('should set RunAtLoad to true', () => {
      expect(plistXml).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    });

    it('should set KeepAlive to true', () => {
      expect(plistXml).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    });

    it('should set ProgramArguments with node path, CLI entry, and "start"', () => {
      const args = extractPlistArray(plistXml, 'ProgramArguments');
      expect(args).toHaveLength(3);
      expect(args[0]).toBe(fakeNodePath);
      expect(args[1]).toMatch(/packages\/primary-node\/dist\/cli\.js$/);
      expect(args[2]).toBe('start');
    });

    it('should set WorkingDirectory to project root', () => {
      const cwd = extractPlistValue(plistXml, 'WorkingDirectory');
      expect(cwd).toBeTruthy();
      // Should be an absolute path
      expect(cwd).toMatch(/^\//);
    });

    it('should set StandardOutPath', () => {
      const stdout = extractPlistValue(plistXml, 'StandardOutPath');
      expect(stdout).toBe('/tmp/disclaude-stdout.log');
    });

    it('should set StandardErrorPath', () => {
      const stderr = extractPlistValue(plistXml, 'StandardErrorPath');
      expect(stderr).toBe('/tmp/disclaude-stderr.log');
    });

    it('should set EnvironmentVariables with PATH, HOME, and NODE_ENV=production', () => {
      const env = extractPlistDict(plistXml, 'EnvironmentVariables');
      expect(env.PATH).toBeTruthy();
      expect(env.HOME).toBe(homedir());
      expect(env.NODE_ENV).toBe('production');
    });

    it('should produce well-formed XML (no unescaped special chars)', () => {
      // Ensure no stray < or > in values that would break XML parsing
      const nodePath = extractPlistValue(plistXml, 'WorkingDirectory');
      expect(nodePath).not.toMatch(/[<>&]/);
    });

    it('should use the provided node path in ProgramArguments', () => {
      const args = extractPlistArray(plistXml, 'ProgramArguments');
      expect(args[0]).toBe(fakeNodePath);
    });

    it('should reflect a different node path when given one', () => {
      const customPath = '/opt/homebrew/bin/node';
      const xml = launchd.generatePlistContent(customPath);
      const args = extractPlistArray(xml, 'ProgramArguments');
      expect(args[0]).toBe(customPath);
    });
  });

  // -----------------------------------------------------------------------
  // Exported constants
  // -----------------------------------------------------------------------

  describe('exported constants', () => {
    it('should export LABEL as com.disclaude.primary', () => {
      expect(launchd.LABEL).toBe('com.disclaude.primary');
    });

    it('should export CLI_ENTRY pointing to primary-node dist', () => {
      expect(launchd.CLI_ENTRY).toMatch(/packages\/primary-node\/dist\/cli\.js$/);
    });

    it('should export PROJECT_ROOT as an absolute path', () => {
      expect(launchd.PROJECT_ROOT).toMatch(/^\//);
    });

    it('should export STDOUT_LOG path', () => {
      expect(launchd.STDOUT_LOG).toBe('/tmp/disclaude-stdout.log');
    });

    it('should export STDERR_LOG path', () => {
      expect(launchd.STDERR_LOG).toBe('/tmp/disclaude-stderr.log');
    });
  });

  // -----------------------------------------------------------------------
  // Command routing (via subprocess — full integration smoke test)
  // -----------------------------------------------------------------------

  describe('CLI command routing', () => {
    const scriptPath = resolve(import.meta.dirname, '../../scripts/launchd.mjs');

    it('should print usage and exit 1 when no command is given', () => {
      expect(() => {
        execSync(`node ${scriptPath}`, { encoding: 'utf-8', stdio: 'pipe' });
      }).toThrow();
    });

    it('should print usage and exit 1 for unknown commands', () => {
      try {
        execSync(`node ${scriptPath} foobar`, { encoding: 'utf-8', stdio: 'pipe' });
        expect.unreachable('Should have exited with code 1');
      } catch (e: any) {
        const output = e.stdout || e.stderr || e.message || '';
        expect(output).toContain('Usage:');
      }
    });

    it('should print usage text containing all expected commands', () => {
      try {
        execSync(`node ${scriptPath}`, { encoding: 'utf-8', stdio: 'pipe' });
      } catch (e: any) {
        const output = e.stdout || e.stderr || '';
        for (const cmd of ['generate', 'install', 'uninstall', 'start', 'stop', 'restart', 'logs', 'status']) {
          expect(output).toContain(cmd);
        }
      }
    });
  });
});
