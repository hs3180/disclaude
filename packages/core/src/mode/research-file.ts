/**
 * RESEARCH.md file management module.
 *
 * Issue #1710: Research state file for tracking research progress.
 *
 * Provides pure functions for generating, parsing, and updating
 * the RESEARCH.md file used in research mode sessions. This module
 * handles the content layer only — file I/O is the responsibility
 * of the consumer (agent/skill using Write/Read tools).
 *
 * Architecture:
 * ```
 * ResearchFileData (in-memory model)
 *   ├── metadata { topic, createdAt, updatedAt }
 *   ├── goal (research objective)
 *   ├── objectives[] (checklist items)
 *   ├── findings[] (discoveries with sources)
 *   ├── openQuestions[] (pending investigations)
 *   ├── conclusion (final summary)
 *   └── resources[] (reference links)
 *
 * generateResearchMarkdown() ← serialize to markdown
 * parseResearchMarkdown()   ← deserialize from markdown
 * ```
 *
 * @module mode/research-file
 */

/**
 * A single research finding or discovery.
 */
export interface ResearchFinding {
  /** Finding title/heading */
  title: string;
  /** Key content of the finding */
  content: string;
  /** Source URL or reference (optional) */
  source?: string;
  /** ISO 8601 timestamp when this finding was added */
  addedAt: string;
}

/**
 * A reference resource.
 */
export interface ResearchResource {
  /** Resource name or description */
  name: string;
  /** URL or file path (optional) */
  url?: string;
}

/**
 * Metadata for a research file.
 */
export interface ResearchMetadata {
  /** Research topic name */
  topic: string;
  /** ISO 8601 timestamp when the research was created */
  createdAt: string;
  /** ISO 8601 timestamp of last update */
  updatedAt: string;
}

/**
 * Complete in-memory representation of a RESEARCH.md file.
 */
export interface ResearchFileData {
  /** File metadata */
  metadata: ResearchMetadata;
  /** Research objective / goal description */
  goal: string;
  /** Checklist of research objectives */
  objectives: string[];
  /** Collected findings and discoveries */
  findings: ResearchFinding[];
  /** Pending questions to investigate */
  openQuestions: string[];
  /** Final conclusion (empty until research completes) */
  conclusion: string;
  /** Reference resources and links */
  resources: ResearchResource[];
}

/**
 * Options for creating an initial research file.
 */
export interface CreateResearchOptions {
  /** Research topic name */
  topic: string;
  /** Research goal / objective description */
  goal?: string;
  /** Initial objectives to track */
  objectives?: string[];
}

/**
 * Options for adding a finding.
 */
export interface AddFindingOptions {
  /** Finding title */
  title: string;
  /** Finding content */
  content: string;
  /** Source URL or reference */
  source?: string;
}

/**
 * Result of an archive operation.
 */
export interface ArchiveResult {
  /** The archive markdown content */
  archivedContent: string;
  /** ISO 8601 timestamp when archived */
  archivedAt: string;
}

// ─── Section header constants ───────────────────────────────────────

const SECTION_HEADERS = {
  goal: '## 研究目标',
  objectives: '## 研究目标清单',
  findings: '## 已收集的信息',
  openQuestions: '## 待调查的问题',
  conclusion: '## 研究结论',
  resources: '## 相关资源',
} as const;

// ─── Create ─────────────────────────────────────────────────────────

/**
 * Create an initial RESEARCH.md data structure.
 *
 * Generates a fresh research file with the given topic and optional
 * goal/objectives. The createdAt and updatedAt timestamps are set to now.
 *
 * @param options - Creation options
 * @returns Initial research file data
 */
export function createInitialResearchFile(options: CreateResearchOptions): ResearchFileData {
  const now = new Date().toISOString();
  return {
    metadata: {
      topic: options.topic,
      createdAt: now,
      updatedAt: now,
    },
    goal: options.goal ?? '',
    objectives: options.objectives ?? [],
    findings: [],
    openQuestions: [],
    conclusion: '',
    resources: [],
  };
}

// ─── Serialize ──────────────────────────────────────────────────────

/**
 * Generate the RESEARCH.md markdown content from data.
 *
 * Produces a well-structured markdown document following the format
 * specified in Issue #1710. The output is designed to be both
 * human-readable and parseable by `parseResearchMarkdown()`.
 *
 * @param data - Research file data
 * @returns Complete markdown content for RESEARCH.md
 */
export function generateResearchMarkdown(data: ResearchFileData): string {
  const lines: string[] = [];

  // Title and metadata
  lines.push(`# 研究: ${data.metadata.topic}`);
  lines.push('');
  if (data.goal) {
    lines.push(`> ${data.goal}`);
    lines.push('');
  }
  lines.push(`*创建时间: ${data.metadata.createdAt}*`);
  lines.push(`*最后更新: ${data.metadata.updatedAt}*`);
  lines.push('');

  // Objectives
  lines.push(SECTION_HEADERS.objectives);
  if (data.objectives.length === 0) {
    lines.push('- (尚未定义研究目标)');
  } else {
    for (const obj of data.objectives) {
      lines.push(`- [ ] ${obj}`);
    }
  }
  lines.push('');

  // Findings
  lines.push(SECTION_HEADERS.findings);
  if (data.findings.length === 0) {
    lines.push('(尚无发现)');
  } else {
    for (const finding of data.findings) {
      lines.push(`### ${finding.title}`);
      if (finding.source) {
        lines.push(`- **来源**: ${finding.source}`);
      }
      lines.push(finding.content);
      lines.push(`*添加时间: ${finding.addedAt}*`);
      lines.push('');
    }
  }
  lines.push('');

  // Open questions
  lines.push(SECTION_HEADERS.openQuestions);
  if (data.openQuestions.length === 0) {
    lines.push('(无待调查问题)');
  } else {
    for (const q of data.openQuestions) {
      lines.push(`- [ ] ${q}`);
    }
  }
  lines.push('');

  // Conclusion
  lines.push(SECTION_HEADERS.conclusion);
  lines.push(data.conclusion || '(研究尚未完成)');
  lines.push('');

  // Resources
  lines.push(SECTION_HEADERS.resources);
  if (data.resources.length === 0) {
    lines.push('(无)');
  } else {
    for (const res of data.resources) {
      if (res.url) {
        lines.push(`- [${res.name}](${res.url})`);
      } else {
        lines.push(`- ${res.name}`);
      }
    }
  }
  lines.push('');

  return lines.join('\n');
}

// ─── Parse ──────────────────────────────────────────────────────────

/**
 * Parse RESEARCH.md markdown content into structured data.
 *
 * Extracts all sections from a RESEARCH.md file and returns
 * a `ResearchFileData` object. Handles both English and Chinese
 * section headers for forward compatibility.
 *
 * @param content - Raw markdown content of RESEARCH.md
 * @returns Parsed research file data
 */
export function parseResearchMarkdown(content: string): ResearchFileData {
  const lines = content.split('\n');

  // Extract title (first H1)
  const titleLine = lines.find(l => l.startsWith('# ') && !l.startsWith('## '));
  const topic = titleLine
    ? titleLine.replace(/^#\s+/, '').replace(/^研究:\s*/, '').replace(/^Research:\s*/i, '').trim()
    : 'unknown';

  // Extract metadata timestamps
  const createdAt = extractTimestamp(lines, '创建时间') ?? extractTimestamp(lines, 'Created') ?? '';
  const updatedAt = extractTimestamp(lines, '最后更新') ?? extractTimestamp(lines, 'Updated') ?? '';

  // Extract goal (blockquote after title)
  const goalLine = lines.find(l => l.startsWith('> '));
  const goal = goalLine ? goalLine.replace(/^>\s*/, '').trim() : '';

  // Extract section content blocks
  const findingsSection = extractSection(content, SECTION_HEADERS.findings);
  const objectivesSection = extractSection(content, SECTION_HEADERS.objectives);
  const openQuestionsSection = extractSection(content, SECTION_HEADERS.openQuestions);
  const conclusionSection = extractSection(content, SECTION_HEADERS.conclusion);
  const resourcesSection = extractSection(content, SECTION_HEADERS.resources);

  // Parse objectives (checkbox items)
  const objectives = parseCheckboxItems(objectivesSection);

  // Parse findings (### subsections)
  const findings = parseFindings(findingsSection);

  // Parse open questions (checkbox items)
  const openQuestions = parseCheckboxItems(openQuestionsSection);

  // Parse conclusion
  const conclusion = conclusionSection
    .replace(/^\(.*?\)\s*$/m, '').trim()
    || '';

  // Parse resources
  const resources = parseResources(resourcesSection);

  return {
    metadata: { topic, createdAt, updatedAt },
    goal,
    objectives,
    findings,
    openQuestions,
    conclusion,
    resources,
  };
}

// ─── Update operations ──────────────────────────────────────────────

/**
 * Add a new finding to the research data.
 *
 * Appends the finding to the findings array and updates the
 * updatedAt timestamp.
 *
 * @param data - Current research file data
 * @param options - Finding details
 * @returns Updated research file data (new object)
 */
export function addFinding(
  data: ResearchFileData,
  options: AddFindingOptions
): ResearchFileData {
  return {
    ...data,
    metadata: { ...data.metadata, updatedAt: new Date().toISOString() },
    findings: [
      ...data.findings,
      {
        title: options.title,
        content: options.content,
        source: options.source,
        addedAt: new Date().toISOString(),
      },
    ],
  };
}

/**
 * Add an open question to the research data.
 *
 * Avoids duplicates (case-insensitive comparison).
 *
 * @param data - Current research file data
 * @param question - The question to add
 * @returns Updated research file data (new object)
 */
export function addOpenQuestion(
  data: ResearchFileData,
  question: string
): ResearchFileData {
  const normalized = question.trim();
  if (!normalized) return data;

  // Avoid duplicates
  const exists = data.openQuestions.some(
    q => q.toLowerCase() === normalized.toLowerCase()
  );
  if (exists) return data;

  return {
    ...data,
    metadata: { ...data.metadata, updatedAt: new Date().toISOString() },
    openQuestions: [...data.openQuestions, normalized],
  };
}

/**
 * Resolve an open question by removing it from the list.
 *
 * Uses case-insensitive substring matching to find and remove
 * the question.
 *
 * @param data - Current research file data
 * @param questionText - The question text to resolve (can be partial match)
 * @returns Updated research file data (new object)
 */
export function resolveOpenQuestion(
  data: ResearchFileData,
  questionText: string
): ResearchFileData {
  const normalized = questionText.trim().toLowerCase();
  if (!normalized) return data;

  const filtered = data.openQuestions.filter(
    q => !q.toLowerCase().includes(normalized)
  );

  // No change if question wasn't found
  if (filtered.length === data.openQuestions.length) return data;

  return {
    ...data,
    metadata: { ...data.metadata, updatedAt: new Date().toISOString() },
    openQuestions: filtered,
  };
}

/**
 * Set or update the research conclusion.
 *
 * @param data - Current research file data
 * @param conclusion - The conclusion text
 * @returns Updated research file data (new object)
 */
export function setConclusion(
  data: ResearchFileData,
  conclusion: string
): ResearchFileData {
  return {
    ...data,
    metadata: { ...data.metadata, updatedAt: new Date().toISOString() },
    conclusion: conclusion.trim(),
  };
}

/**
 * Add a resource to the research data.
 *
 * Avoids duplicates by name (case-insensitive).
 *
 * @param data - Current research file data
 * @param resource - The resource to add
 * @returns Updated research file data (new object)
 */
export function addResource(
  data: ResearchFileData,
  resource: ResearchResource
): ResearchFileData {
  const exists = data.resources.some(
    r => r.name.toLowerCase() === resource.name.toLowerCase()
  );
  if (exists) return data;

  return {
    ...data,
    metadata: { ...data.metadata, updatedAt: new Date().toISOString() },
    resources: [...data.resources, resource],
  };
}

/**
 * Add a research objective to the checklist.
 *
 * Avoids duplicates (case-insensitive).
 *
 * @param data - Current research file data
 * @param objective - The objective text
 * @returns Updated research file data (new object)
 */
export function addObjective(
  data: ResearchFileData,
  objective: string
): ResearchFileData {
  const normalized = objective.trim();
  if (!normalized) return data;

  const exists = data.objectives.some(
    o => o.toLowerCase() === normalized.toLowerCase()
  );
  if (exists) return data;

  return {
    ...data,
    metadata: { ...data.metadata, updatedAt: new Date().toISOString() },
    objectives: [...data.objectives, normalized],
  };
}

/**
 * Mark a research objective as complete by removing it from the checklist.
 *
 * Uses case-insensitive substring matching.
 *
 * @param data - Current research file data
 * @param objectiveText - The objective to mark complete (can be partial match)
 * @returns Updated research file data (new object)
 */
export function completeObjective(
  data: ResearchFileData,
  objectiveText: string
): ResearchFileData {
  const normalized = objectiveText.trim().toLowerCase();
  if (!normalized) return data;

  const filtered = data.objectives.filter(
    o => !o.toLowerCase().includes(normalized)
  );

  if (filtered.length === data.objectives.length) return data;

  return {
    ...data,
    metadata: { ...data.metadata, updatedAt: new Date().toISOString() },
    objectives: filtered,
  };
}

// ─── Archive ────────────────────────────────────────────────────────

/**
 * Generate an archived version of the research file.
 *
 * Called when research is complete. Adds an archive header with
 * completion timestamp and generates the final markdown content.
 *
 * @param data - Final research file data (should have conclusion set)
 * @returns Archive result with content and timestamp
 */
export function archiveResearch(data: ResearchFileData): ArchiveResult {
  const archivedAt = new Date().toISOString();
  const archivedData: ResearchFileData = {
    ...data,
    metadata: {
      ...data.metadata,
      updatedAt: archivedAt,
    },
  };

  const lines: string[] = [];
  lines.push(`# 📁 研究归档: ${data.metadata.topic}`);
  lines.push('');
  lines.push(`> 本研究已于 ${archivedAt} 完成。`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(generateResearchMarkdown(archivedData));

  return {
    archivedContent: lines.join('\n'),
    archivedAt,
  };
}

// ─── Internal helpers ───────────────────────────────────────────────

/**
 * Extract a timestamp value from lines matching a label pattern.
 */
function extractTimestamp(lines: string[], label: string): string | null {
  for (const line of lines) {
    if (line.includes(label)) {
      // Match patterns like "*创建时间: 2024-01-01T00:00:00.000Z*"
      const match = line.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?/);
      if (match) return match[0];
    }
  }
  return null;
}

/**
 * Extract the content between two section headers.
 *
 * Returns everything between `startHeader` and the next `## ` header
 * (or end of file).
 */
function extractSection(content: string, startHeader: string): string {
  const lines = content.split('\n');
  const startIdx = lines.findIndex(l => l.trim() === startHeader);
  if (startIdx === -1) return '';

  // Find the next section header (## level)
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ') && i > startIdx) {
      endIdx = i;
      break;
    }
  }

  return lines.slice(startIdx + 1, endIdx).join('\n').trim();
}

/**
 * Parse checkbox items from a section.
 *
 * Extracts text from `- [ ] item` and `- [x] item` patterns.
 */
function parseCheckboxItems(section: string): string[] {
  const items: string[] = [];
  for (const line of section.split('\n')) {
    const match = line.match(/^-\s*\[[ x]\]\s+(.+)$/);
    if (match) {
      items.push(match[1].trim());
    }
  }
  return items;
}

/**
 * Parse findings from the findings section.
 *
 * Each finding is a `### Title` subsection with optional source line,
 * content, and timestamp.
 */
function parseFindings(section: string): ResearchFinding[] {
  const findings: ResearchFinding[] = [];
  const subsections = section.split(/^### /m);

  for (const sub of subsections) {
    if (!sub.trim()) continue;

    const subLines = sub.split('\n');
    const title = subLines[0]?.trim() || 'Untitled';

    // Skip placeholder lines like (尚无发现) or (无)
    if (/^\(.*\)$/.test(title)) continue;

    let source: string | undefined;
    let contentLines: string[] = [];
    let addedAt = '';

    for (const line of subLines.slice(1)) {
      if (line.startsWith('- **来源**:') || line.startsWith('- **Source**:')) {
        source = line.replace(/^-\s*\*\*(?:来源|Source)\*\*:\s*/, '').trim();
      } else if (line.startsWith('*添加时间:') || line.startsWith('*Added:')) {
        const match = line.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?/);
        if (match) addedAt = match[0];
      } else if (line.trim()) {
        contentLines.push(line);
      }
    }

    findings.push({
      title,
      content: contentLines.join('\n').trim(),
      source,
      addedAt: addedAt || new Date().toISOString(),
    });
  }

  return findings;
}

/**
 * Parse resources from the resources section.
 *
 * Handles both markdown links `[name](url)` and plain text `- name`.
 */
function parseResources(section: string): ResearchResource[] {
  const resources: ResearchResource[] = [];

  for (const line of section.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('(')) continue; // Skip empty/placeholder lines

    // Markdown link: - [name](url)
    const linkMatch = trimmed.match(/^-\s*\[([^\]]+)\]\(([^)]+)\)$/);
    if (linkMatch) {
      resources.push({ name: linkMatch[1], url: linkMatch[2] });
      continue;
    }

    // Plain list item: - name
    const plainMatch = trimmed.match(/^-\s+(.+)$/);
    if (plainMatch) {
      resources.push({ name: plainMatch[1] });
    }
  }

  return resources;
}
