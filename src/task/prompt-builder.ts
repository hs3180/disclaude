/**
 * Prompt Builder Module - Centralized prompt building for Scout agent.
 *
 * This module provides reusable functions for building prompts with context
 * for the Scout agent.
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
 * Build prompt with task context for Scout agent.
 *
 * Uses a direct template defined in this module (not extracted from skill files).
 * This ensures Scout's prompt structure is stable and explicitly defined in code.
 *
 * @param userPrompt - Original user prompt
 * @param taskContext - Task context object containing chatId, userId, messageId, taskPath
 * @returns Formatted prompt with context prepended
 */
export function buildScoutPrompt(
  userPrompt: string,
  taskContext: TaskContext,
  // skillContent parameter is kept for backward compatibility but unused
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  skillContent?: string
): string {
  if (!taskContext) {
    return userPrompt;
  }

  // Use direct template (defined below)
  const promptTemplate = getDirectTemplate();

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
 * Get the direct prompt template for Scout agent.
 *
 * This template is explicitly defined in code (not loaded from external files)
 * to ensure stability and predictability of Scout's behavior.
 *
 * @returns Direct template string with placeholders
 */
function getDirectTemplate(): string {
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

**Remember**: You are creating a task specification for execution, not answering directly.`;
}

