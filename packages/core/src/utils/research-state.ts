/**
 * Research state file management (RESEARCH.md).
 *
 * Provides utilities for creating, reading, updating, and rendering
 * RESEARCH.md files that track research progress across sessions.
 *
 * Issue #1710: 实现 RESEARCH.md 研究状态文件
 *
 * The RESEARCH.md file follows a structured markdown format:
 * - Header: topic title and description
 * - Research goals: checklist of objectives
 * - Findings: collected information with sources
 * - Pending questions: items to investigate
 * - Conclusion: summary when research completes
 * - Resources: related links and references
 */

import * as fs from 'fs/promises';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single research finding.
 */
export interface ResearchFinding {
  /** Unique identifier (auto-generated if omitted) */
  id?: string;
  /** Short title for the finding */
  title: string;
  /** Detailed content */
  content: string;
  /** Source URL or reference */
  source?: string;
  /** ISO timestamp when the finding was recorded */
  recordedAt?: string;
  /** Whether this finding came from resolving a question */
  resolvedFrom?: string;
}

/**
 * A research question to investigate.
 */
export interface ResearchQuestion {
  /** Unique identifier (auto-generated if omitted) */
  id?: string;
  /** The question text */
  question: string;
  /** Whether this question has been resolved */
  resolved?: boolean;
  /** ISO timestamp when resolved */
  resolvedAt?: string;
  /** ID of the finding that resolved this question */
  resolvedById?: string;
}

/**
 * Structured research state (in-memory representation).
 */
export interface ResearchState {
  /** Research topic title */
  topic: string;
  /** Brief description / background */
  description: string;
  /** Research objectives */
  goals: string[];
  /** Collected findings (ordered by recording time) */
  findings: ResearchFinding[];
  /** Questions to investigate */
  questions: ResearchQuestion[];
  /** Final conclusion (null until research completes) */
  conclusion: string | null;
  /** Related resource links */
  resources: Array<{ title: string; url: string }>;
  /** ISO timestamp when the state was created */
  createdAt: string;
  /** ISO timestamp of last update */
  updatedAt: string;
}

/**
 * Options for initializing a research state.
 */
export interface InitResearchStateOptions {
  /** Brief description of the research (defaults to empty) */
  description?: string;
  /** Initial research goals (defaults to empty array) */
  goals?: string[];
  /** Custom file name (defaults to 'RESEARCH.md') */
  fileName?: string;
}

/**
 * Options for updating research state.
 */
export interface UpdateResearchStateOptions {
  /** Add new findings */
  addFindings?: ResearchFinding[];
  /** Add new questions */
  addQuestions?: ResearchQuestion[];
  /** Resolve a question by its ID */
  resolveQuestion?: string;
  /** Finding ID that resolved the question */
  resolvedByFindingId?: string;
  /** Update the conclusion (null to clear) */
  conclusion?: string | null;
  /** Add resources */
  addResources?: Array<{ title: string; url: string }>;
  /** Remove a finding by ID */
  removeFinding?: string;
  /** Remove a question by ID */
  removeQuestion?: string;
}

/**
 * Result of initializing a research state.
 */
export interface InitResult {
  /** Absolute path to the research directory */
  dirPath: string;
  /** Absolute path to the RESEARCH.md file */
  filePath: string;
  /** The initialized state */
  state: ResearchState;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_FILE_NAME = 'RESEARCH.md';
const RESEARCH_STATE_FILE = '.research-state.json';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a short unique ID. */
function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/** Current ISO timestamp. */
function now(): string {
  return new Date().toISOString();
}

/**
 * Ensure a directory exists, creating it (and parents) if necessary.
 */
async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

/**
 * Sanitize a topic name for use as a directory name.
 * Converts to lowercase, replaces spaces/special chars with hyphens.
 */
export function sanitizeTopicName(topic: string): string {
  return topic
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'untitled';
}

// ---------------------------------------------------------------------------
// Markdown Rendering
// ---------------------------------------------------------------------------

/**
 * Render a ResearchState to markdown string.
 */
export function renderResearchMarkdown(state: ResearchState): string {
  const lines: string[] = [];

  // Header
  lines.push(`# ${state.topic}`);
  lines.push('');
  if (state.description) {
    lines.push(`> ${state.description}`);
    lines.push('');
  }

  // Goals
  lines.push('## 研究目标');
  lines.push('');
  if (state.goals.length === 0) {
    lines.push('- _（待补充）_');
  } else {
    for (const goal of state.goals) {
      lines.push(`- [ ] ${goal}`);
    }
  }
  lines.push('');

  // Findings
  lines.push('## 已收集的信息');
  lines.push('');
  if (state.findings.length === 0) {
    lines.push('_暂无发现_');
  } else {
    for (let i = 0; i < state.findings.length; i++) {
      const f = state.findings[i];
      lines.push(`### 发现 ${i + 1}: ${f.title}`);
      lines.push('');
      lines.push(f.content);
      lines.push('');
      if (f.source) {
        lines.push(`- 来源：${f.source}`);
      }
      if (f.recordedAt) {
        lines.push(`- 记录时间：${f.recordedAt}`);
      }
      if (f.resolvedFrom) {
        lines.push(`- 来源问题：${f.resolvedFrom}`);
      }
      lines.push('');
    }
  }

  // Questions
  lines.push('## 待调查的问题');
  lines.push('');
  const pendingQuestions = state.questions.filter(q => !q.resolved);
  const resolvedQuestions = state.questions.filter(q => q.resolved);

  if (pendingQuestions.length === 0 && resolvedQuestions.length === 0) {
    lines.push('_暂无问题_');
  } else {
    if (pendingQuestions.length > 0) {
      for (const q of pendingQuestions) {
        lines.push(`- [ ] ${q.question}`);
      }
    }
    if (resolvedQuestions.length > 0) {
      lines.push('');
      lines.push('#### 已解决');
      for (const q of resolvedQuestions) {
        lines.push(`- [x] ${q.question}`);
        if (q.resolvedById) {
          lines.push(`  - 关联发现：${q.resolvedById}`);
        }
      }
    }
  }
  lines.push('');

  // Conclusion
  lines.push('## 研究结论');
  lines.push('');
  if (state.conclusion) {
    lines.push(state.conclusion);
  } else {
    lines.push('_（研究完成后填写）_');
  }
  lines.push('');

  // Resources
  lines.push('## 相关资源');
  lines.push('');
  if (state.resources.length === 0) {
    lines.push('_暂无资源_');
  } else {
    for (const r of state.resources) {
      lines.push(`- [${r.title}](${r.url})`);
    }
  }
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Markdown Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a RESEARCH.md markdown string back into a ResearchState.
 *
 * This is a best-effort parser. It handles the format produced by
 * `renderResearchMarkdown` and may not handle arbitrary markdown edits gracefully.
 */
export function parseResearchMarkdown(
  markdown: string,
  existingState?: Partial<ResearchState>,
): ResearchState {
  const lines = markdown.split('\n');

  // Extract topic from first H1
  let topic = existingState?.topic || '未命名研究';
  let description = existingState?.description || '';
  const goals: string[] = [];
  const findings: ResearchFinding[] = [];
  const questions: ResearchQuestion[] = [];
  let conclusion: string | null = null;
  const resources: Array<{ title: string; url: string }> = [];

  let currentSection: string | null = null;
  let currentFinding: ResearchFinding | null = null;
  let findingLines: string[] = [];

  const flushFinding = () => {
    if (currentFinding) {
      currentFinding.content = findingLines.join('\n').trim();
      findings.push(currentFinding);
      currentFinding = null;
      findingLines = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Topic from H1
    if (/^# /.test(line)) {
      topic = line.replace(/^# /, '').trim();
      currentSection = null;
      continue;
    }

    // Description from blockquote (right after H1)
    if (trimmed.startsWith('> ') && currentSection === null && goals.length === 0) {
      description = trimmed.slice(2);
      continue;
    }

    // Section headers
    if (/^## /.test(line)) {
      flushFinding();

      const sectionTitle = line.replace(/^## /, '').trim();
      if (sectionTitle.includes('研究目标') || sectionTitle === 'Research Goals') {
        currentSection = 'goals';
      } else if (sectionTitle.includes('已收集的信息') || sectionTitle === 'Findings') {
        currentSection = 'findings';
      } else if (sectionTitle.includes('待调查的问题') || sectionTitle === 'Questions') {
        currentSection = 'questions';
      } else if (sectionTitle.includes('研究结论') || sectionTitle === 'Conclusion') {
        currentSection = 'conclusion';
      } else if (sectionTitle.includes('相关资源') || sectionTitle === 'Resources') {
        currentSection = 'resources';
      } else {
        currentSection = null;
      }
      continue;
    }

    // Finding sub-headers (###)
    if (/^### /.test(line) && currentSection === 'findings') {
      flushFinding();
      let titleText = line.replace(/^### /, '').trim();
      // Strip "发现 N: " prefix added by renderResearchMarkdown
      const findingPrefixMatch = titleText.match(/^发现\s+\d+[：:]\s*/);
      if (findingPrefixMatch) {
        titleText = titleText.slice(findingPrefixMatch[0].length);
      }
      currentFinding = {
        id: uid(),
        title: titleText,
        content: '',
        recordedAt: now(),
      };
      continue;
    }

    // Resolved sub-header inside questions
    if (/^#### /.test(line) && currentSection === 'questions') {
      currentSection = 'resolved-questions';
      continue;
    }

    // Goals
    if (currentSection === 'goals') {
      const goalMatch = trimmed.match(/^- \[.\] (.+)/);
      if (goalMatch) {
        goals.push(goalMatch[1]);
      }
      continue;
    }

    // Findings content
    if (currentSection === 'findings' && currentFinding) {
      if (trimmed.startsWith('- 来源：') || trimmed.startsWith('- 来源:')) {
        currentFinding.source = trimmed.replace(/^- 来源[：:]\s*/, '');
      } else if (trimmed.startsWith('- 记录时间：') || trimmed.startsWith('- 记录时间:')) {
        currentFinding.recordedAt = trimmed.replace(/^- 记录时间[：:]\s*/, '');
      } else if (trimmed.startsWith('- 来源问题：') || trimmed.startsWith('- 来源问题:')) {
        currentFinding.resolvedFrom = trimmed.replace(/^- 来源问题[：:]\s*/, '');
      } else if (trimmed !== '') {
        findingLines.push(line);
      }
      continue;
    }

    // Questions
    if (currentSection === 'questions' || currentSection === 'resolved-questions') {
      const questionMatch = trimmed.match(/^- \[([ xX])\] (.+)/);
      if (questionMatch) {
        const resolved = questionMatch[1] !== ' ';
        questions.push({
          id: uid(),
          question: questionMatch[2],
          resolved,
          resolvedAt: resolved ? now() : undefined,
        });
      }
      // Skip resolved-by lines inside questions
      if (trimmed.startsWith('  - 关联发现：') || trimmed.startsWith('  - 关联发现:')) {
        // This is metadata for the last question - skip
      }
      continue;
    }

    // Conclusion
    if (currentSection === 'conclusion') {
      if (trimmed.startsWith('_（') || trimmed.startsWith('_((')) {
        continue; // Skip placeholder
      }
      if (trimmed !== '') {
        conclusion = (conclusion || '') + (conclusion ? '\n' : '') + line;
      }
      continue;
    }

    // Resources
    if (currentSection === 'resources') {
      const resourceMatch = trimmed.match(/^- \[([^\]]+)\]\(([^)]+)\)/);
      if (resourceMatch) {
        resources.push({ title: resourceMatch[1], url: resourceMatch[2] });
      }
      continue;
    }
  }

  flushFinding();

  return {
    topic,
    description,
    goals,
    findings,
    questions,
    conclusion,
    resources,
    createdAt: existingState?.createdAt || now(),
    updatedAt: now(),
  };
}

// ---------------------------------------------------------------------------
// File System Operations
// ---------------------------------------------------------------------------

/**
 * Initialize a new RESEARCH.md in the specified research directory.
 *
 * Creates the directory if it doesn't exist, writes both the human-readable
 * RESEARCH.md and a machine-readable `.research-state.json` sidecar.
 *
 * @param dirPath - Absolute path to the research directory
 * @param topic - Research topic title
 * @param options - Initialization options
 * @returns The init result with paths and state
 */
export async function initResearchState(
  dirPath: string,
  topic: string,
  options?: InitResearchStateOptions,
): Promise<InitResult> {
  const fileName = options?.fileName || DEFAULT_FILE_NAME;
  const filePath = path.join(dirPath, fileName);
  const stateFilePath = path.join(dirPath, RESEARCH_STATE_FILE);

  await ensureDir(dirPath);

  // Check if RESEARCH.md already exists
  let state: ResearchState;
  try {
    const existing = await fs.readFile(filePath, 'utf-8');
    // Parse existing to preserve edits
    const sidecar = await readSidecar(stateFilePath);
    state = parseResearchMarkdown(existing, sidecar || undefined);
  } catch {
    // File doesn't exist - create new state
    state = {
      topic,
      description: options?.description || '',
      goals: options?.goals || [],
      findings: [],
      questions: [],
      conclusion: null,
      resources: [],
      createdAt: now(),
      updatedAt: now(),
    };
  }

  // Write both files
  const markdown = renderResearchMarkdown(state);
  await fs.writeFile(filePath, markdown, 'utf-8');
  await writeSidecar(stateFilePath, state);

  return { dirPath, filePath, state };
}

/**
 * Initialize a research state within a base directory, creating a
 * topic-named subdirectory.
 *
 * @param baseDir - Base directory for all research topics
 * @param topic - Research topic title (used for directory naming)
 * @param options - Initialization options
 * @returns The init result
 */
export async function initResearchTopic(
  baseDir: string,
  topic: string,
  options?: InitResearchStateOptions,
): Promise<InitResult> {
  const dirName = sanitizeTopicName(topic);
  const dirPath = path.join(baseDir, dirName);
  return initResearchState(dirPath, topic, options);
}

/**
 * Load research state from a directory.
 * Reads the `.research-state.json` sidecar for structured data,
 * falling back to parsing RESEARCH.md if the sidecar is missing.
 *
 * @param dirPath - Path to the research directory
 * @param fileName - Name of the markdown file (defaults to 'RESEARCH.md')
 * @returns The parsed research state, or null if no research file exists
 */
export async function loadResearchState(
  dirPath: string,
  fileName?: string,
): Promise<ResearchState | null> {
  const stateFilePath = path.join(dirPath, RESEARCH_STATE_FILE);
  const mdFilePath = path.join(dirPath, fileName || DEFAULT_FILE_NAME);

  // Try sidecar first
  const sidecar = await readSidecar(stateFilePath);
  if (sidecar) {
    return sidecar;
  }

  // Fall back to parsing markdown
  try {
    const markdown = await fs.readFile(mdFilePath, 'utf-8');
    return parseResearchMarkdown(markdown);
  } catch {
    return null;
  }
}

/**
 * Check whether a research directory exists and contains a RESEARCH.md.
 *
 * @param dirPath - Path to check
 * @param fileName - Name of the markdown file (defaults to 'RESEARCH.md')
 */
export async function researchStateExists(
  dirPath: string,
  fileName?: string,
): Promise<boolean> {
  const filePath = path.join(dirPath, fileName || DEFAULT_FILE_NAME);
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Update a research state in-place.
 *
 * Reads the current state, applies the given updates, and writes
 * both RESEARCH.md and the sidecar back to disk.
 *
 * @param dirPath - Path to the research directory
 * @param updates - Update operations to apply
 * @param fileName - Name of the markdown file (defaults to 'RESEARCH.md')
 * @returns The updated research state
 */
export async function updateResearchState(
  dirPath: string,
  updates: UpdateResearchStateOptions,
  fileName?: string,
): Promise<ResearchState> {
  const state = await loadResearchState(dirPath, fileName);
  if (!state) {
    throw new Error(`No research state found in ${dirPath}`);
  }

  // Apply updates
  if (updates.addFindings) {
    for (const f of updates.addFindings) {
      state.findings.push({
        id: f.id || uid(),
        title: f.title,
        content: f.content,
        source: f.source,
        recordedAt: f.recordedAt || now(),
        resolvedFrom: f.resolvedFrom,
      });
    }
  }

  if (updates.addQuestions) {
    for (const q of updates.addQuestions) {
      state.questions.push({
        id: q.id || uid(),
        question: q.question,
        resolved: q.resolved || false,
      });
    }
  }

  if (updates.resolveQuestion) {
    const question = state.questions.find(q => q.id === updates.resolveQuestion);
    if (question) {
      question.resolved = true;
      question.resolvedAt = now();
      question.resolvedById = updates.resolvedByFindingId;
    }
  }

  if (updates.conclusion !== undefined) {
    state.conclusion = updates.conclusion;
  }

  if (updates.addResources) {
    state.resources.push(...updates.addResources);
  }

  if (updates.removeFinding) {
    state.findings = state.findings.filter(f => f.id !== updates.removeFinding);
  }

  if (updates.removeQuestion) {
    state.questions = state.questions.filter(q => q.id !== updates.removeQuestion);
  }

  state.updatedAt = now();

  // Write back
  const actualFileName = fileName || DEFAULT_FILE_NAME;
  const mdFilePath = path.join(dirPath, actualFileName);
  const stateFilePath = path.join(dirPath, RESEARCH_STATE_FILE);

  const markdown = renderResearchMarkdown(state);
  await fs.writeFile(mdFilePath, markdown, 'utf-8');
  await writeSidecar(stateFilePath, state);

  return state;
}

/**
 * Add a finding to the research state (convenience wrapper).
 */
export async function addFinding(
  dirPath: string,
  finding: Omit<ResearchFinding, 'id' | 'recordedAt'>,
  fileName?: string,
): Promise<ResearchState> {
  return updateResearchState(dirPath, { addFindings: [finding] }, fileName);
}

/**
 * Add a question to the research state (convenience wrapper).
 */
export async function addQuestion(
  dirPath: string,
  question: string,
  fileName?: string,
): Promise<ResearchState> {
  return updateResearchState(
    dirPath,
    { addQuestions: [{ question }] },
    fileName,
  );
}

/**
 * Resolve a question and optionally link it to a finding (convenience wrapper).
 */
export async function resolveQuestion(
  dirPath: string,
  questionId: string,
  findingId?: string,
  fileName?: string,
): Promise<ResearchState> {
  return updateResearchState(
    dirPath,
    { resolveQuestion: questionId, resolvedByFindingId: findingId },
    fileName,
  );
}

/**
 * Set the conclusion for the research (convenience wrapper).
 */
export async function setConclusion(
  dirPath: string,
  conclusion: string,
  fileName?: string,
): Promise<ResearchState> {
  return updateResearchState(dirPath, { conclusion }, fileName);
}

/**
 * Clean up research directory files (RESEARCH.md and sidecar).
 * Does NOT delete the directory itself or any other files.
 *
 * @param dirPath - Path to the research directory
 * @param fileName - Name of the markdown file (defaults to 'RESEARCH.md')
 */
export async function cleanupResearchState(
  dirPath: string,
  fileName?: string,
): Promise<void> {
  const actualFileName = fileName || DEFAULT_FILE_NAME;
  const mdFilePath = path.join(dirPath, actualFileName);
  const stateFilePath = path.join(dirPath, RESEARCH_STATE_FILE);

  for (const filePath of [mdFilePath, stateFilePath]) {
    try {
      await fs.unlink(filePath);
    } catch {
      // Ignore if file doesn't exist
    }
  }
}

// ---------------------------------------------------------------------------
// Sidecar I/O (internal)
// ---------------------------------------------------------------------------

/**
 * Read the `.research-state.json` sidecar file.
 * Returns null if the file doesn't exist or is invalid JSON.
 */
async function readSidecar(filePath: string): Promise<ResearchState | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw) as ResearchState;
  } catch {
    return null;
  }
}

/**
 * Write the `.research-state.json` sidecar file.
 */
async function writeSidecar(filePath: string, state: ResearchState): Promise<void> {
  await fs.writeFile(filePath, JSON.stringify(state, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
// File system abstraction for testing
// ---------------------------------------------------------------------------

/**
 * File system operations used by research-state.
 * Can be replaced in tests to avoid disk I/O.
 */
export const fsOps = {
  readFile: fs.readFile,
  writeFile: fs.writeFile,
  mkdir: fs.mkdir,
  unlink: fs.unlink,
  access: fs.access,
};
