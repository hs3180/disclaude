/**
 * Tests for prompt builder (src/agent/prompt-builder.ts)
 *
 * Tests the following functionality:
 * - Building scout prompts with task context
 * - Extracting prompt templates from skill files
 * - Fallback template generation
 * - Placeholder replacement
 */

import { describe, it, expect, vi } from 'vitest';
import {
  buildScoutPrompt,
  extractPromptTemplate,
  getFallbackTemplate,
  type TaskContext,
} from './prompt-builder.js';

// Mock logger
vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
  }),
}));

describe('buildScoutPrompt', () => {
  const mockTaskContext: TaskContext = {
    chatId: 'oc_test123',
    userId: 'ou_user456',
    messageId: 'om_msg789',
    taskPath: '/workspace/tasks/om_msg789',
  };

  it('should replace all placeholders in template', () => {
    const skillContent = `## Prompt Template

~~~PROMPT_TEMPLATE
Message ID: {messageId}
Task Path: {taskPath}
Chat ID: {chatId}
User ID: {userId (if available)}
Prompt: {userPrompt}
~~~PROMPT_TEMPLATE
`;

    const result = buildScoutPrompt('Test prompt', mockTaskContext, skillContent);

    expect(result).toContain('Message ID: om_msg789');
    expect(result).toContain('Task Path: /workspace/tasks/om_msg789');
    expect(result).toContain('Chat ID: oc_test123');
    expect(result).toContain('User ID: ou_user456');
    expect(result).toContain('Prompt: Test prompt');
  });

  it('should handle missing userId', () => {
    const taskContextWithoutUser: TaskContext = {
      chatId: 'oc_test123',
      messageId: 'om_msg789',
      taskPath: '/workspace/tasks/om_msg789',
    };

    const skillContent = `## Prompt Template

~~~PROMPT_TEMPLATE
User ID: {userId (if available)}
~~~PROMPT_TEMPLATE
`;

    const result = buildScoutPrompt('Test', taskContextWithoutUser, skillContent);

    expect(result).toContain('User ID: N/A');
  });

  it('should use fallback template when skillContent is not provided', () => {
    const result = buildScoutPrompt('Test prompt', mockTaskContext);

    expect(result).toContain('om_msg789');
    expect(result).toContain('/workspace/tasks/om_msg789');
    expect(result).toContain('oc_test123');
    expect(result).toContain('Test prompt');
  });

  it('should return userPrompt when taskContext is missing', () => {
    const result = buildScoutPrompt('Just the prompt', null as unknown as TaskContext);

    expect(result).toBe('Just the prompt');
  });

  it('should handle empty userPrompt', () => {
    const skillContent = `## Prompt Template

~~~PROMPT_TEMPLATE
Prompt: {userPrompt}
~~~PROMPT_TEMPLATE
`;

    const result = buildScoutPrompt('', mockTaskContext, skillContent);

    expect(result).toContain('Prompt: ');
  });
});

describe('extractPromptTemplate', () => {
  it('should extract template from skill file with PROMPT_TEMPLATE delimiters', () => {
    const skillContent = `# Scout Skill

## Prompt Template

~~~PROMPT_TEMPLATE
This is the template.
Message ID: {messageId}
~~~PROMPT_TEMPLATE
`;

    const result = extractPromptTemplate(skillContent);

    expect(result).toContain('This is the template.');
    expect(result).toContain('Message ID: {messageId}');
  });

  it('should extract template with multiple placeholders', () => {
    const skillContent = `## Prompt Template

~~~PROMPT_TEMPLATE
Context:
- Message: {messageId}
- Task: {taskPath}
- Chat: {chatId}
- User: {userId (if available)}
- Request: {userPrompt}
~~~PROMPT_TEMPLATE
`;

    const result = extractPromptTemplate(skillContent);

    expect(result).toContain('Message: {messageId}');
    expect(result).toContain('Task: {taskPath}');
    expect(result).toContain('Chat: {chatId}');
    expect(result).toContain('User: {userId (if available)}');
    expect(result).toContain('Request: {userPrompt}');
  });

  it('should handle multiline template content', () => {
    const skillContent = `## Prompt Template

~~~PROMPT_TEMPLATE
Line 1
Line 2
Line 3
~~~PROMPT_TEMPLATE
`;

    const result = extractPromptTemplate(skillContent);

    expect(result.trim()).toBe('Line 1\nLine 2\nLine 3');
  });

  it('should return fallback when skillContent is not provided', () => {
    const result = extractPromptTemplate();

    expect(result).toContain('## Task Context');
    expect(result).toContain('## Your Instruction');
  });

  it('should return fallback when Prompt Template section is missing', () => {
    const skillContent = `# Some Skill

## Some Other Section

Content here.
`;

    const result = extractPromptTemplate(skillContent);

    expect(result).toContain('## Task Context');
  });

  it('should return fallback when PROMPT_TEMPLATE delimiters are missing', () => {
    const skillContent = `## Prompt Template

Some content without delimiters.
`;

    const result = extractPromptTemplate(skillContent);

    expect(result).toContain('## Task Context');
  });

  it('should handle template with special characters', () => {
    const skillContent = `## Prompt Template

~~~PROMPT_TEMPLATE
**Bold text**
*Italic text*
\`\`\`code block\`\`\`
- List item
~~~PROMPT_TEMPLATE
`;

    const result = extractPromptTemplate(skillContent);

    expect(result).toContain('**Bold text**');
    expect(result).toContain('*Italic text*');
    expect(result).toContain('```code block```');
    expect(result).toContain('- List item');
  });

  it('should trim whitespace from extracted template', () => {
    const skillContent = `## Prompt Template

~~~PROMPT_TEMPLATE

   Template with spaces

~~~
PROMPT_TEMPLATE
`;

    const result = extractPromptTemplate(skillContent);

    expect(result).not.match(/^\s+/);
    expect(result).not.match(/\s+$/);
  });
});

describe('getFallbackTemplate', () => {
  it('should return a complete fallback template', () => {
    const result = getFallbackTemplate();

    expect(result).toContain('## Task Context');
    expect(result).toContain('## User Request');
    expect(result).toContain('## Your Instruction');
    expect(result).toContain('{messageId}');
    expect(result).toContain('{taskPath}');
    expect(result).toContain('{chatId}');
    expect(result).toContain('{userId (if available)}');
    expect(result).toContain('{userPrompt}');
  });

  it('should contain placeholders for all required fields', () => {
    const result = getFallbackTemplate();

    expect(result).toContain('{messageId}');
    expect(result).toContain('{taskPath}');
    expect(result).toContain('{chatId}');
    expect(result).toContain('{userId (if available)}');
    expect(result).toContain('{userPrompt}');
  });

  it('should include workflow instructions', () => {
    const result = getFallbackTemplate();

    expect(result).toContain('task initialization specialist');
    expect(result).toContain('Explore first');
    expect(result).toContain('Create Task.md');
  });
});
