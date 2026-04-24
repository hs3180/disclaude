/**
 * Tests for macctl.py — macOS screen control CLI.
 *
 * These tests verify the CLI interface and argument parsing.
 * CGEvent functionality is only testable on macOS with accessibility
 * permissions, so we test dispatch logic where possible.
 *
 * On non-macOS or systems without Python 3, only static file tests run.
 *
 * Run with: npx vitest run tests/skills/macctl.test.ts
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

const SCRIPT_PATH = path.resolve(
  __dirname,
  '../../skills/mac-control/scripts/macctl.py'
);

const isMacOS = process.platform === 'darwin';

// Check if python3 is available (the test environment may not have it)
let hasPython = false;
try {
  execSync('which python3', { encoding: 'utf-8', stdio: 'pipe' });
  hasPython = true;
} catch {
  hasPython = false;
}

const canRunScript = isMacOS && hasPython;

function runMacctl(args: string): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execSync(`python3 "${SCRIPT_PATH}" ${args}`, {
      encoding: 'utf-8',
      timeout: 10000,
    });
    return { stdout: stdout.trim(), stderr: '', exitCode: 0 };
  } catch (e: any) {
    return {
      stdout: (e.stdout || '').toString().trim(),
      stderr: (e.stderr || '').toString().trim(),
      exitCode: e.status ?? 1,
    };
  }
}

describe('macctl', () => {
  describe('CLI interface (requires macOS + Python)', () => {
    it('should show help when called with --help', () => {
      if (!canRunScript) return;
      const result = runMacctl('--help');
      expect(result.stdout).toContain('macctl');
      expect(result.stdout).toContain('screenshot');
      expect(result.stdout).toContain('click');
      expect(result.stdout).toContain('type');
    });

    it('should show help when called with help', () => {
      if (!canRunScript) return;
      const result = runMacctl('help');
      expect(result.stdout).toContain('macctl');
      expect(result.stdout).toContain('screenshot');
    });

    it('should return error for unknown command', () => {
      if (!canRunScript) return;
      const result = runMacctl('nonexistent');
      expect(result.exitCode).toBe(1);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain('Unknown command');
    });
  });

  describe('argument validation (requires macOS + Python)', () => {
    it('click requires x and y', () => {
      if (!canRunScript) return;
      const result = runMacctl('click');
      expect(result.exitCode).toBe(1);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain('Usage');
    });

    it('double-click requires x and y', () => {
      if (!canRunScript) return;
      const result = runMacctl('double-click');
      expect(result.exitCode).toBe(1);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(false);
    });

    it('right-click requires x and y', () => {
      if (!canRunScript) return;
      const result = runMacctl('right-click');
      expect(result.exitCode).toBe(1);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(false);
    });

    it('drag requires x1 y1 x2 y2', () => {
      if (!canRunScript) return;
      const result = runMacctl('drag 10 20');
      expect(result.exitCode).toBe(1);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(false);
    });

    it('type requires text argument', () => {
      if (!canRunScript) return;
      const result = runMacctl('type');
      expect(result.exitCode).toBe(1);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(false);
    });

    it('key requires key argument', () => {
      if (!canRunScript) return;
      const result = runMacctl('key');
      expect(result.exitCode).toBe(1);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(false);
    });

    it('key returns error for unknown key', () => {
      if (!canRunScript) return;
      const result = runMacctl('key unknownkeyxyz');
      expect(result.exitCode).toBe(1);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain('Unknown key');
    });

    it('window requires app name', () => {
      if (!canRunScript) return;
      const result = runMacctl('window');
      expect(result.exitCode).toBe(1);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(false);
    });

    it('activate requires app name', () => {
      if (!canRunScript) return;
      const result = runMacctl('activate');
      expect(result.exitCode).toBe(1);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(false);
    });
  });

  describe('non-macOS handling (requires Python, non-macOS)', () => {
    it('should fail gracefully on non-macOS platforms', () => {
      if (isMacOS || !hasPython) return;
      const result = runMacctl('click 100 200');
      expect(result.exitCode).toBe(1);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain('macOS');
    });
  });

  describe('output format (requires macOS + Python)', () => {
    it('all commands return valid JSON', () => {
      if (!canRunScript) return;
      const result = runMacctl('nonexistent');
      expect(() => JSON.parse(result.stdout)).not.toThrow();
    });

    it('error responses have ok:false and error field', () => {
      if (!canRunScript) return;
      const result = runMacctl('nonexistent');
      const parsed = JSON.parse(result.stdout);
      expect(parsed).toHaveProperty('ok', false);
      expect(parsed).toHaveProperty('error');
    });
  });

  describe('key mapping (requires macOS + Python)', () => {
    it('resolves common key names without Unknown key error', () => {
      if (!canRunScript) return;
      const knownKeys = ['return', 'tab', 'space', 'escape', 'a', '0', 'f1'];
      for (const key of knownKeys) {
        const result = runMacctl(`key ${key}`);
        const parsed = JSON.parse(result.stdout);
        // Should not have "Unknown key" error (may fail on CGEvent calls instead)
        if (!parsed.ok && parsed.error) {
          expect(parsed.error).not.toContain('Unknown key');
        }
      }
    });
  });

  describe('skill files (always runs)', () => {
    it('SKILL.md exists and has valid frontmatter', () => {
      const skillPath = path.resolve(__dirname, '../../skills/mac-control/SKILL.md');
      expect(fs.existsSync(skillPath)).toBe(true);
      const content = fs.readFileSync(skillPath, 'utf-8');
      expect(content).toContain('name: mac-control');
      expect(content).toContain('description:');
      expect(content).toContain('allowed-tools:');
    });

    it('macctl.py exists and is executable', () => {
      expect(fs.existsSync(SCRIPT_PATH)).toBe(true);
      const stat = fs.statSync(SCRIPT_PATH);
      // Check executable bit (owner)
      expect(stat.mode & 0o100).toBeTruthy();
    });

    it('macctl.py has proper shebang', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8');
      expect(content.startsWith('#!/usr/bin/env python3')).toBe(true);
    });

    it('macctl.py has all required command handlers', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8');
      const commands = [
        'screenshot', 'click', 'double-click', 'right-click',
        'move', 'drag', 'type', 'key', 'window', 'activate',
        'calibrate', 'scale', 'mouse-pos',
      ];
      for (const cmd of commands) {
        expect(content).toContain(`"${cmd}"`);
      }
    });

    it('macctl.py handles coordinate conversion for Retina', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8');
      // Should mention scale factor / Retina handling
      expect(content.toLowerCase()).toContain('scale');
      expect(content.toLowerCase()).toContain('calibrat');
    });

    it('macctl.py uses clipboard paste for text input', () => {
      const content = fs.readFileSync(SCRIPT_PATH, 'utf-8');
      expect(content).toContain('pbcopy');
      expect(content).toContain('pbpaste');
    });

    it('SKILL.md documents all macctl commands', () => {
      const skillPath = path.resolve(__dirname, '../../skills/mac-control/SKILL.md');
      const content = fs.readFileSync(skillPath, 'utf-8');
      const commands = [
        'screenshot', 'click', 'double-click', 'right-click',
        'move', 'drag', 'type', 'key', 'window', 'activate',
        'calibrate', 'scale', 'mouse-pos',
      ];
      for (const cmd of commands) {
        expect(content).toContain(cmd);
      }
    });
  });
});
