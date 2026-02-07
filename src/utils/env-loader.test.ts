/**
 * Tests for environment loader utilities (src/utils/env-loader.ts)
 *
 * Tests the following functionality:
 * - Finding environment initialization scripts (.disclauderc, .env.sh)
 * - Executing bash scripts and capturing environment variables
 * - Merging environment variables without overwriting existing ones
 * - Loading environment from specific paths
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync } from 'fs';
import { loadEnvironmentScripts, loadEnvironmentFromPath } from './env-loader.js';

// Mock fs module
vi.mock('fs', () => ({
  existsSync: vi.fn(),
}));

// Mock child_process spawn
vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

describe('loadEnvironmentScripts', () => {
  const originalProcessCwd = process.cwd.bind(process);

  beforeEach(() => {
    // Reset mocks
    vi.mocked(existsSync).mockReset();
    // Mock process.cwd
    process.cwd = vi.fn(() => '/mock/working/dir');
  });

  afterEach(() => {
    // Restore original process.cwd
    process.cwd = originalProcessCwd;
  });

  it('should return success: false when no scripts found', async () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const result = await loadEnvironmentScripts();

    expect(result.success).toBe(false);
    expect(result.scriptName).toBeNull();
    expect(result.scriptPath).toBeNull();
    expect(result.envCount).toBe(0);
  });

  it('should find .disclauderc script when it exists', async () => {
    vi.mocked(existsSync).mockImplementation((path) => {
      const pathStr = String(path);
      return pathStr.includes('.disclauderc');
    });

    // Mock spawn to simulate successful script execution
    const { spawn } = await import('child_process');
    const mockSpawn = vi.mocked(spawn);

    const mockBash = {
      stdout: {
        on: vi.fn((event, callback) => {
          if (event === 'data') {
            // Mock environment variables output
            callback(Buffer.from('TEST_VAR=test_value\nANOTHER_VAR=another_value\n'));
          }
        }),
      },
      stderr: {
        on: vi.fn(),
      },
      on: vi.fn((event, callback) => {
        if (event === 'close') {
          callback(0); // Exit code 0 = success
        }
      }),
    };

    mockSpawn.mockReturnValue(mockBash as any);

    const result = await loadEnvironmentScripts();

    expect(result.success).toBe(true);
    expect(result.scriptName).toBe('.disclauderc');
    expect(result.scriptPath).toBe('/mock/working/dir/.disclauderc');
  });

  it('should prioritize .disclauderc over .env.sh', async () => {
    vi.mocked(existsSync).mockImplementation((path) => {
      const pathStr = String(path);
      // Both files exist, but .disclauderc should be found first
      return pathStr.includes('.disclauderc') || pathStr.includes('.env.sh');
    });

    const { spawn } = await import('child_process');
    const mockSpawn = vi.mocked(spawn);

    const mockBash = {
      stdout: {
        on: vi.fn((event, callback) => {
          if (event === 'data') {
            callback(Buffer.from('VAR=value\n'));
          }
        }),
      },
      stderr: {
        on: vi.fn(),
      },
      on: vi.fn((event, callback) => {
        if (event === 'close') {
          callback(0);
        }
      }),
    };

    mockSpawn.mockReturnValue(mockBash as any);

    const result = await loadEnvironmentScripts();

    expect(result.scriptName).toBe('.disclauderc'); // Should find .disclauderc first
  });

  it('should not overwrite existing environment variables', async () => {
    // Set an existing environment variable
    process.env.EXISTING_VAR = 'original_value';

    vi.mocked(existsSync).mockImplementation((path) => {
      return String(path).includes('.disclauderc');
    });

    const { spawn } = await import('child_process');
    const mockSpawn = vi.mocked(spawn);

    const mockBash = {
      stdout: {
        on: vi.fn((event, callback) => {
          if (event === 'data') {
            // Script tries to set EXISTING_VAR to a different value
            callback(Buffer.from('EXISTING_VAR=new_value\nNEW_VAR=new_value\n'));
          }
        }),
      },
      stderr: {
        on: vi.fn(),
      },
      on: vi.fn((event, callback) => {
        if (event === 'close') {
          callback(0);
        }
      }),
    };

    mockSpawn.mockReturnValue(mockBash as any);

    await loadEnvironmentScripts();

    // EXISTING_VAR should not be overwritten
    expect(process.env.EXISTING_VAR).toBe('original_value');
    expect(process.env.NEW_VAR).toBe('new_value');

    // Cleanup
    delete process.env.EXISTING_VAR;
    delete process.env.NEW_VAR;
  });

  it('should handle script execution errors gracefully', async () => {
    vi.mocked(existsSync).mockImplementation((path) => {
      return String(path).includes('.disclauderc');
    });

    const { spawn } = await import('child_process');
    const mockSpawn = vi.mocked(spawn);

    const mockBash = {
      stdout: {
        on: vi.fn(),
      },
      stderr: {
        on: vi.fn((event, callback) => {
          if (event === 'data') {
            callback(Buffer.from('Error: script failed\n'));
          }
        }),
      },
      on: vi.fn((event, callback) => {
        if (event === 'close') {
          callback(1); // Non-zero exit code = error
        }
      }),
    };

    mockSpawn.mockReturnValue(mockBash as any);

    const result = await loadEnvironmentScripts();

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.scriptName).toBe('.disclauderc');
  });

  it('should filter out bash internal variables', async () => {
    vi.mocked(existsSync).mockImplementation((path) => {
      return String(path).includes('.disclauderc');
    });

    const { spawn } = await import('child_process');
    const mockSpawn = vi.mocked(spawn);

    const mockBash = {
      stdout: {
        on: vi.fn((event, callback) => {
          if (event === 'data') {
            // Mix of valid variables and bash internals
            callback(Buffer.from(
              'VALID_VAR=value\n' +
              '_BASH_INTERNAL=ignored\n' +
              'PWD=/ignored\n' +
              'SHLVL=ignored\n' +
              'HOSTNAME=ignored\n' +
              'ANOTHER_VALID=value2\n'
            ));
          }
        }),
      },
      stderr: {
        on: vi.fn(),
      },
      on: vi.fn((event, callback) => {
        if (event === 'close') {
          callback(0);
        }
      }),
    };

    mockSpawn.mockReturnValue(mockBash as any);

    const result = await loadEnvironmentScripts();

    expect(result.success).toBe(true);
    expect(process.env.VALID_VAR).toBe('value');
    expect(process.env.ANOTHER_VALID).toBe('value2');
    expect(process.env._BASH_INTERNAL).toBeUndefined();

    // Cleanup
    delete process.env.VALID_VAR;
    delete process.env.ANOTHER_VALID;
  });
});

describe('loadEnvironmentFromPath', () => {
  beforeEach(() => {
    vi.mocked(existsSync).mockReset();
  });

  it('should load environment from specific script path', async () => {
    const { spawn } = await import('child_process');
    const mockSpawn = vi.mocked(spawn);

    const mockBash = {
      stdout: {
        on: vi.fn((event, callback) => {
          if (event === 'data') {
            callback(Buffer.from('CUSTOM_VAR=custom_value\n'));
          }
        }),
      },
      stderr: {
        on: vi.fn(),
      },
      on: vi.fn((event, callback) => {
        if (event === 'close') {
          callback(0);
        }
      }),
    };

    mockSpawn.mockReturnValue(mockBash as any);

    const result = await loadEnvironmentFromPath('/custom/path/to/script.sh');

    expect(result.success).toBe(true);
    expect(result.scriptPath).toBe('/custom/path/to/script.sh');
    expect(result.envCount).toBeGreaterThan(0);
  });

  it('should handle errors from specific path', async () => {
    const { spawn } = await import('child_process');
    const mockSpawn = vi.mocked(spawn);

    const mockBash = {
      stdout: {
        on: vi.fn(),
      },
      stderr: {
        on: vi.fn((event, callback) => {
          if (event === 'data') {
            callback(Buffer.from('Script not found\n'));
          }
        }),
      },
      on: vi.fn((event, callback) => {
        if (event === 'close') {
          callback(1);
        }
      }),
    };

    mockSpawn.mockReturnValue(mockBash as any);

    const result = await loadEnvironmentFromPath('/nonexistent/script.sh');

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('should not overwrite existing variables when loading from path', async () => {
    process.env.MY_VAR = 'original';

    const { spawn } = await import('child_process');
    const mockSpawn = vi.mocked(spawn);

    const mockBash = {
      stdout: {
        on: vi.fn((event, callback) => {
          if (event === 'data') {
            callback(Buffer.from('MY_VAR=new_value\nNEW_VAR=value\n'));
          }
        }),
      },
      stderr: {
        on: vi.fn(),
      },
      on: vi.fn((event, callback) => {
        if (event === 'close') {
          callback(0);
        }
      }),
    };

    mockSpawn.mockReturnValue(mockBash as any);

    await loadEnvironmentFromPath('/script.sh');

    expect(process.env.MY_VAR).toBe('original');
    expect(process.env.NEW_VAR).toBe('value');

    // Cleanup
    delete process.env.MY_VAR;
    delete process.env.NEW_VAR;
  });

  it('should handle spawn errors', async () => {
    const { spawn } = await import('child_process');
    const mockSpawn = vi.mocked(spawn);

    mockSpawn.mockImplementation(() => {
      throw new Error('Failed to spawn bash');
    });

    const result = await loadEnvironmentFromPath('/script.sh');

    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to spawn bash');
  });
});
