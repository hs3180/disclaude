/**
 * Tests for mac-control.py CLI interface
 *
 * Validates argument parsing, JSON output format, and error handling.
 * Platform-specific CGEvent/Quartz tests are skipped on non-macOS.
 */

import { execSync } from 'child_process';
import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, 'mac-control.py');

function run(cmd: string): { stdout: string; stderr: string; rc: number } {
  try {
    const stdout = execSync(`python3 ${SCRIPT} ${cmd}`, {
      encoding: 'utf8',
      timeout: 10000,
    });
    return { stdout: stdout.trim(), stderr: '', rc: 0 };
  } catch (e: any) {
    return {
      stdout: e.stdout?.trim() || '',
      stderr: e.stderr?.trim() || '',
      rc: e.status || 1,
    };
  }
}

function parseJSON(stdout: string): any {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

describe('mac-control.py CLI', () => {
  describe('help and errors', () => {
    it('should show help and exit with code 1 when no arguments given', () => {
      const result = run('');
      expect(result.rc).toBe(1);
    });

    it('should fail on invalid command', () => {
      const result = run('invalid-command');
      expect(result.rc).not.toBe(0);
    });
  });

  describe('check command', () => {
    it('should return valid JSON with ok and issues fields', () => {
      const result = run('check');
      const data = parseJSON(result.stdout);
      expect(data).not.toBeNull();
      expect(data).toHaveProperty('ok');
      expect(data).toHaveProperty('issues');
      expect(Array.isArray(data.issues)).toBe(true);
    });
  });

  describe('calibrate command', () => {
    it('should return valid JSON with ok field', () => {
      const result = run('calibrate');
      const data = parseJSON(result.stdout);
      expect(data).not.toBeNull();
      expect(data).toHaveProperty('ok');
    });
  });

  describe('screenshot command', () => {
    it('should return JSON with path on success or error on failure', () => {
      const result = run('screenshot');
      const data = parseJSON(result.stdout);
      expect(data).not.toBeNull();
      if (data.ok) {
        expect(data).toHaveProperty('path');
        expect(data).toHaveProperty('scale_factor');
      } else {
        expect(data).toHaveProperty('error');
      }
    });

    it('should accept --region argument', () => {
      const result = run('screenshot --region 0,0,100,100 --output /tmp/test-region.png');
      const data = parseJSON(result.stdout);
      expect(data).not.toBeNull();
    });
  });

  describe('click command', () => {
    it('should fail without x and y arguments', () => {
      const result = run('click');
      expect(result.rc).not.toBe(0);
    });

    it('should return JSON with coordinates', () => {
      const result = run('click 100 200');
      const data = parseJSON(result.stdout);
      expect(data).not.toBeNull();
      if (data.ok) {
        expect(data.x).toBe(100);
        expect(data.y).toBe(200);
      }
    });

    it('should accept --double flag', () => {
      const result = run('click 100 200 --double');
      const data = parseJSON(result.stdout);
      expect(data).not.toBeNull();
      if (data.ok) {
        expect(data.double).toBe(true);
      }
    });

    it('should accept --button right flag', () => {
      const result = run('click 100 200 --button right');
      const data = parseJSON(result.stdout);
      expect(data).not.toBeNull();
      if (data.ok) {
        expect(data.button).toBe('right');
      }
    });
  });

  describe('move command', () => {
    it('should return JSON', () => {
      const result = run('move 300 400');
      const data = parseJSON(result.stdout);
      expect(data).not.toBeNull();
    });
  });

  describe('drag command', () => {
    it('should return JSON', () => {
      const result = run('drag 100 100 500 300');
      const data = parseJSON(result.stdout);
      expect(data).not.toBeNull();
    });
  });

  describe('type command', () => {
    it('should fail without text argument', () => {
      const result = run('type');
      expect(result.rc).not.toBe(0);
    });

    it('should handle ASCII text', () => {
      const result = run('type "hello"');
      const data = parseJSON(result.stdout);
      expect(data).not.toBeNull();
      if (data.ok) {
        expect(data.method).toBe('cgevent');
      }
    });

    it('should handle CJK text via clipboard', () => {
      const result = run('type "你好世界"');
      const data = parseJSON(result.stdout);
      expect(data).not.toBeNull();
      if (data.ok) {
        expect(data.method).toBe('clipboard_paste');
      }
    });
  });

  describe('key command', () => {
    it('should fail without key name', () => {
      const result = run('key');
      expect(result.rc).not.toBe(0);
    });

    it('should handle single key press', () => {
      const result = run('key enter');
      const data = parseJSON(result.stdout);
      expect(data).not.toBeNull();
    });

    it('should handle key with modifier', () => {
      const result = run('key c --with cmd');
      const data = parseJSON(result.stdout);
      expect(data).not.toBeNull();
      if (data.ok) {
        expect(data.modifiers).toContain('cmd');
      }
    });

    it('should handle key with multiple modifiers', () => {
      const result = run('key 3 --with cmd --with shift');
      const data = parseJSON(result.stdout);
      expect(data).not.toBeNull();
    });
  });

  describe('window command', () => {
    it('should return error JSON without app_name or --list', () => {
      const result = run('window');
      const data = parseJSON(result.stdout);
      expect(data).not.toBeNull();
      expect(data.ok).toBe(false);
    });

    it('should return JSON with --list', () => {
      const result = run('window --list');
      const data = parseJSON(result.stdout);
      expect(data).not.toBeNull();
      if (data.ok) {
        expect(Array.isArray(data.windows)).toBe(true);
      }
    });
  });

  describe('activate command', () => {
    it('should fail without app name', () => {
      const result = run('activate');
      expect(result.rc).not.toBe(0);
    });
  });

  describe('mousepos command', () => {
    it('should return JSON', () => {
      const result = run('mousepos');
      const data = parseJSON(result.stdout);
      expect(data).not.toBeNull();
    });
  });

  describe('find-element command', () => {
    it('should fail without app name', () => {
      const result = run('find-element');
      expect(result.rc).not.toBe(0);
    });

    it('should return JSON with role filter', () => {
      const result = run('find-element "Finder" --role AXButton');
      const data = parseJSON(result.stdout);
      expect(data).not.toBeNull();
      if (data.ok) {
        expect(Array.isArray(data.elements)).toBe(true);
      }
    });
  });

  describe('ax-tree command', () => {
    it('should fail without app name', () => {
      const result = run('ax-tree');
      expect(result.rc).not.toBe(0);
    });

    it('should return JSON with depth option', () => {
      const result = run('ax-tree "Finder" --depth 2');
      const data = parseJSON(result.stdout);
      expect(data).not.toBeNull();
      if (data.ok) {
        expect(data).toHaveProperty('tree');
        expect(data.depth).toBe(2);
      }
    });
  });
});
