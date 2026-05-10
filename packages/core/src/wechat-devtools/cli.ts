/**
 * WeChat DevTools CLI wrapper.
 *
 * Provides a programmatic interface to the WeChat DevTools CLI,
 * enabling automation of mini program preview, upload, and debug operations.
 *
 * Supports CLI path auto-discovery on macOS, Windows, and Linux.
 *
 * @module wechat-devtools/cli
 * @see Issue #3442 - WorkBuddy remote control for WeChat mini programs
 * @see https://developers.weixin.qq.com/miniprogram/dev/devtools/cli.html
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import {
  WECHAT_DEVTOOLS_DEFAULT_PATHS,
  WeChatDevToolsNotFoundError,
  type BuildNpmOptions,
  type CacheOptions,
  type CloseOptions,
  type CliResult,
  type OpenOptions,
  type PreviewOptions,
  type PreviewResult,
  type UploadOptions,
  type UploadResult,
  type WeChatDevToolsConfig,
} from './types.js';

const execFileAsync = promisify(execFile);

/** Default timeout for CLI commands (5 minutes) */
const DEFAULT_CLI_TIMEOUT_MS = 5 * 60 * 1000;

/** ExecFile error shape from child_process */
interface ExecFileError extends NodeJS.ErrnoException {
  stdout?: string;
  stderr?: string;
  code?: string | number;
  killed?: boolean;
}

/**
 * Discover the WeChat DevTools CLI path.
 *
 * Resolution order:
 * 1. Explicit `config.cliPath`
 * 2. `WECHAT_DEVTOOLS_PATH` environment variable
 * 3. Platform-specific default paths
 *
 * @throws {WeChatDevToolsNotFoundError} if CLI cannot be found
 */
export function discoverCliPath(config?: WeChatDevToolsConfig): string {
  // 1. Explicit config
  if (config?.cliPath) {
    const resolved = resolve(config.cliPath);
    if (existsSync(resolved)) {
      return resolved;
    }
  }

  // 2. Environment variable
  const envPath = process.env.WECHAT_DEVTOOLS_PATH;
  if (envPath) {
    const resolved = resolve(envPath);
    if (existsSync(resolved)) {
      return resolved;
    }
  }

  // 3. Platform defaults
  const platform = process.platform as keyof typeof WECHAT_DEVTOOLS_DEFAULT_PATHS;
  const paths = WECHAT_DEVTOOLS_DEFAULT_PATHS[platform];
  if (paths) {
    for (const p of paths) {
      const resolved = resolve(p);
      if (existsSync(resolved)) {
        return resolved;
      }
    }
  }

  throw new WeChatDevToolsNotFoundError(
    `WeChat DevTools CLI not found. Searched: ${
      config?.cliPath ? `config (${config.cliPath}), ` : ''
    }env (WECHAT_DEVTOOLS_PATH), platform defaults (${platform}). ` +
    'Please install WeChat DevTools or set WECHAT_DEVTOOLS_PATH.',
  );
}

/**
 * Execute a WeChat DevTools CLI command.
 *
 * @internal
 */
async function executeCli(
  cliPath: string,
  args: string[],
  options?: { cwd?: string; timeout?: number },
): Promise<CliResult> {
  const cwd = options?.cwd ?? process.cwd();
  const timeout = options?.timeout ?? DEFAULT_CLI_TIMEOUT_MS;

  try {
    const { stdout, stderr } = await execFileAsync(cliPath, args, {
      cwd,
      timeout,
      maxBuffer: 10 * 1024 * 1024, // 10MB
    });

    return {
      success: true,
      stdout: stdout?.trim() ?? '',
      stderr: stderr?.trim() ?? '',
      exitCode: 0,
    };
  } catch (err: unknown) {
    const error = err as ExecFileError;

    // Handle timeout
    if (error.killed) {
      return {
        success: false,
        stdout: error.stdout?.trim() ?? '',
        stderr: `Command timed out after ${timeout}ms`,
        exitCode: null,
        error: `Timeout: CLI command did not complete within ${timeout}ms`,
      };
    }

    // Handle CLI errors (non-zero exit codes)
    const exitCode = typeof error.code === 'number' ? error.code : null;
    const stderr = error.stderr?.trim() ?? error.message ?? '';

    return {
      success: false,
      stdout: error.stdout?.trim() ?? '',
      stderr,
      exitCode,
      error: stderr || `CLI command failed with exit code ${exitCode}`,
    };
  }
}

/**
 * Build project path argument.
 * @internal
 */
function projectArg(projectPath?: string, defaultPath?: string): string[] {
  const path = projectPath ?? defaultPath;
  return path ? ['--project', resolve(path)] : [];
}

/**
 * WeChat DevTools CLI client.
 *
 * Wraps the WeChat DevTools CLI commands with a programmatic interface.
 * Supports preview, upload, open, close, build-npm, and cache operations.
 *
 * @example
 * ```ts
 * const cli = new WeChatDevToolsCli({ cliPath: '/path/to/cli' });
 *
 * // Generate preview QR code
 * const preview = await cli.preview({
 *   projectPath: '/path/to/miniprogram',
 *   qrOutput: '/tmp/preview-qr.png',
 * });
 *
 * // Upload to WeChat backend
 * const upload = await cli.upload({
 *   projectPath: '/path/to/miniprogram',
 *   version: '1.0.0',
 *   desc: 'Initial release',
 * });
 * ```
 */
export class WeChatDevToolsCli {
  private readonly cliPath: string;
  private readonly defaultProjectPath?: string;

  constructor(config?: WeChatDevToolsConfig) {
    this.cliPath = discoverCliPath(config);
    this.defaultProjectPath = config?.projectPath;
  }

  /**
   * Get the resolved CLI path.
   */
  getCliPath(): string {
    return this.cliPath;
  }

  /**
   * Execute the `preview` command to generate a preview QR code.
   *
   * The QR code can be scanned with WeChat to preview the mini program.
   */
  async preview(options?: PreviewOptions): Promise<PreviewResult> {
    const args = ['preview', ...projectArg(options?.projectPath, this.defaultProjectPath)];

    if (options?.qrOutput) {
      args.push('--qr-output', resolve(options.qrOutput));
    }

    if (options?.compileCondition) {
      args.push('--compile-condition', options.compileCondition);
    }

    if (options?.extraArgs) {
      args.push(...options.extraArgs);
    }

    const result = await executeCli(this.cliPath, args);
    return {
      ...result,
      qrImagePath: options?.qrOutput ? resolve(options.qrOutput) : undefined,
    };
  }

  /**
   * Execute the `upload` command to upload the mini program to WeChat backend.
   *
   * After upload, the version can be set as "体验版" (experience version)
   * in the WeChat public platform.
   */
  async upload(options?: UploadOptions): Promise<UploadResult> {
    const args = ['upload', ...projectArg(options?.projectPath, this.defaultProjectPath)];

    if (options?.version) {
      args.push('-v', options.version);
    }

    if (options?.desc) {
      args.push('-d', options.desc);
    }

    if (options?.extraArgs) {
      args.push(...options.extraArgs);
    }

    const result = await executeCli(this.cliPath, args);
    return {
      ...result,
      version: options?.version,
    };
  }

  /**
   * Execute the `open` command to open the project in DevTools.
   *
   * Optionally enables debug mode for real-time logging.
   */
  async open(options?: OpenOptions): Promise<CliResult> {
    const args = ['open', ...projectArg(options?.projectPath, this.defaultProjectPath)];

    if (options?.enableDebug) {
      args.push('--enable-debug');
    }

    if (options?.extraArgs) {
      args.push(...options.extraArgs);
    }

    return await executeCli(this.cliPath, args);
  }

  /**
   * Execute the `close` command to close the project in DevTools.
   */
  async close(options?: CloseOptions): Promise<CliResult> {
    const args = ['close', ...projectArg(options?.projectPath, this.defaultProjectPath)];

    if (options?.extraArgs) {
      args.push(...options.extraArgs);
    }

    return await executeCli(this.cliPath, args);
  }

  /**
   * Execute the `build-npm` command to build npm packages for the mini program.
   */
  async buildNpm(options?: BuildNpmOptions): Promise<CliResult> {
    const args = ['build-npm', ...projectArg(options?.projectPath, this.defaultProjectPath)];

    if (options?.extraArgs) {
      args.push(...options.extraArgs);
    }

    return await executeCli(this.cliPath, args);
  }

  /**
   * Execute the `cache` command to manage DevTools cache.
   */
  async cache(options: CacheOptions): Promise<CliResult> {
    const args = ['cache', '--operation', options.operation];

    if (options.extraArgs) {
      args.push(...options.extraArgs);
    }

    return await executeCli(this.cliPath, args);
  }
}

/**
 * Check if WeChat DevTools CLI is available.
 *
 * Returns true if the CLI binary can be found, false otherwise.
 * Does not throw on failure.
 */
export function isWeChatDevToolsAvailable(config?: WeChatDevToolsConfig): boolean {
  try {
    discoverCliPath(config);
    return true;
  } catch {
    return false;
  }
}
