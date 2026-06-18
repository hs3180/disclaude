/**
 * Intent Convergence Protocol — Workspace Scanner
 *
 * Enumerates workspace files, infers data types, and produces
 * a structured summary for user confirmation.
 *
 * Phase 1 component of #4152.
 * @module intent/workspace-scanner
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type {
  FileCategory,
  InferredData,
  WorkspaceFile,
  WorkspaceScanResult,
} from './types.js';

/** Directories to skip during workspace scanning. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.claude', 'dist', 'build',
  '.next', '__pycache__', '.venv', 'coverage', '.turbo',
  '.runtime-env',
]);

/** Extension → FileCategory mapping. */
const EXTENSION_MAP: Record<string, FileCategory> = {
  csv: 'structured-data', tsv: 'structured-data',
  json: 'structured-data', jsonl: 'structured-data',
  yaml: 'structured-data', yml: 'structured-data',
  xml: 'structured-data', toml: 'config',
  ini: 'config', env: 'config', conf: 'config',
  ts: 'code', tsx: 'code', js: 'code', jsx: 'code',
  py: 'code', java: 'code', go: 'code', rs: 'code',
  rb: 'code', php: 'code', swift: 'code', kt: 'code',
  md: 'document', txt: 'document', rst: 'document',
  pdf: 'document', doc: 'document', docx: 'document',
  png: 'media', jpg: 'media', jpeg: 'media', gif: 'media',
  svg: 'media', webp: 'media', mp4: 'media', mp3: 'media',
  zip: 'archive', tar: 'archive', gz: 'archive',
};

/** Max depth for recursive directory scanning. */
const MAX_DEPTH = 3;

/** Max files to scan (prevents scanning enormous workspaces). */
const MAX_FILES = 200;

/**
 * Resolve a file's category from its extension.
 */
export function categorizeExtension(ext: string): FileCategory {
  return EXTENSION_MAP[ext] || 'unknown';
}

/**
 * Classify file extensions as structured-data types that support inference.
 */
const INFERENCE_EXTENSIONS = new Set([
  'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml',
]);

/**
 * Infer data structure from a structured file.
 *
 * Currently supports CSV/TSV (header + row count) and JSON (top-level keys).
 * Returns undefined for files that can't be inferred.
 */
export async function inferData(
  workspaceDir: string,
  file: WorkspaceFile
): Promise<InferredData | undefined> {
  if (!INFERENCE_EXTENSIONS.has(file.extension)) {return undefined;}

  // Skip files too large to read (> 1MB)
  if (file.size > 1_000_000) {return undefined;}

  const fullPath = path.join(workspaceDir, file.relativePath);

  try {
    const content = await fs.readFile(fullPath, 'utf-8');

    if (file.extension === 'csv' || file.extension === 'tsv') {
      return inferCsv(file, content);
    }

    if (file.extension === 'json' || file.extension === 'jsonl') {
      return inferJson(file, content);
    }

    if (file.extension === 'yaml' || file.extension === 'yml') {
      return inferYaml(file, content);
    }
  } catch {
    // File read failed — skip inference
  }

  return undefined;
}

function inferCsv(file: WorkspaceFile, content: string): InferredData {
  const lines = content.split(/\r?\n/).filter(line => line.trim());
  if (lines.length === 0) {
    return { file, dataType: 'table', rowCount: 0, confidence: 0.3 };
  }

  const sep = file.extension === 'tsv' ? '\t' : ',';
  const headers = parseCsvLine(lines[0], sep);

  return {
    file,
    dataType: 'table',
    rowCount: lines.length - 1,
    columns: headers,
    confidence: headers.length > 0 ? 0.8 : 0.4,
  };
}

function inferJson(file: WorkspaceFile, content: string): InferredData {
  try {
    const data = JSON.parse(content);

    if (Array.isArray(data)) {
      const keys = data.length > 0 && typeof data[0] === 'object' && data[0] !== null
        ? Object.keys(data[0])
        : undefined;
      return {
        file,
        dataType: 'array',
        rowCount: data.length,
        keys,
        confidence: 0.85,
      };
    }

    if (typeof data === 'object' && data !== null) {
      return {
        file,
        dataType: 'key-value',
        keys: Object.keys(data),
        confidence: 0.85,
      };
    }

    return { file, dataType: 'scalar', confidence: 0.5 };
  } catch {
    // JSON parse failed (possibly JSONL)
    const lines = content.split(/\r?\n/).filter(line => line.trim());
    return {
      file,
      dataType: 'array',
      rowCount: lines.length,
      confidence: 0.6,
    };
  }
}

function inferYaml(file: WorkspaceFile, content: string): InferredData {
  // Minimal YAML inference without a parser dependency:
  // Look for top-level keys from lines matching "key:" at column 0
  const keys: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):/);
    if (match) {keys.push(match[1]);}
  }

  return {
    file,
    dataType: keys.length > 0 ? 'key-value' : 'unknown',
    keys: keys.length > 0 ? keys : undefined,
    confidence: keys.length > 0 ? 0.6 : 0.3,
  };
}

/**
 * Parse a single CSV/TSV line, respecting basic quoting.
 */
function parseCsvLine(line: string, sep: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
        current += '"';
        i++; // skip escaped quote
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === sep && !inQuotes) {
      fields.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

/**
 * Recursively enumerate files in a directory, respecting skip list and limits.
 */
async function enumerateFiles(
  dir: string,
  baseDir: string,
  depth: number,
  files: WorkspaceFile[]
): Promise<void> {
  if (depth > MAX_DEPTH || files.length >= MAX_FILES) {return;}

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (files.length >= MAX_FILES) {break;}
    if (entry.name.startsWith('.')) {continue;}

    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(baseDir, fullPath);

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) {continue;}
      await enumerateFiles(fullPath, baseDir, depth + 1, files);
    } else if (entry.isFile()) {
      let stat;
      try {
        stat = await fs.stat(fullPath);
      } catch {
        continue;
      }

      const ext = path.extname(entry.name).replace(/^\./, '').toLowerCase();
      files.push({
        relativePath,
        extension: ext,
        category: categorizeExtension(ext),
        size: stat.size,
        modifiedAt: stat.mtime,
      });
    }
  }
}

/**
 * Scan a workspace directory and infer data types for structured files.
 *
 * Returns a WorkspaceScanResult with all files, inferred data, and a
 * human-readable summary suitable for user confirmation.
 */
export async function scanWorkspace(
  workspaceDir: string
): Promise<WorkspaceScanResult> {
  const files: WorkspaceFile[] = [];
  await enumerateFiles(workspaceDir, workspaceDir, 0, files);

  // Infer data for structured files only
  const dataFiles: InferredData[] = [];
  for (const file of files) {
    if (file.category === 'structured-data') {
      const inferred = await inferData(workspaceDir, file);
      if (inferred) {dataFiles.push(inferred);}
    }
  }

  // Build summary
  const summary = buildSummary(files, dataFiles);

  return { files, dataFiles, summary };
}

/**
 * Build a human-readable summary of the workspace scan.
 */
function buildSummary(
  files: WorkspaceFile[],
  dataFiles: InferredData[]
): string {
  const lines: string[] = [];
  lines.push(`Found ${files.length} files in workspace.`);

  // Group by category
  const byCategory = new Map<string, number>();
  for (const f of files) {
    byCategory.set(f.category, (byCategory.get(f.category) || 0) + 1);
  }
  lines.push(`By type: ${  [...byCategory.entries()]
    .map(([cat, count]) => `${cat}(${count})`)
    .join(', ')}`);

  if (dataFiles.length > 0) {
    lines.push(`\nStructured data files (${dataFiles.length}):`);
    for (const d of dataFiles) {
      const parts = [`- ${d.file.relativePath} [${d.dataType}]`];
      if (d.rowCount !== undefined) {parts.push(`${d.rowCount} rows`);}
      if (d.columns) {parts.push(`cols: ${d.columns.join(', ')}`);}
      if (d.keys) {parts.push(`keys: ${d.keys.join(', ')}`);}
      lines.push(parts.join(', '));
    }
  }

  return lines.join('\n');
}
