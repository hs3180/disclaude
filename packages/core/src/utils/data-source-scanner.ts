/**
 * Data source scanner — discovers and classifies data files in a directory.
 *
 * Implements Phase 1 of the "Intent Convergence Protocol" (Issue #933):
 * before processing a data task, the agent scans the working directory to
 * enumerate all relevant data files, so nothing is missed.
 *
 * Root cause addressed: Agent started processing without knowing all data
 * sources, missing files like bank card PDFs.
 *
 * @module utils/data-source-scanner
 */

import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Category of a data file, inferred from extension and filename patterns.
 */
export type DataFileCategory =
  | 'bank-statement'
  | 'payment-platform'
  | 'spreadsheet'
  | 'document'
  | 'image'
  | 'audio'
  | 'archive'
  | 'database'
  | 'text'
  | 'unknown';

/**
 * Represents a single discovered data file.
 */
export interface DiscoveredFile {
  /** Absolute path to the file */
  filePath: string;
  /** File extension (lowercase, with dot, e.g. '.pdf') */
  extension: string;
  /** File size in bytes */
  size: number;
  /** Classified category */
  category: DataFileCategory;
  /** Human-readable label inferred from filename (e.g. "招商银行储蓄卡") */
  label: string;
}

/**
 * Result of scanning a directory for data sources.
 */
export interface DataScanResult {
  /** Directory that was scanned */
  directory: string;
  /** Total number of files found */
  totalFiles: number;
  /** Categorized files */
  files: DiscoveredFile[];
  /** Summary grouped by category */
  summary: Record<DataFileCategory, number>;
}

/** Extensions classified as bank statements */
const BANK_STATEMENT_EXTENSIONS = new Set(['.pdf']);

/** Filename patterns for bank statement detection */
const BANK_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /招商银行|cmb|cmsb/i, label: '招商银行' },
  { pattern: /工商银行|icbc/i, label: '工商银行' },
  { pattern: /建设银行|ccb/i, label: '建设银行' },
  { pattern: /农业银行|abc/i, label: '农业银行' },
  { pattern: /中国银行|boc/i, label: '中国银行' },
  { pattern: /交通银行|bocom/i, label: '交通银行' },
  { pattern: /储蓄卡|借记卡|流水|账单/i, label: '银行账单' },
  { pattern: /银行/i, label: '银行文件' },
];

/** Filename patterns for payment platform detection */
const PAYMENT_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /微信|wechat|weixin/i, label: '微信支付' },
  { pattern: /支付宝|alipay/i, label: '支付宝' },
  { pattern: /paypal/i, label: 'PayPal' },
];

/** File extension to category mapping */
const EXTENSION_CATEGORY_MAP: Record<string, DataFileCategory> = {
  // Spreadsheets
  '.csv': 'spreadsheet',
  '.xlsx': 'spreadsheet',
  '.xls': 'spreadsheet',
  '.ods': 'spreadsheet',
  '.tsv': 'spreadsheet',
  // Documents
  '.pdf': 'document',
  '.doc': 'document',
  '.docx': 'document',
  '.pptx': 'document',
  '.txt': 'text',
  '.md': 'text',
  '.json': 'text',
  '.xml': 'text',
  '.html': 'text',
  // Images
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.gif': 'image',
  '.webp': 'image',
  '.bmp': 'image',
  '.svg': 'image',
  // Audio
  '.mp3': 'audio',
  '.wav': 'audio',
  '.ogg': 'audio',
  '.flac': 'audio',
  '.m4a': 'audio',
  '.amr': 'audio',
  // Archives
  '.zip': 'archive',
  '.rar': 'archive',
  '.7z': 'archive',
  '.tar': 'archive',
  '.gz': 'archive',
  // Database
  '.sqlite': 'database',
  '.db': 'database',
  '.sql': 'database',
};

/**
 * Classify a file based on its extension and filename.
 *
 * Uses a two-step approach:
 * 1. Check filename against known patterns (bank, payment, etc.)
 * 2. Fall back to extension-based classification
 */
function classifyFile(fileName: string, extension: string): { category: DataFileCategory; label: string } {
  // Step 1: Check bank patterns (for PDFs and other document types)
  if (BANK_STATEMENT_EXTENSIONS.has(extension)) {
    for (const { pattern, label } of BANK_PATTERNS) {
      if (pattern.test(fileName)) {
        return { category: 'bank-statement', label };
      }
    }
  }

  // Step 2: Check payment platform patterns
  for (const { pattern, label } of PAYMENT_PATTERNS) {
    if (pattern.test(fileName)) {
      return { category: 'payment-platform', label };
    }
  }

  // Step 3: Extension-based classification
  const category = EXTENSION_CATEGORY_MAP[extension] || 'unknown';
  return { category, label: path.basename(fileName, extension) };
}

/**
 * Scan a directory recursively for data files.
 *
 * Discovers all files, classifies them by type, and produces a structured
 * summary. This is the first step of the Intent Convergence Protocol:
 * the agent should present this summary to the user before starting any
 * data processing task.
 *
 * @param directory - Root directory to scan
 * @param options - Scan options
 * @returns Structured scan result with categorized files
 *
 * @example
 * ```typescript
 * const result = await scanDataSources('/path/to/workspace');
 * // result.summary = { 'bank-statement': 2, 'spreadsheet': 3, ... }
 * // Present to user: "I found 5 data files across 2 categories"
 * ```
 */
export async function scanDataSources(
  directory: string,
  options: {
    /** Maximum recursion depth (default: 3) */
    maxDepth?: number;
    /** File extensions to include (default: all known data extensions) */
    includeExtensions?: string[];
    /** Directory names to skip (default: node_modules, .git, dist, __pycache__) */
    excludeDirs?: string[];
  } = {},
): Promise<DataScanResult> {
  const {
    maxDepth = 3,
    includeExtensions,
    excludeDirs = ['node_modules', '.git', 'dist', '__pycache__', '.cache', '.claude'],
  } = options;

  const files: DiscoveredFile[] = [];
  const excludeDirSet = new Set(excludeDirs);
  const includeSet = includeExtensions ? new Set(includeExtensions.map(e => e.toLowerCase())) : null;

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) {return;}

    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      // Permission denied or not a directory — skip
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!excludeDirSet.has(entry.name) && !entry.name.startsWith('.')) {
          await walk(fullPath, depth + 1);
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();

        // Filter by extension if specified
        if (includeSet && !includeSet.has(ext)) {continue;}

        // Skip unknown extensions if no filter specified
        if (!includeSet && ext && !EXTENSION_CATEGORY_MAP[ext]) {continue;}

        let stat;
        try {
          stat = await fs.stat(fullPath);
        } catch {
          continue;
        }

        const { category, label } = classifyFile(entry.name, ext);
        files.push({
          filePath: fullPath,
          extension: ext,
          size: stat.size,
          category,
          label,
        });
      }
    }
  }

  await walk(directory, 0);

  // Build summary
  const summary: Record<DataFileCategory, number> = {
    'bank-statement': 0,
    'payment-platform': 0,
    'spreadsheet': 0,
    'document': 0,
    'image': 0,
    'audio': 0,
    'archive': 0,
    'database': 0,
    'text': 0,
    'unknown': 0,
  };
  for (const file of files) {
    summary[file.category]++;
  }

  return {
    directory,
    totalFiles: files.length,
    files,
    summary,
  };
}

/**
 * Format a scan result as a human-readable summary for user confirmation.
 *
 * This is the prompt that should be shown to the user as part of the
 * Intent Convergence Protocol (Phase 1):
 *
 * > "I found N data files, involving M categories:
 * > - Category A: file1, file2
 * > - Category B: file3
 * > Please confirm: 1) Are all files included? 2) Any missing?"
 *
 * @param result - Scan result to format
 * @returns Human-readable markdown summary
 */
export function formatScanSummary(result: DataScanResult): string {
  const activeCategories = (Object.entries(result.summary) as [DataFileCategory, number][])
    .filter(([, count]) => count > 0);

  if (activeCategories.length === 0) {
    return `No data files found in ${result.directory}.`;
  }

  const lines: string[] = [
    `Found **${result.totalFiles}** data file(s) in ${result.directory}:`,
    '',
  ];

  for (const [category, count] of activeCategories) {
    const categoryFiles = result.files.filter(f => f.category === category);
    lines.push(`**${formatCategory(category)}** (${count} file(s)):`);
    for (const file of categoryFiles) {
      const relPath = path.relative(result.directory, file.filePath);
      const sizeStr = formatFileSize(file.size);
      lines.push(`  - ${file.label} (${relPath}, ${sizeStr})`);
    }
    lines.push('');
  }

  lines.push('Please confirm:');
  lines.push('1. Are all data files included above?');
  lines.push('2. Are there any other files or data sources I should know about?');

  return lines.join('\n');
}

function formatCategory(category: DataFileCategory): string {
  const labels: Record<DataFileCategory, string> = {
    'bank-statement': 'Bank Statements',
    'payment-platform': 'Payment Platform Bills',
    'spreadsheet': 'Spreadsheets',
    'document': 'Documents',
    'image': 'Images',
    'audio': 'Audio',
    'archive': 'Archives',
    'database': 'Database Files',
    'text': 'Text Files',
    'unknown': 'Other Files',
  };
  return labels[category];
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) {return `${bytes} B`;}
  if (bytes < 1024 * 1024) {return `${(bytes / 1024).toFixed(1)} KB`;}
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
