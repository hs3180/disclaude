/**
 * Non-Anthropic Endpoint System Tools
 *
 * Provides MCP inline tools that replicate Claude Code's built-in system tools
 * (Bash, Read, Write, Edit, Glob, Grep) for use with non-Anthropic API endpoints.
 *
 * Problem: Claude Agent SDK embeds tool definitions in the system prompt (XML format),
 * but non-Anthropic providers (e.g., GLM/ZhiPu) only recognize the `tools` API parameter.
 * MCP tools are sent via the `tools` API parameter, so they work with these providers.
 *
 * Solution: When using a non-Anthropic endpoint, disable built-in tools (which embed
 * in the system prompt) and register equivalent MCP inline tools instead.
 *
 * Issue: #2948
 */

import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod/v4';
import { createLogger } from '../../../utils/logger.js';

const logger = createLogger('NonAnthropicTools');

/** Known Anthropic API hosts that support system-prompt embedded tool definitions */
const ANTHROPIC_HOSTS = [
  'api.anthropic.com',
  'api-staging.anthropic.com',
];

/**
 * Check if an API base URL points to a non-Anthropic endpoint.
 *
 * @param baseUrl - The API base URL to check
 * @returns true if the URL is not an Anthropic API endpoint
 */
export function isNonAnthropicEndpoint(baseUrl: string): boolean {
  try {
    const {host} = new URL(baseUrl);
    return !ANTHROPIC_HOSTS.includes(host);
  } catch {
    // If URL parsing fails, assume it's non-Anthropic
    return true;
  }
}

/**
 * Create an MCP server with system tools for non-Anthropic endpoints.
 *
 * This creates inline MCP tools that replicate Claude Code's built-in tools.
 * These MCP tools are sent via the `tools` API parameter, which non-Anthropic
 * providers (like GLM) recognize.
 *
 * @param cwd - Working directory for tool execution
 * @returns MCP server config with system tools
 */
export function createNonAnthropicToolServer(cwd: string) {
  logger.info({ cwd }, 'Creating non-Anthropic system tools MCP server');

  return createSdkMcpServer({
    name: 'system-tools-compat',
    version: '1.0.0',
    tools: [
      createBashTool(cwd),
      createReadTool(cwd),
      createWriteTool(cwd),
      createEditTool(cwd),
      createGlobTool(cwd),
      createGrepTool(cwd),
    ],
  });
}

// ============================================================================
// Tool creation helpers
// ============================================================================

/**
 * Create the Bash tool - executes shell commands.
 */
function createBashTool(cwd: string) {
  return tool(
    'Bash',
    'Executes a given bash command in a persistent shell. The working directory persists between commands, but shell state does not. Always quote file paths that contain spaces. Try to maintain your current working directory by using absolute paths. If your command will create new directories or files, first use ls to verify the parent directory exists.',
    {
      command: z.string().describe('The command to execute'),
      description: z.string().describe(
        'Clear, concise description of what this command does. ' +
        'For simple commands, keep it brief (5-10 words).'
      ),
      timeout: z.number().optional().describe('Optional timeout in milliseconds (max 600000)'),
    },
    async (params) => {
      return await executeCommand(params.command, cwd, params.timeout);
    }
  );
}

/**
 * Create the Read tool - reads file contents.
 */
function createReadTool(cwd: string) {
  return tool(
    'Read',
    'Reads a file from the local filesystem. You can access any file directly by using this tool. Assume this tool is able to read all files on the machine. If the User provides a path to a file assume that path is valid.',
    {
      file_path: z.string().describe('The absolute path to the file to read'),
      offset: z.number().optional().describe('The line number to start reading from'),
      limit: z.number().optional().describe('The number of lines to read'),
    },
    async (params) => {
      const { promises: fs } = await import('fs');
      const path = await import('path');
      const filePath = path.resolve(cwd, params.file_path);

      try {
        let content = await fs.readFile(filePath, 'utf-8');

        if (params.offset || params.limit) {
          const lines = content.split('\n');
          const start = (params.offset ?? 1) - 1;
          const end = params.limit ? start + params.limit : lines.length;
          const selected = lines.slice(start, end);
          // Add line numbers like cat -n
          content = selected
            .map((line, i) => `     ${start + i + 1}\t${line}`)
            .join('\n');
        }

        return { content: [{ type: 'text' as const, text: content }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error reading file: ${message}` }], isError: true as const };
      }
    }
  );
}

/**
 * Create the Write tool - writes file contents.
 */
function createWriteTool(cwd: string) {
  return tool(
    'Write',
    'Writes a file to the local filesystem. This tool will overwrite the existing file if there is one at the provided path. If this is an existing file, you MUST use the Read tool first to read the file\'s contents.',
    {
      file_path: z.string().describe('The absolute path to the file to write (must be absolute, not relative)'),
      content: z.string().describe('The content to write to the file'),
    },
    async (params) => {
      const { promises: fs } = await import('fs');
      const path = await import('path');
      const filePath = path.resolve(cwd, params.file_path);

      try {
        // Ensure parent directory exists
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, params.content, 'utf-8');
        return { content: [{ type: 'text' as const, text: `Successfully wrote to ${params.file_path}` }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error writing file: ${message}` }], isError: true as const };
      }
    }
  );
}

/**
 * Create the Edit tool - performs exact string replacements in files.
 */
function createEditTool(cwd: string) {
  return tool(
    'Edit',
    'Performs exact string replacements in files. The edit will FAIL if old_string is not unique in the file. Only use your memory of the file contents from Read to construct the old_string.',
    {
      file_path: z.string().describe('The absolute path to the file to modify'),
      old_string: z.string().describe('The text to replace'),
      new_string: z.string().describe('The text to replace it with (must be different from old_string)'),
      replace_all: z.boolean().optional().describe('Replace all occurrences of old_string (default false)'),
    },
    async (params) => {
      const { promises: fs } = await import('fs');
      const path = await import('path');
      const filePath = path.resolve(cwd, params.file_path);

      try {
        let content = await fs.readFile(filePath, 'utf-8');

        if (params.replace_all) {
          // Count occurrences
          const count = content.split(params.old_string).length - 1;
          if (count === 0) {
            return { content: [{ type: 'text' as const, text: `Error: old_string not found in ${params.file_path}` }], isError: true as const };
          }
          content = content.replaceAll(params.old_string, params.new_string);
        } else {
          // Check uniqueness
          const firstIndex = content.indexOf(params.old_string);
          if (firstIndex === -1) {
            return { content: [{ type: 'text' as const, text: `Error: old_string not found in ${params.file_path}` }], isError: true as const };
          }
          const secondIndex = content.indexOf(params.old_string, firstIndex + 1);
          if (secondIndex !== -1) {
            return {
              content: [{ type: 'text' as const, text: `Error: old_string is not unique in ${params.file_path}. Found at multiple locations.` }],
              isError: true as const,
            };
          }
          content = content.replace(params.old_string, params.new_string);
        }

        await fs.writeFile(filePath, content, 'utf-8');
        return { content: [{ type: 'text' as const, text: `Successfully edited ${params.file_path}` }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error editing file: ${message}` }], isError: true as const };
      }
    }
  );
}

/**
 * Create the Glob tool - finds files by pattern.
 */
function createGlobTool(cwd: string) {
  return tool(
    'Glob',
    'Fast file pattern matching tool that works with any codebase size. Supports glob patterns like "**/*.js" or "src/**/*.ts". Returns matching file paths sorted by modification time.',
    {
      pattern: z.string().describe('The glob pattern to match files against'),
      path: z.string().optional().describe('The directory to search in. Defaults to current working directory.'),
    },
    async (params) => {
      try {
        const { exec } = await import('child_process');
        const { promisify } = await import('util');
        const execAsync = promisify(exec);
        const searchDir = params.path || cwd;
        // Use find for broad compatibility
        const { stdout } = await execAsync(
          `find "${searchDir}" -type f -name "${params.pattern}" 2>/dev/null | head -100`,
          { maxBuffer: 10 * 1024 * 1024 }
        );
        return { content: [{ type: 'text' as const, text: stdout || 'No files found' }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: message || 'No files found' }] };
      }
    }
  );
}

/**
 * Create the Grep tool - searches file contents.
 */
function createGrepTool(cwd: string) {
  return tool(
    'Grep',
    'A powerful search tool built on ripgrep. Supports full regex syntax. Returns matching file paths by default.',
    {
      pattern: z.string().describe('The regular expression pattern to search for in file contents'),
      path: z.string().optional().describe('File or directory to search in'),
      glob: z.string().optional().describe('Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}")'),
      output_mode: z.enum(['content', 'files_with_matches', 'count']).optional()
        .describe('Output mode. Defaults to "files_with_matches".'),
      '-i': z.boolean().optional().describe('Case insensitive search'),
      '-n': z.boolean().optional().describe('Show line numbers (default true)'),
      head_limit: z.number().optional().describe('Limit output to first N entries'),
    },
    async (params) => {
      try {
        const { exec } = await import('child_process');
        const { promisify } = await import('util');
        const execAsync = promisify(exec);
        const searchPath = params.path || cwd;
        const outputMode = params.output_mode || 'files_with_matches';

        const args: string[] = ['rg'];

        if (params['-i']) {args.push('-i');}
        if (outputMode === 'content') {
          args.push('-n');
        } else if (outputMode === 'count') {
          args.push('-c');
        } else {
          args.push('-l');
        }
        if (params.glob) {args.push('--glob', params.glob);}
        if (params.head_limit) {args.push('-m', String(params.head_limit));}

        args.push('--', params.pattern, searchPath);

        const { stdout } = await execAsync(args.join(' '), {
          maxBuffer: 10 * 1024 * 1024,
        });
        return { content: [{ type: 'text' as const, text: stdout || 'No matches found' }] };
      } catch (err) {
        // rg returns exit code 1 when no matches found - not an error
        if (err && typeof err === 'object' && 'code' in err && (err as { code: number }).code === 1) {
          return { content: [{ type: 'text' as const, text: 'No matches found' }] };
        }
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: message }] };
      }
    }
  );
}

// ============================================================================
// Shared utilities
// ============================================================================

/**
 * Execute a shell command and return the result.
 */
async function executeCommand(
  command: string,
  workingDir: string,
  timeout?: number,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    const { stdout, stderr } = await execAsync(command, {
      cwd: workingDir,
      maxBuffer: 10 * 1024 * 1024,
      timeout: timeout || 120_000,
    });

    const output = stdout + (stderr ? `\nSTDERR:\n${stderr}` : '');
    return { content: [{ type: 'text' as const, text: output || '(no output)' }] };
  } catch (err) {
    const execErr = err as { stdout?: string; stderr?: string; message?: string };
    const parts: string[] = [];
    if (execErr.stdout) {parts.push(execErr.stdout);}
    if (execErr.stderr) {parts.push(execErr.stderr);}
    if (!parts.length && execErr.message) {parts.push(execErr.message);}
    return {
      content: [{ type: 'text' as const, text: parts.join('\n') || 'Command failed' }],
      isError: true as const,
    };
  }
}
