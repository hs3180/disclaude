/**
 * PR Scanner schema definitions and validation functions.
 *
 * Manages state files for tracking PR review progress.
 * State files are stored in `.temp-chats/` as the single source of truth.
 *
 * No external dependencies — uses only Node.js built-ins.
 */

// ---- Types ----

export type PrState = 'reviewing' | 'approved' | 'closed';

export interface PrStateFile {
  prNumber: number;
  chatId: string | null;
  state: PrState;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  disbandRequested: null; // Phase 2 will extend to string | null
}

// ---- Constants ----

/** Directory for PR state files */
export const PR_STATE_DIR = '.temp-chats';

/** State file naming pattern: pr-{number}.json */
export const PR_STATE_FILE_REGEX = /^pr-(\d+)\.json$/;

/** Valid state transitions */
export const VALID_TRANSITIONS: Record<PrState, PrState[]> = {
  reviewing: ['approved', 'closed'],
  approved: ['closed'],
  closed: [],
};

/** Default max concurrent reviewing PRs */
export const DEFAULT_MAX_CONCURRENT = 3;

/** Default expiry duration: 48 hours in milliseconds */
export const DEFAULT_EXPIRY_HOURS = 48;

/** UTC datetime regex */
export const UTC_DATETIME_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** Valid PR states as a set */
export const VALID_STATES = new Set<PrState>(['reviewing', 'approved', 'closed']);

// ---- Validation helpers ----

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** Get the current UTC timestamp in ISO 8601 Z-suffix format */
export function nowISO(): string {
  return new Date().toISOString();
}

/** Validate a PR number */
export function validatePrNumber(prNumber: unknown): number {
  const n = typeof prNumber === 'string' ? parseInt(prNumber, 10) : prNumber;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    throw new ValidationError(`Invalid PR number: ${prNumber} (must be a positive integer)`);
  }
  return n;
}

/** Validate a PR state value */
export function validateState(state: unknown): PrState {
  if (typeof state !== 'string' || !VALID_STATES.has(state as PrState)) {
    throw new ValidationError(
      `Invalid state '${state}' — must be one of: ${[...VALID_STATES].join(', ')}`,
    );
  }
  return state as PrState;
}

/** Validate a state transition is allowed */
export function validateTransition(from: PrState, to: PrState): void {
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed || !allowed.includes(to)) {
    throw new ValidationError(
      `Invalid state transition: '${from}' → '${to}' (allowed: ${allowed.length > 0 ? allowed.join(', ') : 'none'})`,
    );
  }
}

/** Validate UTC datetime string format */
export function validateDatetime(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UTC_DATETIME_REGEX.test(value)) {
    throw new ValidationError(
      `Invalid ${field}: '${value}' (must be UTC Z-suffix format, e.g. 2026-04-07T10:00:00Z)`,
    );
  }
  return value;
}

/** Parse and validate a PR state file from JSON string */
export function parsePrStateFile(json: string, filePath: string): PrStateFile {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new ValidationError(`State file '${filePath}' is not valid JSON`);
  }
  return validatePrStateFileData(data, filePath);
}

/** Validate the structure of a parsed PR state file object */
export function validatePrStateFileData(data: unknown, filePath: string): PrStateFile {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new ValidationError(`State file '${filePath}' is not a valid JSON object`);
  }
  const obj = data as Record<string, unknown>;

  // Required fields
  const prNumber = obj.prNumber;
  if (typeof prNumber !== 'number' || !Number.isFinite(prNumber) || prNumber <= 0 || !Number.isInteger(prNumber)) {
    throw new ValidationError(`State file '${filePath}' has invalid or missing 'prNumber'`);
  }

  const state = obj.state;
  if (typeof state !== 'string' || !VALID_STATES.has(state as PrState)) {
    throw new ValidationError(`State file '${filePath}' has invalid 'state': '${state}'`);
  }

  validateDatetime(obj.createdAt, `createdAt in '${filePath}'`);
  validateDatetime(obj.updatedAt, `updatedAt in '${filePath}'`);
  validateDatetime(obj.expiresAt, `expiresAt in '${filePath}'`);

  // chatId: string | null
  if (obj.chatId != null && typeof obj.chatId !== 'string') {
    throw new ValidationError(`State file '${filePath}' has invalid 'chatId'`);
  }

  // disbandRequested: must be null in Phase 1
  if (obj.disbandRequested !== null) {
    throw new ValidationError(`State file '${filePath}' has invalid 'disbandRequested' (must be null in Phase 1)`);
  }

  return data as PrStateFile;
}

/** Extract PR number from state filename (e.g. "pr-123.json" → 123) */
export function parsePrNumberFromFilename(filename: string): number | null {
  const match = PR_STATE_FILE_REGEX.exec(filename);
  if (!match) return null;
  return parseInt(match[1], 10);
}
