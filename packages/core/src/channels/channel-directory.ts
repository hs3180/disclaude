/**
 * Channel Directory Manager.
 *
 * Manages dynamic channel registration through the file system.
 * Each channel is stored in its own independent directory under
 * `.disclaude/channels/<channel-id>/` with an isolated `channel.yaml`.
 *
 * This design eliminates the race conditions present in unified file
 * approaches (rejected PRs #1443, #1485) because:
 * - Each channel operates on its own directory and file
 * - No shared state between channels
 * - Add/remove operations are atomic at the directory level
 *
 * @module channels/channel-directory
 */

import path from 'path';
import fs from 'fs';
import * as yaml from 'js-yaml';
import { createLogger } from '../utils/logger.js';
import {
  SAFE_CHANNEL_ID_PATTERN,
  RESERVED_CHANNEL_IDS,
  type ChannelPluginManifest,
  type DynamicChannelEntry,
  type AddChannelOptions,
  type ChannelListResult,
} from '../types/channel-plugin.js';

const logger = createLogger('ChannelDirectory');

/** Default channels directory name */
const CHANNELS_DIR_NAME = 'channels';

/** Default config directory name */
const DISCLAude_DIR_NAME = '.disclaude';

/**
 * Resolve the channels directory path.
 *
 * @param baseDir - Base directory (defaults to process.cwd())
 * @returns Absolute path to `.disclaude/channels/`
 */
export function resolveChannelsDir(baseDir?: string): string {
  const dir = baseDir || process.cwd();
  return path.resolve(dir, DISCLAude_DIR_NAME, CHANNELS_DIR_NAME);
}

/**
 * Resolve the path to a specific channel's directory.
 *
 * @param channelId - Channel identifier
 * @param baseDir - Base directory (defaults to process.cwd())
 * @returns Absolute path to `.disclaude/channels/<channel-id>/`
 */
export function resolveChannelDir(channelId: string, baseDir?: string): string {
  return path.resolve(resolveChannelsDir(baseDir), channelId);
}

/**
 * Resolve the path to a specific channel's config file.
 *
 * @param channelId - Channel identifier
 * @param baseDir - Base directory (defaults to process.cwd())
 * @returns Absolute path to `.disclaude/channels/<channel-id>/channel.yaml`
 */
export function resolveChannelConfigPath(channelId: string, baseDir?: string): string {
  return path.resolve(resolveChannelDir(channelId, baseDir), 'channel.yaml');
}

/**
 * Validate a channel ID.
 *
 * @param channelId - Channel identifier to validate
 * @throws Error if the ID is invalid
 */
export function validateChannelId(channelId: string): void {
  if (!channelId || typeof channelId !== 'string') {
    throw new Error(`Channel ID must be a non-empty string, got: ${typeof channelId}`);
  }

  // Check reserved IDs first (even if they don't match the pattern)
  if (RESERVED_CHANNEL_IDS.includes(channelId)) {
    throw new Error(`Channel ID "${channelId}" is reserved`);
  }

  if (!SAFE_CHANNEL_ID_PATTERN.test(channelId)) {
    throw new Error(
      `Invalid channel ID: "${channelId}". ` +
      `Must match pattern: ${SAFE_CHANNEL_ID_PATTERN.source} ` +
      `(alphanumeric, underscores, hyphens; must start with alphanumeric)`
    );
  }
}

/**
 * Parse a channel.yaml file into a manifest.
 *
 * @param configPath - Absolute path to channel.yaml
 * @returns Parsed manifest
 * @throws Error if the file cannot be read or parsed
 */
export function parseChannelConfig(configPath: string): ChannelPluginManifest {
  const content = fs.readFileSync(configPath, 'utf-8');
  const data = yaml.load(content) as Record<string, unknown>;

  if (!data || typeof data !== 'object') {
    throw new Error(`Invalid channel config: ${configPath} does not contain a valid YAML object`);
  }

  const id = data.id as string | undefined;
  const name = data.name as string | undefined;
  const module_ = data.module as string | undefined;

  if (!id || typeof id !== 'string') {
    throw new Error(`Invalid channel config: missing or invalid "id" field in ${configPath}`);
  }

  if (!name || typeof name !== 'string') {
    throw new Error(`Invalid channel config: missing or invalid "name" field in ${configPath}`);
  }

  if (!module_ || typeof module_ !== 'string') {
    throw new Error(`Invalid channel config: missing or invalid "module" field in ${configPath}`);
  }

  return {
    id,
    name,
    module: module_,
    enabled: data.enabled !== false, // Default to true
    version: typeof data.version === 'string' ? data.version : undefined,
    description: typeof data.description === 'string' ? data.description : undefined,
    author: typeof data.author === 'string' ? data.author : undefined,
    config: data.config && typeof data.config === 'object' ? data.config as Record<string, unknown> : undefined,
  };
}

/**
 * Serialize a manifest to YAML string for writing to channel.yaml.
 *
 * @param manifest - Channel manifest to serialize
 * @returns YAML string
 */
export function serializeChannelConfig(manifest: ChannelPluginManifest): string {
  const data: Record<string, unknown> = {
    id: manifest.id,
    name: manifest.name,
    module: manifest.module,
    enabled: manifest.enabled,
  };

  if (manifest.version) { data.version = manifest.version; }
  if (manifest.description) { data.description = manifest.description; }
  if (manifest.author) { data.author = manifest.author; }
  if (manifest.config && Object.keys(manifest.config).length > 0) {
    data.config = manifest.config;
  }

  return yaml.dump(data, { lineWidth: -1, noRefs: true });
}

/**
 * Add a new dynamic channel.
 *
 * Creates a new directory and writes channel.yaml.
 * This operation is atomic: the directory is created before the file is written,
 * and any error during file writing will not leave a partial state.
 *
 * @param channelId - Unique channel identifier
 * @param module - Module specifier (npm package or local path)
 * @param options - Additional channel options
 * @param baseDir - Base directory (defaults to process.cwd())
 * @throws Error if validation fails or channel already exists
 */
export function addChannel(
  channelId: string,
  module: string,
  options?: AddChannelOptions,
  baseDir?: string
): void {
  validateChannelId(channelId);

  if (!module || typeof module !== 'string') {
    throw new Error('Module specifier must be a non-empty string');
  }

  const channelDir = resolveChannelDir(channelId, baseDir);
  const configPath = resolveChannelConfigPath(channelId, baseDir);

  // Check if channel already exists
  if (fs.existsSync(channelDir)) {
    throw new Error(`Channel "${channelId}" already exists at ${channelDir}`);
  }

  // Ensure parent channels directory exists
  const channelsDir = resolveChannelsDir(baseDir);
  fs.mkdirSync(channelsDir, { recursive: true });

  // Create channel directory
  fs.mkdirSync(channelDir, { recursive: true });

  // Build manifest
  const manifest: ChannelPluginManifest = {
    id: channelId,
    name: options?.description || channelId,
    module,
    enabled: options?.enabled !== false,
    version: options?.version,
    description: options?.description,
    author: options?.author,
    config: options?.config,
  };

  // Write channel.yaml atomically (write to temp, then rename)
  const yamlContent = serializeChannelConfig(manifest);
  const tempPath = path.join(channelDir, 'channel.yaml.tmp');
  fs.writeFileSync(tempPath, yamlContent, 'utf-8');
  fs.renameSync(tempPath, configPath);

  logger.info({ channelId, module, directory: channelDir }, 'Channel added');
}

/**
 * Remove a dynamic channel.
 *
 * Removes the entire channel directory and its contents.
 *
 * @param channelId - Channel identifier to remove
 * @param baseDir - Base directory (defaults to process.cwd())
 * @throws Error if channel does not exist or ID is invalid
 */
export function removeChannel(channelId: string, baseDir?: string): void {
  validateChannelId(channelId);

  const channelDir = resolveChannelDir(channelId, baseDir);

  if (!fs.existsSync(channelDir)) {
    throw new Error(`Channel "${channelId}" does not exist at ${channelDir}`);
  }

  // Verify it's actually a channel directory (has channel.yaml)
  const configPath = resolveChannelConfigPath(channelId, baseDir);
  if (!fs.existsSync(configPath)) {
    throw new Error(`Directory "${channelDir}" does not contain channel.yaml, not a valid channel`);
  }

  // Remove the entire directory
  fs.rmSync(channelDir, { recursive: true, force: true });

  logger.info({ channelId, directory: channelDir }, 'Channel removed');
}

/**
 * Enable or disable a dynamic channel.
 *
 * Modifies the `enabled` field in the channel's independent channel.yaml.
 * This is safe from race conditions because each channel has its own file.
 *
 * @param channelId - Channel identifier
 * @param enabled - Whether to enable or disable
 * @param baseDir - Base directory (defaults to process.cwd())
 */
export function setChannelEnabled(channelId: string, enabled: boolean, baseDir?: string): void {
  validateChannelId(channelId);

  const configPath = resolveChannelConfigPath(channelId, baseDir);

  if (!fs.existsSync(configPath)) {
    throw new Error(`Channel "${channelId}" does not exist (no channel.yaml at ${configPath})`);
  }

  // Read, modify, write (safe because this is the only writer for this file)
  const manifest = parseChannelConfig(configPath);
  manifest.enabled = enabled;

  const yamlContent = serializeChannelConfig(manifest);
  const channelDir = resolveChannelDir(channelId, baseDir);
  const tempPath = path.join(channelDir, 'channel.yaml.tmp');
  fs.writeFileSync(tempPath, yamlContent, 'utf-8');
  fs.renameSync(tempPath, configPath);

  logger.info({ channelId, enabled }, `Channel ${enabled ? 'enabled' : 'disabled'}`);
}

/**
 * Get a single channel's manifest.
 *
 * @param channelId - Channel identifier
 * @param baseDir - Base directory (defaults to process.cwd())
 * @returns Channel manifest or undefined if not found
 */
export function getChannel(channelId: string, baseDir?: string): DynamicChannelEntry | undefined {
  validateChannelId(channelId);

  const channelDir = resolveChannelDir(channelId, baseDir);
  const configPath = resolveChannelConfigPath(channelId, baseDir);

  if (!fs.existsSync(configPath)) {
    return undefined;
  }

  try {
    const manifest = parseChannelConfig(configPath);
    return {
      manifest,
      directoryPath: channelDir,
      configFilePath: configPath,
      valid: true,
    };
  } catch (error) {
    return {
      manifest: {
        id: channelId,
        name: channelId,
        module: '',
        enabled: false,
      },
      directoryPath: channelDir,
      configFilePath: configPath,
      valid: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * List all dynamic channels.
 *
 * Scans the `.disclaude/channels/` directory for channel subdirectories.
 * Each channel is loaded independently - a failure in one does not affect others.
 *
 * @param baseDir - Base directory (defaults to process.cwd())
 * @returns List result with all discovered channels
 */
export function listChannels(baseDir?: string): ChannelListResult {
  const channelsDir = resolveChannelsDir(baseDir);

  if (!fs.existsSync(channelsDir)) {
    return { channels: [], total: 0, enabled: 0, disabled: 0 };
  }

  const entries: DynamicChannelEntry[] = [];
  let enabled = 0;
  let disabled = 0;

  const items = fs.readdirSync(channelsDir, { withFileTypes: true });

  for (const item of items) {
    // Skip non-directories and hidden entries
    if (!item.isDirectory() || item.name.startsWith('.')) {
      continue;
    }

    const channelDir = path.join(channelsDir, item.name);
    const configPath = path.join(channelDir, 'channel.yaml');

    if (!fs.existsSync(configPath)) {
      continue; // Not a valid channel directory
    }

    try {
      const manifest = parseChannelConfig(configPath);
      entries.push({
        manifest,
        directoryPath: channelDir,
        configFilePath: configPath,
        valid: true,
      });
      if (manifest.enabled) { enabled++; } else { disabled++; }
    } catch (error) {
      entries.push({
        manifest: {
          id: item.name,
          name: item.name,
          module: '',
          enabled: false,
        },
        directoryPath: channelDir,
        configFilePath: configPath,
        valid: false,
        error: error instanceof Error ? error.message : String(error),
      });
      disabled++;
    }
  }

  return {
    channels: entries,
    total: entries.length,
    enabled,
    disabled,
  };
}
