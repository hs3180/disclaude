/**
 * Research State File Management.
 *
 * Manages the RESEARCH.md file in research workspaces, providing template
 * generation, file initialization, and structured access methods.
 *
 * Issue #1710: RESEARCH.md 研究状态文件
 *
 * The RESEARCH.md file serves as the agent's persistent research notebook:
 * - Created when research mode is entered (Phase 1)
 * - Auto-maintained by the agent during research interactions (Phase 2)
 * - Archived when research is completed (Phase 3)
 *
 * Architecture:
 *   ResearchModeManager
 *     └── enterResearchMode()
 *           └── ResearchStateFile.init()
 *                 └── workspace/research/{topic}/RESEARCH.md
 *
 * @module modes/research-state
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('ResearchState');

/** Default filename for the research state file. */
export const RESEARCH_STATE_FILENAME = 'RESEARCH.md';

/**
 * Generate the initial RESEARCH.md template content.
 *
 * Creates a structured markdown template with sections for research goals,
 * collected findings, pending questions, conclusions, and resources.
 *
 * @param topic - The research topic
 * @returns Formatted markdown template string
 */
export function generateResearchTemplate(topic: string): string {
  const now = new Date().toISOString().slice(0, 10);
  return `# ${topic}

> Brief description of research goals and background.

## Research Goals
- [ ] Define primary research objectives
- [ ] Identify key questions to investigate

## Findings

### Finding 1
- **Source**: (to be filled)
- **Content**: (to be filled)

## Pending Questions
- [ ] Question 1 (to be filled)
- [ ] Question 2 (to be filled)

## Conclusions

_Research in progress — conclusions will be added here._

## Resources

- [Resource](url)

---

*Research started: ${now}*
*Auto-maintained by Research Mode agent*
`;
}

/**
 * ResearchStateFile — manages the RESEARCH.md file lifecycle.
 *
 * Provides methods for initializing, reading, and checking the research
 * state file within a research workspace directory.
 *
 * The agent (LLM) is responsible for updating the file content during
 * research interactions. This class handles file-level operations only.
 *
 * @example
 * ```typescript
 * const stateFile = new ResearchStateFile('/path/to/workspace/research/my-topic');
 *
 * // Initialize (create template if not exists)
 * const filePath = await stateFile.init('My Research Topic');
 *
 * // Read current content
 * const content = await stateFile.read();
 *
 * // Check if exists
 * const exists = await stateFile.exists();
 * ```
 */
export class ResearchStateFile {
  private readonly workspaceDir: string;
  private readonly filePath: string;

  /**
   * Create a ResearchStateFile for a workspace directory.
   *
   * @param workspaceDir - Absolute path to the research workspace directory
   */
  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
    this.filePath = path.join(workspaceDir, RESEARCH_STATE_FILENAME);
  }

  /**
   * Get the absolute path to the RESEARCH.md file.
   *
   * @returns Absolute file path
   */
  getFilePath(): string {
    return this.filePath;
  }

  /**
   * Check if the RESEARCH.md file exists.
   *
   * @returns true if the file exists
   */
  async exists(): Promise<boolean> {
    try {
      await fs.access(this.filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Read the current content of the RESEARCH.md file.
   *
   * @returns File content as string
   * @throws Error if the file does not exist
   */
  async read(): Promise<string> {
    const content = await fs.readFile(this.filePath, 'utf-8');
    return content;
  }

  /**
   * Initialize the RESEARCH.md file.
   *
   * Creates the file with a generated template if it does not already exist.
   * If the file exists, it is preserved (no overwrite) to respect user
   * or agent modifications.
   *
   * @param topic - The research topic (used in the template header)
   * @returns The absolute path to the RESEARCH.md file
   */
  async init(topic: string): Promise<string> {
    const alreadyExists = await this.exists();

    if (alreadyExists) {
      logger.debug({ filePath: this.filePath }, 'RESEARCH.md already exists, skipping init');
      return this.filePath;
    }

    const template = generateResearchTemplate(topic);
    await fs.writeFile(this.filePath, template, 'utf-8');
    logger.info({ filePath: this.filePath, topic }, 'Created RESEARCH.md with template');

    return this.filePath;
  }

  /**
   * Get the workspace directory path.
   *
   * @returns Absolute path to the workspace directory
   */
  getWorkspaceDir(): string {
    return this.workspaceDir;
  }
}
