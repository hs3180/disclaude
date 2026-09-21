/** Project-scoped Research state. Stored inside the active ProjectManager directory. */

import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { ResearchDirectionStatus, ResearchFinding } from './checkpoint.js';

export type ResearchStatus =
  | 'paused'
  | 'running'
  | 'waiting-user'
  | 'pausing'
  | 'cancelling'
  | 'cancelled'
  | 'failed'
  | 'completed'
  | 'interrupted';

export interface ResearchDirection {
  id: string;
  title: string;
  status: ResearchDirectionStatus;
  findings: ResearchFinding[];
}

export interface ResearchFeedback {
  text: string;
  status: 'pending' | 'applied' | 'rejected' | 'needs-clarification';
  at: string;
  reason?: string;
  directionIds?: string[];
  sourceKey?: string;
}

export interface ResearchDocumentSnapshot {
  token: string;
  revision: number;
  body: string;
  rawBody?: string;
  comments: Array<{ id: string; text: string }>;
  fingerprint: string;
  syncedAt: string;
}

export interface ResearchDocumentState {
  url: string;
  token: string;
  snapshot?: ResearchDocumentSnapshot;
  previous: ResearchDocumentSnapshot[];
  publishedFragments: string[];
  generation: number;
  error?: string;
}

export interface ResearchHistoryEntry {
  at: string;
  text: string;
}

export interface ResearchProject {
  id: string;
  /** Frozen project directory; it is never inferred from another chat at runtime. */
  workingDir: string;
  owner: string;
  chatId: string;
  threadId?: string;
  source: string;
  requestKey?: string;
  title: string;
  scope: string;
  materials: string;
  document?: ResearchDocumentState;
  status: ResearchStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
  directions: ResearchDirection[];
  summary: string;
  questions: string[];
  history: ResearchHistoryEntry[];
  feedback: ResearchFeedback[];
  clarification?: string;
  error?: string;
  deliveryError?: string;
  stepCount: number;
}

interface ResearchStateFile {
  version: 1;
  projects: ResearchProject[];
}

const STATE_VERSION = 1 as const;
const PROJECT_ID_FILE = /^[a-f0-9-]+\.json$/u;

/**
 * A lockable state store for one existing ProjectManager working directory.
 * It deliberately does not create a parallel workspace or a task database.
 */
export class ProjectResearchStore {
  private lock?: number;
  private readonly configDir: string;
  private readonly statePath: string;
  private readonly lockPath: string;

  constructor(readonly workingDir: string) {
    this.configDir = path.join(workingDir, '.disclaude');
    this.statePath = path.join(this.configDir, 'research-state.json');
    this.lockPath = path.join(this.configDir, 'research-state.owner');
  }

  open(): void {
    if (this.lock !== undefined) {
      return;
    }
    if (
      !path.isAbsolute(this.workingDir) ||
      !existsSync(this.workingDir) ||
      !statSync(this.workingDir).isDirectory()
    ) {
      throw new Error(
        'Research project directory does not exist or is not a directory; existing findings are preserved.'
      );
    }
    mkdirSync(this.configDir, { recursive: true, mode: 0o700 });
    try {
      this.lock = openSync(this.lockPath, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
      const recoveryPath = `${this.lockPath}.recovering`;
      let recovery: number | undefined;
      try {
        recovery = openSync(recoveryPath, 'wx', 0o600);
        const pid = Number(readFileSync(this.lockPath, 'utf8'));
        if (!Number.isSafeInteger(pid) || pid <= 0) {
          throw new Error(
            'Research state lock is invalid; inspect the running service before recovery.'
          );
        }
        try {
          process.kill(pid, 0);
        } catch (probe) {
          if ((probe as NodeJS.ErrnoException).code !== 'ESRCH') {
            throw new Error('Another service is using this project Research state.');
          }
          rmSync(this.lockPath, { force: true });
          this.lock = openSync(this.lockPath, 'wx', 0o600);
        }
        if (this.lock === undefined) {
          throw new Error('Another service is using this project Research state.');
        }
      } finally {
        if (recovery !== undefined) {
          closeSync(recovery);
        }
        rmSync(recoveryPath, { force: true });
      }
    }
    if (this.lock === undefined) {
      throw new Error('Research state lock could not be acquired.');
    }
    writeFileSync(this.lock, String(process.pid), 'utf8');
  }

  readAll(): ResearchProject[] {
    this.open();
    if (!existsSync(this.statePath)) {
      return [];
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.statePath, 'utf8')) as unknown;
    } catch (error) {
      throw new Error(
        `Research state is unreadable; the original file was preserved: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Research state is damaged; the original file was preserved.');
    }
    const state = raw as Partial<ResearchStateFile>;
    if (state.version !== STATE_VERSION || !Array.isArray(state.projects)) {
      throw new Error('Unsupported or damaged Research state; the original file was preserved.');
    }
    return state.projects.map((project) => this.validateProject(project));
  }

  saveAll(projects: readonly ResearchProject[]): void {
    this.open();
    const tempPath = `${this.statePath}.${randomUUID()}.tmp`;
    const payload: ResearchStateFile = {
      version: STATE_VERSION,
      projects: structuredClone([...projects]),
    };
    try {
      writeFileSync(tempPath, JSON.stringify(payload, null, 2), { mode: 0o600, flag: 'wx' });
      renameSync(tempPath, this.statePath);
    } finally {
      rmSync(tempPath, { force: true });
    }
  }

  close(): void {
    if (this.lock === undefined) {
      return;
    }
    closeSync(this.lock);
    this.lock = undefined;
    rmSync(this.lockPath, { force: true });
  }

  get paths(): { state: string; lock: string } {
    return { state: this.statePath, lock: this.lockPath };
  }

  private validateProject(value: ResearchProject): ResearchProject {
    if (
      !value ||
      typeof value !== 'object' ||
      typeof value.id !== 'string' ||
      value.id.length === 0 ||
      value.workingDir !== this.workingDir ||
      typeof value.owner !== 'string' ||
      typeof value.chatId !== 'string' ||
      typeof value.title !== 'string' ||
      typeof value.scope !== 'string' ||
      typeof value.materials !== 'string' ||
      !Array.isArray(value.directions) ||
      !Array.isArray(value.history) ||
      !Array.isArray(value.feedback)
    ) {
      throw new Error(
        'Research state contains an invalid project; the original file was preserved.'
      );
    }
    return structuredClone(value);
  }
}

/** Kept private to make accidental generic-task reuse harder. */
export const isResearchProjectFileName = (name: string): boolean => PROJECT_ID_FILE.test(name);
