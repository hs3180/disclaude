/**
 * Tests for TCC-safe spawn utility (packages/core/src/utils/tcc-safe-spawn.ts)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isMacOS,
  isUnderPM2,
  resetPM2DetectionCache,
  tccSafeSpawn,
  tccSafeExec,
} from './tcc-safe-spawn.js';

describe('tcc-safe-spawn', () => {
  beforeEach(() => {
    resetPM2DetectionCache();
  });

  afterEach(() => {
    resetPM2DetectionCache();
  });

  // ─── isMacOS ──────────────────────────────────────────────────────────────

  describe('isMacOS', () => {
    it('should return a boolean', () => {
      const result = isMacOS();
      expect(typeof result).toBe('boolean');
    });

    it('should match process.platform', () => {
      expect(isMacOS()).toBe(process.platform === 'darwin');
    });
  });

  // ─── isUnderPM2 ───────────────────────────────────────────────────────────

  describe('isUnderPM2', () => {
    it('should return a valid PM2DetectionResult', () => {
      const result = isUnderPM2();
      expect(result).toHaveProperty('isUnderPM2');
      expect(typeof result.isUnderPM2).toBe('boolean');
    });

    it('should return isUnderPM2=false on non-macOS platforms', () => {
      // If we're not on macOS, PM2 detection should be skipped
      if (process.platform !== 'darwin') {
        const result = isUnderPM2();
        expect(result.isUnderPM2).toBe(false);
        expect(result.pm2Pid).toBeUndefined();
        expect(result.pm2Depth).toBeUndefined();
      }
    });

    it('should cache detection results', () => {
      const result1 = isUnderPM2();
      const result2 = isUnderPM2();
      // Same reference = cached
      expect(result1).toBe(result2);
    });

    it('should respect forceRefresh parameter', () => {
      const result1 = isUnderPM2();
      const result2 = isUnderPM2(true);
      // forceRefresh creates a new object
      expect(result1).not.toBe(result2);
      // But both should have the same values
      expect(result1.isUnderPM2).toBe(result2.isUnderPM2);
    });
  });

  // ─── tccSafeSpawn ─────────────────────────────────────────────────────────

  describe('tccSafeSpawn', () => {
    it('should use regular spawn by default on non-PM2 environments', () => {
      const child = tccSafeSpawn('echo', ['hello']);
      expect(child).toBeDefined();
      // Regular spawn should be used (no osascript wrapping)
      expect(child.spawnargs).toBeDefined();
      expect(child.spawnargs[0]).not.toBe('osascript');
    });

    it('should use osascript when forceOsascript is true', () => {
      const child = tccSafeSpawn('echo', ['hello'], { forceOsascript: true });
      expect(child).toBeDefined();
      expect(child.spawnargs).toBeDefined();
      expect(child.spawnargs[0]).toBe('osascript');
      // Should contain the AppleScript command
      const appleScriptArg = child.spawnargs.find(
        (arg: string) => arg.includes('tell application'),
      );
      expect(appleScriptArg).toBeDefined();
      // Suppress ENOENT error on non-macOS CI
      child.on('error', () => {});
    });

    it('should include the command in the AppleScript when forceOsascript is true', () => {
      const child = tccSafeSpawn('python3', ['record.py', '--output', '/tmp/audio.wav'], {
        forceOsascript: true,
      });
      const appleScriptArg = child.spawnargs.find(
        (arg: string) => arg.includes('tell application'),
      );
      expect(appleScriptArg).toContain('python3');
      expect(appleScriptArg).toContain('record.py');
      // Suppress ENOENT error on non-macOS CI
      child.on('error', () => {});
    });

    it('should return a ChildProcess with proper properties', () => {
      const child = tccSafeSpawn('echo', ['test']);
      expect(child).toHaveProperty('pid');
      expect(child).toHaveProperty('stdout');
      expect(child).toHaveProperty('stderr');
      expect(child).toHaveProperty('kill');
      expect(typeof child.kill).toBe('function');
    });

    it('should handle empty args array', () => {
      const child = tccSafeSpawn('echo', []);
      expect(child).toBeDefined();
      expect(child.spawnargs[0]).not.toBe('osascript');
    });
  });

  // ─── tccSafeExec ──────────────────────────────────────────────────────────

  describe('tccSafeExec', () => {
    it('should execute command and return stdout', async () => {
      const { stdout } = await tccSafeExec('echo', ['hello']);
      expect(stdout.trim()).toBe('hello');
    });

    it('should execute command with multiple args', async () => {
      const { stdout } = await tccSafeExec('echo', ['hello', 'world']);
      expect(stdout.trim()).toBe('hello world');
    });

    it('should capture stderr separately', async () => {
      // echo to stderr
      const { stdout, stderr } = await tccSafeExec('sh', ['-c', 'echo "err" >&2 && echo "out"']);
      expect(stdout.trim()).toBe('out');
      expect(stderr.trim()).toBe('err');
    });

    it('should reject on command failure', async () => {
      await expect(tccSafeExec('false', [])).rejects.toThrow();
    });

    it('should reject on non-existent command', async () => {
      await expect(
        tccSafeExec('nonexistent-command-xyz-123', []),
      ).rejects.toThrow();
    });

    it('should respect timeout option', async () => {
      await expect(
        tccSafeExec('sleep', ['10'], { timeout: 500 }),
      ).rejects.toThrow();
    }, 10000);
  });

  // ─── resetPM2DetectionCache ───────────────────────────────────────────────

  describe('resetPM2DetectionCache', () => {
    it('should allow re-detection after reset', () => {
      const result1 = isUnderPM2();
      resetPM2DetectionCache();
      const result2 = isUnderPM2();

      // Different references after reset
      expect(result1).not.toBe(result2);
      // But same values
      expect(result1.isUnderPM2).toBe(result2.isUnderPM2);
    });

    it('should not throw when called multiple times', () => {
      expect(() => {
        resetPM2DetectionCache();
        resetPM2DetectionCache();
        resetPM2DetectionCache();
      }).not.toThrow();
    });
  });

  // ─── Edge cases ───────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('should handle commands with special characters in args', () => {
      // Should not throw when args contain special characters
      const child = tccSafeSpawn('echo', ['hello "world"']);
      expect(child).toBeDefined();
    });

    it('should handle commands with cwd option', async () => {
      const { stdout } = await tccSafeExec('pwd', [], { cwd: '/tmp' });
      expect(stdout.trim()).toBe('/tmp');
    });

    it('should handle commands with env option', async () => {
      const { stdout } = await tccSafeExec('sh', ['-c', 'echo $MY_TEST_VAR'], {
        env: { ...process.env, MY_TEST_VAR: 'test_value_12345' },
      });
      expect(stdout.trim()).toBe('test_value_12345');
    });
  });
});
