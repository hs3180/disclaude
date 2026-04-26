/**
 * Chat schema definitions and validation functions.
 *
 * Replaces jq-based JSON validation with native TypeScript validation.
 * No external dependencies — uses only Node.js built-ins.
 */

// ---- Types ----

export type ChatStatus = 'pending' | 'active' | 'expired' | 'failed';

export interface ChatResponse {
  content: string;
  responder: string;
  repliedAt: string;
}

export interface CreateGroup {
  name: string;
  members: string[];
}

export interface ChatFile {
  id: string;
  status: ChatStatus;
  chatId: string | null;
  createdAt: string;
  activatedAt: string | null;
  expiresAt: string;
  expiredAt: string | null;
  createGroup: CreateGroup;
  context: Record<string, unknown>;
  /**
   * Trigger mode configuration for this chat (Issue #2018, #2291).
   *
   * - `'always'`: Bot responds to all messages (default for 1-on-1 temp chats)
   * - `'mention'`: Bot only responds to @mentions (default for group temp chats)
   * - `undefined`: Resolved by primary-node at activation time
   */
  triggerMode?: 'mention' | 'always';
  response: ChatResponse | null;
  activationAttempts: number;
  lastActivationError: string | null;
  failedAt: string | null;
}

// ---- Constants ----

export const CHAT_DIR = 'workspace/chats';
export const CHAT_ID_REGEX = /^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/;
export const MEMBER_ID_REGEX = /^ou_[a-zA-Z0-9]+$/;
export const GROUP_NAME_REGEX = /^[a-zA-Z0-9_\-.#:/ ()（）【】]+$/;
export const UTC_DATETIME_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
export const MAX_GROUP_NAME_LENGTH = 64;
export const MAX_CONTEXT_SIZE = 4096;
export const MAX_RESPONSE_LENGTH = 10000;
export const MAX_RETRIES = 5;
export const DEFAULT_MAX_PER_RUN = 10;
export const LARK_TIMEOUT_MS = 30_000;

// ---- Validation helpers ----

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export function validateChatId(id: string): void {
  if (!id) {
    throw new ValidationError('CHAT_ID environment variable is required');
  }
  if (!CHAT_ID_REGEX.test(id)) {
    throw new ValidationError(
      `Invalid chat ID '${id}' — must start with [a-zA-Z0-9_-], only [a-zA-Z0-9._-] allowed`,
    );
  }
}

export function validateExpiresAt(expiresAt: string): void {
  if (!expiresAt) {
    throw new ValidationError('CHAT_EXPIRES_AT environment variable is required');
  }
  if (!UTC_DATETIME_REGEX.test(expiresAt)) {
    throw new ValidationError(
      `CHAT_EXPIRES_AT must be UTC Z-suffix format (e.g. 2026-03-25T10:00:00Z), got '${expiresAt}'`,
    );
  }
  const now = new Date();
  const expiry = new Date(expiresAt);
  if (expiry <= now) {
    console.error(`WARN: CHAT_EXPIRES_AT '${expiresAt}' is already in the past (now: ${nowISO()})`);
  }
}

export function validateGroupName(name: string): void {
  if (!name) {
    throw new ValidationError('CHAT_GROUP_NAME environment variable is required');
  }
  if (!GROUP_NAME_REGEX.test(name)) {
    throw new ValidationError(`Invalid group name '${name}' — contains unsafe characters`);
  }
}

export function validateMembers(members: unknown): string[] {
  if (!Array.isArray(members) || members.length === 0) {
    throw new ValidationError('CHAT_MEMBERS must be a non-empty JSON array of open IDs');
  }
  for (const member of members) {
    if (typeof member !== 'string' || !MEMBER_ID_REGEX.test(member)) {
      throw new ValidationError(`Invalid member ID '${member}' — expected ou_xxxxx format`);
    }
  }
  return members;
}

export function validateContext(context: unknown): Record<string, unknown> {
  if (context === undefined || context === null) {
    return {};
  }
  if (typeof context !== 'object' || Array.isArray(context)) {
    throw new ValidationError(`CHAT_CONTEXT must be a JSON object, got '${JSON.stringify(context)}'`);
  }
  const size = JSON.stringify(context).length;
  if (size > MAX_CONTEXT_SIZE) {
    throw new ValidationError(`CHAT_CONTEXT too large (${size} bytes, max ${MAX_CONTEXT_SIZE})`);
  }
  return context as Record<string, unknown>;
}

export function validateResponder(responder: string): void {
  if (!responder) {
    throw new ValidationError('CHAT_RESPONDER environment variable is required');
  }
  if (!MEMBER_ID_REGEX.test(responder)) {
    throw new ValidationError(`Invalid responder ID '${responder}' — expected ou_xxxxx format`);
  }
}

export function validateResponseContent(content: string): void {
  if (!content) {
    throw new ValidationError('CHAT_RESPONSE environment variable is required');
  }
  if (content.length > MAX_RESPONSE_LENGTH) {
    throw new ValidationError(
      `CHAT_RESPONSE too long (${content.length} chars, max ${MAX_RESPONSE_LENGTH})`,
    );
  }
}

/** Parse and validate a chat file from JSON string */
export function parseChatFile(json: string, filePath: string): ChatFile {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new ValidationError(`Chat file '${filePath}' is not valid JSON`);
  }
  return validateChatFileData(data, filePath);
}

/** Validate the structure of a parsed chat file object */
export function validateChatFileData(data: unknown, filePath: string): ChatFile {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new ValidationError(`Chat file '${filePath}' is not a valid JSON object`);
  }
  const obj = data as Record<string, unknown>;

  // Required fields
  if (typeof obj.id !== 'string' || !CHAT_ID_REGEX.test(obj.id)) {
    throw new ValidationError(`Chat file '${filePath}' has invalid or missing 'id'`);
  }
  if (!isValidStatus(obj.status)) {
    throw new ValidationError(`Chat file '${filePath}' has invalid 'status': '${obj.status}'`);
  }
  if (typeof obj.expiresAt !== 'string' || !UTC_DATETIME_REGEX.test(obj.expiresAt)) {
    throw new ValidationError(`Chat file '${filePath}' has missing or invalid 'expiresAt' (must be UTC Z-suffix)`);
  }
  if (
    !obj.createGroup ||
    typeof obj.createGroup !== 'object' ||
    typeof (obj.createGroup as Record<string, unknown>).name !== 'string' ||
    !Array.isArray((obj.createGroup as Record<string, unknown>).members)
  ) {
    throw new ValidationError(`Chat file '${filePath}' has invalid 'createGroup'`);
  }

  // Validate members format
  const members = (obj.createGroup as Record<string, unknown>).members as unknown[];
  for (const member of members) {
    if (typeof member !== 'string' || !MEMBER_ID_REGEX.test(member)) {
      throw new ValidationError(`Chat file '${filePath}' has invalid member ID '${member}'`);
    }
  }

  // Validate optional fields with type checks
  // Use != null (loose equality) to treat both null and undefined as "not set"
  if (obj.chatId != null && typeof obj.chatId !== 'string') {
    throw new ValidationError(`Chat file '${filePath}' has invalid 'chatId'`);
  }
  if (obj.activatedAt != null && typeof obj.activatedAt !== 'string') {
    throw new ValidationError(`Chat file '${filePath}' has invalid 'activatedAt'`);
  }
  if (obj.expiredAt != null && typeof obj.expiredAt !== 'string') {
    throw new ValidationError(`Chat file '${filePath}' has invalid 'expiredAt'`);
  }
  if (obj.expiredAt != null && typeof obj.expiredAt === 'string' && !UTC_DATETIME_REGEX.test(obj.expiredAt)) {
    throw new ValidationError(`Chat file '${filePath}' has invalid 'expiredAt' (must be UTC Z-suffix)`);
  }
  if (obj.failedAt != null && typeof obj.failedAt !== 'string') {
    throw new ValidationError(`Chat file '${filePath}' has invalid 'failedAt'`);
  }
  if (typeof obj.activationAttempts !== 'number' || obj.activationAttempts < 0) {
    throw new ValidationError(`Chat file '${filePath}' has invalid 'activationAttempts'`);
  }

  // Validate triggerMode enum value if present
  if (obj.triggerMode != null) {
    if (obj.triggerMode !== 'mention' && obj.triggerMode !== 'always') {
      throw new ValidationError(
        `Chat file '${filePath}' has invalid 'triggerMode': '${obj.triggerMode}' (must be 'mention' or 'always')`,
      );
    }
  }

  return data as ChatFile;
}

function isValidStatus(status: unknown): status is ChatStatus {
  return typeof status === 'string' && ['pending', 'active', 'expired', 'failed'].includes(status);
}

/** Get the current UTC timestamp in ISO 8601 Z-suffix format */
export function nowISO(): string {
  return new Date().toISOString();
}

/** Truncate a group name to max length at character boundaries */
export function truncateGroupName(name: string): string {
  return Array.from(name).slice(0, MAX_GROUP_NAME_LENGTH).join('');
}
