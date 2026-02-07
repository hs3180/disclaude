/**
 * Prompt Builder Module - Centralized prompt building for Scout agent.
 *
 * This module provides reusable functions for building prompts with context
 * for the Scout agent. Manager and Worker agents receive prompts directly
 * from dialogue-bridge without transformation.
 */

import { createLogger } from '../utils/logger.js';

const logger = createLogger('PromptBuilder', {});

/**
 * Task context for Scout agent.
 */
export interface TaskContext {
  chatId: string;
  userId?: string;
  messageId: string;
  taskPath: string;
  /** Conversation history (optional) */
  conversationHistory?: string;
}

/**
 * Task context for Worker agent.
 */
export interface WorkerTaskContext {
  chatId: string;
  messageId: string;
  taskPath: string;
  /** User's original request */
  userPrompt: string;
  /** Manager's instruction for this iteration */
  managerInstruction: string;
}

/**
 * Build prompt with task context for Scout agent.
 *
 * @param userPrompt - Original user prompt
 * @param taskContext - Task context object containing chatId, userId, messageId, taskPath
 * @param skillContent - Optional skill file content for template extraction
 * @returns Formatted prompt with context prepended
 */
export function buildScoutPrompt(
  userPrompt: string,
  taskContext: TaskContext,
  skillContent?: string
): string {
  if (!taskContext) {
    return userPrompt;
  }

  // Extract prompt template from skill file
  // The template should be in a section called "## Prompt Template"
  const promptTemplate = extractPromptTemplate(skillContent);

  // Replace placeholders in the template
  const prompt = promptTemplate
    .replace('{messageId}', taskContext.messageId)
    .replace('{taskPath}', taskContext.taskPath)
    .replace('{chatId}', taskContext.chatId)
    .replace('{userId (if available)}', taskContext.userId || 'N/A')
    .replace('{userPrompt}', userPrompt);

  return prompt;
}

/**
 * Build prompt with task context for Worker agent.
 *
 * Unlike Scout, Worker receives a concise prompt without the full Task.md.
 * This reduces verbosity and focuses Worker on the immediate task.
 *
 * @param workerContext - Worker task context object
 * @param skillContent - Optional skill file content for template extraction
 * @returns Formatted prompt with context
 */
export function buildWorkerPrompt(
  workerContext: WorkerTaskContext,
  skillContent?: string
): string {
  // Extract prompt template from skill file
  // The template should be in a section called "## Prompt Template"
  const promptTemplate = extractWorkerPromptTemplate(skillContent);

  // Replace placeholders in the template
  const prompt = promptTemplate
    .replace('{chatId}', workerContext.chatId)
    .replace('{messageId}', workerContext.messageId)
    .replace('{taskPath}', workerContext.taskPath)
    .replace('{userPrompt}', workerContext.userPrompt)
    .replace('{managerInstruction}', workerContext.managerInstruction);

  return prompt;
}

/**
 * Extract the Worker prompt template from the worker skill file.
 *
 * Looks for a section titled "## Prompt Template" and returns its content.
 * The template should use placeholders like {chatId}, {messageId}, etc.
 * that will be replaced with actual values.
 *
 * The template is delimited by ~~~PROMPT_TEMPLATE markers to avoid conflicts
 * with nested code blocks that use ``` markers.
 *
 * @param skillContent - Skill file markdown content (optional)
 * @returns Extracted template string or fallback template if not found
 */
export function extractWorkerPromptTemplate(skillContent?: string): string {
  if (!skillContent) {
    logger.warn('Skill content not provided, using fallback Worker template');
    return getWorkerFallbackTemplate();
  }

  // Find the "## Prompt Template" section
  const templateSectionMatch = skillContent.match(/##\s*Prompt\s*\Template\s*\n([\s\S]+)/);

  if (!templateSectionMatch || !templateSectionMatch[1]) {
    logger.warn('Could not find "## Prompt Template" section in Worker skill file, using fallback');
    return getWorkerFallbackTemplate();
  }

  // Extract the template content between ~~~PROMPT_TEMPLATE markers
  const codeBlockMatch = templateSectionMatch[1].match(/~~~PROMPT_TEMPLATE\n([\s\S]*?)~~~PROMPT_TEMPLATE/);

  if (!codeBlockMatch || !codeBlockMatch[1]) {
    logger.warn('Could not find PROMPT_TEMPLATE delimiters in Worker skill file, using fallback');
    return getWorkerFallbackTemplate();
  }

  return codeBlockMatch[1].trim();
}

/**
 * Get fallback Worker prompt template when skill file is unavailable.
 * This should rarely happen as skill loading is mandatory.
 *
 * @returns Default template string
 */
export function getWorkerFallbackTemplate(): string {
  return `## Task Context

- **Chat ID**: {chatId}
- **Message ID**: {messageId}
- **Task Path**: {taskPath}

---

## Original Request

\`\`\`
{userPrompt}
\`\`\`

---

## Manager's Instruction

{managerInstruction}

---

## Your Task

Execute according to Manager's instruction above.
Report what you did and the outcomes.

When you complete your work, the SDK will signal completion automatically.`;
}

/**
 * Parse Task.md to extract metadata and user request.
 *
 * Extracts:
 * - Task ID (messageId)
 * - Chat ID
 * - User ID (optional)
 * - User's original request (from "## Original Request" section)
 *
 * @param taskMdContent - Full Task.md content
 * @returns Parsed task metadata
 */
export function parseTaskMd(taskMdContent: string): {
  messageId: string;
  chatId: string;
  userId?: string;
  userRequest: string;
} {
  // Extract Task ID (messageId) from "**Task ID**: ..." or "**Task ID**: ..." line
  const taskIdMatch = taskMdContent.match(/\*?\*?Task ID\*?\*?:\s*([^\n]+)/i);
  const messageId = taskIdMatch ? taskIdMatch[1].trim() : '';

  // Extract Chat ID from "**Chat ID**: ..." line
  const chatIdMatch = taskMdContent.match(/\*?\*?Chat ID\*?\*?:\s*([^\n]+)/i);
  const chatId = chatIdMatch ? chatIdMatch[1].trim() : '';

  // Extract User ID from "**User ID**: ..." line (optional)
  const userIdMatch = taskMdContent.match(/\*?\*?User ID\*?\*?:\s*([^\n]+)/i);
  const userId = userIdMatch ? userIdMatch[1].trim() : undefined;

  // Extract Original Request from "## Original Request" section
  // The request is in a code block after this section
  const originalRequestSectionMatch = taskMdContent.match(/##\s*Original\s*Request\s*\n([\s\S]*?)(?=##|\Z)/);
  let userRequest = '';

  if (originalRequestSectionMatch && originalRequestSectionMatch[1]) {
    // Extract content from code block (``` or ~~~)
    const codeBlockMatch = originalRequestSectionMatch[1].match(/```[\s\S]*?\n([\s\S]*?)```|~~~[\s\S]*?\n([\s\S]*?)~~~/);
    if (codeBlockMatch) {
      userRequest = (codeBlockMatch[1] || codeBlockMatch[2] || '').trim();
    } else {
      // Fallback: use the entire section content without leading/trailing whitespace
      userRequest = originalRequestSectionMatch[1].trim();
    }
  }

  return {
    messageId,
    chatId,
    userId,
    userRequest,
  };
}

/**
 * Extract the prompt template from the scout skill file.
 *
 * Looks for a section titled "## Prompt Template" and returns its content.
 * The template should use placeholders like {messageId}, {taskPath}, etc.
 * that will be replaced with actual values.
 *
 * The template is delimited by ~~~PROMPT_TEMPLATE markers to avoid conflicts
 * with nested code blocks that use ``` markers.
 *
 * @param skillContent - Skill file markdown content (optional)
 * @returns Extracted template string or fallback template if not found
 */
export function extractPromptTemplate(skillContent?: string): string {
  if (!skillContent) {
    logger.warn('Skill content not provided, using fallback template');
    return getFallbackTemplate();
  }

  // Find the "## Prompt Template" section (match everything after it to end of file)
  // This is the last section in the skill file, so we match to the end
  const templateSectionMatch = skillContent.match(/##\s*Prompt\s*\Template\s*\n([\s\S]+)/);

  if (!templateSectionMatch || !templateSectionMatch[1]) {
    logger.warn('Could not find "## Prompt Template" section in skill file, using fallback');
    return getFallbackTemplate();
  }

  // Extract the template content between ~~~PROMPT_TEMPLATE markers
  const codeBlockMatch = templateSectionMatch[1].match(/~~~PROMPT_TEMPLATE\n([\s\S]*?)~~~PROMPT_TEMPLATE/);

  if (!codeBlockMatch || !codeBlockMatch[1]) {
    logger.warn('Could not find PROMPT_TEMPLATE delimiters in skill file, using fallback');
    return getFallbackTemplate();
  }

  return codeBlockMatch[1].trim();
}

/**
 * Get fallback prompt template when skill file is unavailable.
 * This should rarely happen as skill loading is mandatory.
 *
 * @returns Default template string
 */
export function getFallbackTemplate(): string {
  return `## Task Context

- **Message ID**: {messageId}
- **Task Path**: {taskPath}
- **Chat ID**: {chatId}
- **User ID**: {userId (if available)}

---

## User Request

\`\`\`
{userPrompt}
\`\`\`

---

## Your Instruction

You are a **task initialization specialist**. Your workflow:

1. **Explore first** (for code-related tasks): Use Read, Glob, Grep to understand the codebase
2. **Create Task.md**: Use the Write tool to create a Task.md file at the exact taskPath

**CRITICAL - Task.md Format:**
Task.md must contain ONLY these sections:
- **Metadata header** (Task ID, Created, Chat ID, User ID)
- **Original Request** (preserved exactly)
- **Expected Results** (what Worker should produce)

**DO NOT add to Task.md:**
- ❌ Context Discovery
- ❌ Intent Analysis
- ❌ Completion Instructions
- ❌ Task Type field
- ❌ Any other sections

Use your exploration and analysis INTERNALLY to inform the Expected Results section, but do NOT write those sections to the file.

**Remember**: You are creating a task specification for Worker to execute, not answering directly.`;
}
