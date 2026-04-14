/**
 * PR Scanner schema definitions and validation functions.
 *
 * Defines the state file schema for tracking PR review progress.
 * State files live in `.temp-chats/pr-{number}.json`.
 *
 * Schema follows design spec §3.1 strictly:
 * - state: reviewing | approved | closed (no rejected)
 * - expiresAt: createdAt + 48h
 * - disbandRequested: null (Phase 1) or ISO timestamp (Phase 2 lifecycle)
 */

// ---- Types ----

/** State file for tracking a single PR */
export interface PrStateFile {
  prNumber: number;
  chatId: string;
  state: PrState;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  /** null until lifecycle sends disband request; then ISO timestamp of that request */
  disbandRequested: string | null;
}

/** PR tracking state enum (no rejected) */
export type PrState = 'reviewing' | 'approved' | 'closed';

/** check-capacity action result */
export interface CapacityResult {
  reviewing: number;
  maxConcurrent: number;
  available: number;
}

/** list-candidates action result entry */
export interface CandidatePr {
  number: number;
  title: string;
}

/** check-expired action result entry (lifecycle Phase 2) */
export interface ExpiredPr {
  prNumber: number;
  chatId: string;
  needsDisbandRequest: boolean;
}

// ---- Constants ----

/** Directory for state files */
export const STATE_DIR = '.temp-chats';

/** State file pattern: pr-{number}.json */
export const STATE_FILE_REGEX = /^pr-(\d+)\.json$/;

/** Maximum concurrent reviewing PRs (configurable via env) */
export const DEFAULT_MAX_CONCURRENT = 3;

/** Hours until state file expires */
export const EXPIRY_HOURS = 48;

/** Hours to wait before resending disband request */
export const DISBAND_COOLDOWN_HOURS = 24;

/** UTC datetime pattern (allows optional milliseconds) */
export const UTC_DATETIME_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** Valid state values */
const VALID_STATES: readonly string[] = ['reviewing', 'approved', 'closed'];

// ---- Validation ----

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** Validate a PR state value */
export function isValidState(state: unknown): state is PrState {
  return typeof state === 'string' && VALID_STATES.includes(state);
}

/** Parse and validate a state file from JSON string */
export function parseStateFile(json: string, filePath: string): PrStateFile {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new ValidationError(`State file '${filePath}' is not valid JSON`);
  }
  return validateStateFileData(data, filePath);
}

/** Validate the structure of a parsed state file */
export function validateStateFileData(data: unknown, filePath: string): PrStateFile {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new ValidationError(`State file '${filePath}' is not a valid JSON object`);
  }
  const obj = data as Record<string, unknown>;

  // prNumber: required positive integer
  if (typeof obj.prNumber !== 'number' || !Number.isInteger(obj.prNumber) || obj.prNumber <= 0) {
    throw new ValidationError(`State file '${filePath}' has invalid or missing 'prNumber'`);
  }

  // chatId: required string
  if (typeof obj.chatId !== 'string' || obj.chatId.length === 0) {
    throw new ValidationError(`State file '${filePath}' has invalid or missing 'chatId'`);
  }

  // state: required valid enum
  if (!isValidState(obj.state)) {
    throw new ValidationError(`State file '${filePath}' has invalid 'state': '${obj.state}'`);
  }

  // createdAt: required UTC datetime
  if (typeof obj.createdAt !== 'string' || !UTC_DATETIME_REGEX.test(obj.createdAt)) {
    throw new ValidationError(`State file '${filePath}' has missing or invalid 'createdAt'`);
  }

  // updatedAt: required UTC datetime
  if (typeof obj.updatedAt !== 'string' || !UTC_DATETIME_REGEX.test(obj.updatedAt)) {
    throw new ValidationError(`State file '${filePath}' has missing or invalid 'updatedAt'`);
  }

  // expiresAt: required UTC datetime
  if (typeof obj.expiresAt !== 'string' || !UTC_DATETIME_REGEX.test(obj.expiresAt)) {
    throw new ValidationError(`State file '${filePath}' has missing or invalid 'expiresAt'`);
  }

  // disbandRequested: null or valid UTC datetime string (set by lifecycle Phase 2)
  if (obj.disbandRequested !== null) {
    if (typeof obj.disbandRequested !== 'string' || !UTC_DATETIME_REGEX.test(obj.disbandRequested)) {
      throw new ValidationError(`State file '${filePath}' has invalid 'disbandRequested' (must be null or valid UTC datetime)`);
    }
  }

  return data as PrStateFile;
}

// ---- Helpers ----

/** Get the current UTC timestamp in ISO 8601 Z-suffix format */
export function nowISO(): string {
  return new Date().toISOString();
}

/** Compute expiresAt = createdAt + EXPIRY_HOURS */
export function computeExpiresAt(createdAt: string): string {
  const created = new Date(createdAt);
  return new Date(created.getTime() + EXPIRY_HOURS * 3600 * 1000).toISOString();
}

/** Build a state file path for a given PR number */
export function stateFilePath(dir: string, prNumber: number): string {
  return `${dir}/pr-${prNumber}.json`;
}

/** Extract PR number from state file name (e.g., "pr-123.json" → 123) */
export function parsePrNumberFromFileName(fileName: string): number | null {
  const match = STATE_FILE_REGEX.exec(fileName);
  return match ? parseInt(match[1], 10) : null;
}

/** Create a new state file object */
export function createStateFile(prNumber: number, chatId: string, state: PrState = 'reviewing'): PrStateFile {
  const now = nowISO();
  return {
    prNumber,
    chatId,
    state,
    createdAt: now,
    updatedAt: now,
    expiresAt: computeExpiresAt(now),
    disbandRequested: null,
  };
}
