/**
 * Project persistence module — atomic read/write for projects.json.
 *
 * Provides standalone persistence functions that operate on the
 * {@link ProjectsPersistData} schema. Designed to be used by ProjectManager
 * (Sub-Issue B #2224) for durable state across restarts.
 *
 * Write strategy: write temp file → fsync → atomic rename.
 * Read strategy: parse JSON → schema validation → graceful error on corruption.
 *
 * @see docs/proposals/unified-project-context.md
 * @see Issue #2225 (Sub-Issue C — persistence)
 */

import {
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  mkdirSync,
  existsSync,
  fsyncSync,
  openSync,
  closeSync,
} from 'fs';
import { resolve, join } from 'path';
import { createLogger } from '../utils/logger.js';
import type { ProjectResult, ProjectsPersistData, PersistedInstance } from './types.js';

const logger = createLogger('ProjectPersistence');

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Path Helpers
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Returns the path to the `.disclaude/` directory inside the workspace.
 */
export function getDisclaudeDir(workspaceDir: string): string {
  return resolve(workspaceDir, '.disclaude');
}

/**
 * Returns the path to `projects.json` inside the workspace.
 */
export function getProjectsFilePath(workspaceDir: string): string {
  return join(getDisclaudeDir(workspaceDir), 'projects.json');
}

/**
 * Returns the temp file path used during atomic writes.
 */
function getTempFilePath(workspaceDir: string): string {
  return `${getProjectsFilePath(workspaceDir)}.tmp`;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Schema Validation
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Validates that a parsed object conforms to the ProjectsPersistData schema.
 *
 * Checks:
 * - Top-level `instances` (object with valid entries)
 * - Top-level `chatProjectMap` (object with string values)
 * - Each instance has required string fields (`name`, `templateName`, `workingDir`, `createdAt`)
 *
 * @returns The validated data, or an error result
 */
export function validatePersistData(
  raw: unknown,
): ProjectResult<ProjectsPersistData> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: '持久化数据格式错误：期望一个对象' };
  }

  const data = raw as Record<string, unknown>;

  // Validate `instances`
  if (!data.instances || typeof data.instances !== 'object' || Array.isArray(data.instances)) {
    return { ok: false, error: '持久化数据格式错误：instances 字段缺失或类型错误' };
  }

  const instances = data.instances as Record<string, unknown>;
  for (const [key, value] of Object.entries(instances)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, error: `实例 "${key}" 数据格式错误` };
    }
    const inst = value as Record<string, unknown>;
    if (typeof inst.name !== 'string' || !inst.name) {
      return { ok: false, error: `实例 "${key}" 缺少有效的 name 字段` };
    }
    if (typeof inst.templateName !== 'string' || !inst.templateName) {
      return { ok: false, error: `实例 "${key}" 缺少有效的 templateName 字段` };
    }
    if (typeof inst.workingDir !== 'string' || !inst.workingDir) {
      return { ok: false, error: `实例 "${key}" 缺少有效的 workingDir 字段` };
    }
    if (typeof inst.createdAt !== 'string' || !inst.createdAt) {
      return { ok: false, error: `实例 "${key}" 缺少有效的 createdAt 字段` };
    }
  }

  // Validate `chatProjectMap`
  if (!data.chatProjectMap || typeof data.chatProjectMap !== 'object' || Array.isArray(data.chatProjectMap)) {
    return { ok: false, error: '持久化数据格式错误：chatProjectMap 字段缺失或类型错误' };
  }

  const chatProjectMap = data.chatProjectMap as Record<string, unknown>;
  for (const [chatId, projectName] of Object.entries(chatProjectMap)) {
    if (typeof projectName !== 'string' || !projectName) {
      return { ok: false, error: `chatProjectMap 中 "${chatId}" 的值必须是字符串` };
    }
  }

  return {
    ok: true,
    data: {
      instances: instances as Record<string, PersistedInstance>,
      chatProjectMap: chatProjectMap as Record<string, string>,
    },
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Read Operations
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Load persisted projects data from disk.
 *
 * - If the file does not exist, returns empty state (not an error).
 * - If the file is corrupt or fails validation, returns an error.
 * - On success, returns validated {@link ProjectsPersistData}.
 *
 * @param workspaceDir - The workspace root directory
 * @returns Validated data or error
 */
export function loadPersistedProjects(
  workspaceDir: string,
): ProjectResult<ProjectsPersistData> {
  const filePath = getProjectsFilePath(workspaceDir);

  if (!existsSync(filePath)) {
    logger.debug({ filePath }, 'No projects.json found, returning empty state');
    return { ok: true, data: { instances: {}, chatProjectMap: {} } };
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    const parsed: unknown = JSON.parse(content);
    const result = validatePersistData(parsed);

    if (!result.ok) {
      logger.error({ filePath, error: result.error }, 'Projects file validation failed');
      return result;
    }

    const instanceCount = Object.keys(result.data.instances).length;
    const bindingCount = Object.keys(result.data.chatProjectMap).length;
    logger.debug(
      { filePath, instanceCount, bindingCount },
      'Projects data loaded successfully',
    );

    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ filePath, error: message }, 'Failed to load projects file');
    return { ok: false, error: `无法读取 projects.json: ${message}` };
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Write Operations
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Persist projects data to disk using atomic write (write temp → fsync → rename).
 *
 * **Atomicity**: The file is first written to a `.tmp` path, fsynced,
 * then renamed to the final path. If any step fails, the original file
 * (if any) remains intact. The temp file is cleaned up on failure.
 *
 * **Directory creation**: Creates `.disclaude/` if it doesn't exist.
 *
 * @param data - The data to persist
 * @param workspaceDir - The workspace root directory
 * @returns Success or error
 */
export function persistProjects(
  data: ProjectsPersistData,
  workspaceDir: string,
): ProjectResult<void> {
  const disclaudeDir = getDisclaudeDir(workspaceDir);
  const filePath = getProjectsFilePath(workspaceDir);
  const tempPath = getTempFilePath(workspaceDir);

  // Ensure .disclaude/ directory exists
  try {
    if (!existsSync(disclaudeDir)) {
      mkdirSync(disclaudeDir, { recursive: true });
      logger.debug({ dir: disclaudeDir }, 'Created .disclaude directory');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `无法创建 .disclaude 目录: ${message}` };
  }

  // Write to temp file
  try {
    const json = JSON.stringify(data, null, 2);
    writeFileSync(tempPath, json, 'utf-8');

    // fsync to ensure data is flushed to disk before rename
    const fd = openSync(tempPath, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    // Clean up temp file on write failure
    try {
      if (existsSync(tempPath)) {
        unlinkSync(tempPath);
      }
    } catch {
      // Best-effort cleanup
    }
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `无法写入 projects.json 临时文件: ${message}` };
  }

  // Atomic rename
  try {
    renameSync(tempPath, filePath);
  } catch (error) {
    // Clean up temp file on rename failure
    try {
      if (existsSync(tempPath)) {
        unlinkSync(tempPath);
      }
    } catch {
      // Best-effort cleanup
    }
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `无法完成 projects.json 原子写入: ${message}` };
  }

  const instanceCount = Object.keys(data.instances).length;
  const bindingCount = Object.keys(data.chatProjectMap).length;
  logger.debug(
    { filePath, instanceCount, bindingCount },
    'Projects data persisted successfully',
  );

  return { ok: true, data: undefined };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Delete Operations
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Remove a specific instance from persistence.
 *
 * - Removes the instance from `instances`
 * - Removes all chatId bindings pointing to this instance from `chatProjectMap`
 * - Persists the updated state back to disk
 *
 * @param name - Instance name to delete
 * @param workspaceDir - The workspace root directory
 * @returns Success or error
 */
export function deletePersistedInstance(
  name: string,
  workspaceDir: string,
): ProjectResult<void> {
  // Load current state
  const loadResult = loadPersistedProjects(workspaceDir);
  if (!loadResult.ok) {
    return loadResult;
  }

  const { data } = loadResult;

  // Check if instance exists
  if (!(name in data.instances)) {
    return { ok: false, error: `实例 "${name}" 不存在` };
  }

  // Remove instance
  delete data.instances[name];

  // Remove all chatId bindings pointing to this instance
  const chatIdsToRemove = Object.entries(data.chatProjectMap)
    .filter(([, projectName]) => projectName === name)
    .map(([chatId]) => chatId);

  for (const chatId of chatIdsToRemove) {
    delete data.chatProjectMap[chatId];
  }

  logger.debug(
    { name, removedBindings: chatIdsToRemove.length },
    'Removing instance from persistence',
  );

  // Persist updated state
  return persistProjects(data, workspaceDir);
}
