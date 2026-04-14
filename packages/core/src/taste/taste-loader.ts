/**
 * Taste persistence — load/save taste data from/to YAML file.
 *
 * Handles reading and writing the taste.yaml file with atomic
 * write-then-rename pattern to prevent corruption.
 *
 * Storage location: `{workspace}/.disclaude/taste.yaml`
 *
 * @see https://github.com/hs3180/disclaude/issues/2335
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { createLogger } from '../utils/logger.js';
import type { TasteData, TasteResult } from './types.js';

const logger = createLogger('taste-loader');

/** File name for taste persistence */
const TASTE_FILENAME = 'taste.yaml';

/**
 * Get the path to the taste file.
 *
 * @param workspaceDir - Workspace root directory
 * @returns Absolute path to taste.yaml
 */
export function getTasteFilePath(workspaceDir: string): string {
  return path.join(workspaceDir, '.disclaude', TASTE_FILENAME);
}

/**
 * Load taste data from the YAML file.
 *
 * Returns an empty TasteData structure if the file doesn't exist.
 * Returns an error if the file exists but is malformed.
 *
 * @param workspaceDir - Workspace root directory
 * @returns TasteResult with the loaded data
 */
export function loadTaste(workspaceDir: string): TasteResult<TasteData> {
  const filePath = getTasteFilePath(workspaceDir);

  if (!fs.existsSync(filePath)) {
    logger.debug({ filePath }, 'No taste file found, returning empty data');
    return { ok: true, data: createEmptyTasteData() };
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = yaml.load(raw) as TasteData;

    // Validate basic structure
    if (!parsed || typeof parsed !== 'object') {
      return { ok: false, error: 'taste.yaml is not a valid object' };
    }

    if (parsed.version !== 1) {
      return { ok: false, error: `Unsupported taste version: ${parsed.version}` };
    }

    if (!parsed.rules || typeof parsed.rules !== 'object') {
      return { ok: false, error: 'taste.yaml missing or invalid "rules" field' };
    }

    logger.debug(
      { filePath, ruleCount: Object.keys(parsed.rules).length },
      'Taste file loaded',
    );

    return { ok: true, data: parsed };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ filePath, err: message }, 'Failed to load taste file');
    return { ok: false, error: `Failed to load taste.yaml: ${message}` };
  }
}

/**
 * Save taste data to the YAML file.
 *
 * Uses atomic write-then-rename pattern to prevent corruption.
 * Creates the `.disclaude/` directory if it doesn't exist.
 *
 * @param workspaceDir - Workspace root directory
 * @param data - Taste data to persist
 * @returns TasteResult indicating success or failure
 */
export function saveTaste(workspaceDir: string, data: TasteData): TasteResult<void> {
  const filePath = getTasteFilePath(workspaceDir);
  const dir = path.dirname(filePath);

  try {
    // Ensure directory exists
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Update timestamp
    const dataToSave: TasteData = {
      ...data,
      updatedAt: new Date().toISOString(),
    };

    // Atomic write: write to .tmp then rename
    const tmpPath = `${filePath}.tmp`;
    const content = yaml.dump(dataToSave, {
      lineWidth: 120,
      noRefs: true,
      sortKeys: true,
    });

    fs.writeFileSync(tmpPath, content, 'utf-8');
    fs.renameSync(tmpPath, filePath);

    logger.debug(
      { filePath, ruleCount: Object.keys(dataToSave.rules).length },
      'Taste file saved',
    );

    return { ok: true, data: undefined };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ filePath, err: message }, 'Failed to save taste file');
    return { ok: false, error: `Failed to save taste.yaml: ${message}` };
  }
}

/**
 * Create an empty TasteData structure.
 */
export function createEmptyTasteData(): TasteData {
  return {
    version: 1,
    rules: {},
    updatedAt: new Date().toISOString(),
  };
}
