/**
 * Task planner - breaks down user requests into subtasks.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { LongTaskPlan } from './types.js';
import { createAgentSdkOptions, parseSDKMessage } from '../utils/sdk.js';

/**
 * Task planner for decomposing complex tasks.
 */
export class TaskPlanner {
  private readonly apiKey: string;
  private readonly model: string;

  constructor(apiKey: string, model: string) {
    this.apiKey = apiKey;
    this.model = model;
  }

  /**
   * Generate a unique task ID.
   */
  private generateTaskId(): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    return `long-task-${timestamp}-${random}`;
  }

  /**
   * Create task planning prompt.
   */
  private createPlanningPrompt(userRequest: string): string {
    return `You are a task planning expert. Your job is to break down complex user requests into a linear sequence of subtasks.

## Your Role

Analyze the user's request and create a detailed execution plan with clear, sequential subtasks. Each subtask must:
1. Have a well-defined input (from previous step or user context)
2. Produce specific outputs (at minimum a markdown summary document)
3. Be independently executable by a fresh agent with context isolation
4. Have clear success criteria

## Response Format

You MUST respond with a valid JSON object (no markdown, no code blocks, just the JSON):

{
  "title": "Short descriptive title",
  "description": "Brief overview of what this task accomplishes",
  "subtasks": [
    {
      "sequence": 1,
      "title": "Subtask title",
      "description": "Detailed instructions for this subtask",
      "inputs": {
        "description": "What inputs this subtask receives",
        "sources": ["file paths or data sources from previous steps (can use #section to reference specific markdown sections)"],
        "context": {}
      },
      "outputs": {
        "description": "What this subtask produces",
        "files": ["list of expected output files"],
        "summaryFile": "path/to/summary.md",
        "markdownRequirements": [
          {
            "id": "findings",
            "title": "Key Findings",
            "content": "Summary of the main discoveries or results",
            "required": true
          },
          {
            "id": "recommendations",
            "title": "Recommendations",
            "content": "Actionable recommendations based on findings",
            "required": true
          }
        ]
      },
      "complexity": "medium"
    }
  ]
}

## Important Guidelines

1. **Linear Flow**: Subtasks must be sequential (each depends only on previous steps)
2. **Context Isolation**: Each subtask should be executable by a fresh agent with only the provided inputs
3. **Persistence**: Every subtask MUST produce a markdown summary file with explicit structure requirements
4. **Clear Inputs/Outputs**: Explicitly state what each subtask consumes and produces
5. **Markdown Requirements**: CRITICAL - Each subtask's \`markdownRequirements\` must specify:
   - The exact sections the summary markdown must contain
   - Each section must have an \`id\` that can be referenced by subsequent steps
   - Each section must have clear content requirements
   - Mark sections as \`required: true\` or \`required: false\`
6. **Inter-Step Dependencies**: Ensure each step's markdown output contains everything the next step needs:
   - Use \`sources\` in inputs to reference previous summary files: \`"subtask-1/summary.md#findings"\`
   - The \`#\` notation allows referencing specific markdown sections by their \`id\`
   - Make markdown requirements detailed enough that next steps have all necessary context
7. **Reasonable Granularity**: Break down into 3-8 subtasks (not too granular, not too coarse)
8. **File Paths**: Use relative paths like \`subtask-1/summary.md\`, \`subtask-2/results.json\`

### Markdown Requirements Example

For a research task that feeds into an analysis task:

**Step 1 (Research)** outputs:
\`\`\`json
"markdownRequirements": [
  {
    "id": "data-gathered",
    "title": "Data Collected",
    "content": "List of all data sources and key data points",
    "required": true
  },
  {
    "id": "initial-insights",
    "title": "Initial Observations",
    "content": "Preliminary patterns or anomalies noticed",
    "required": true
  }
]
\`\`\`

**Step 2 (Analysis)** inputs:
\`\`\`json
"inputs": {
  "sources": [
    "subtask-1/summary.md#data-gathered",
    "subtask-1/summary.md#initial-insights"
  ]
}
\`\`\`

This ensures step 2 can reference specific sections from step 1's output.

## User Request

${userRequest}

Now, analyze this request and respond with ONLY the JSON plan (no explanation, no markdown formatting).`;
  }

  /**
   * Plan a long task by breaking it into subtasks.
   */
  async planTask(userRequest: string, agentOptions?: { model?: string; apiBaseUrl?: string }): Promise<LongTaskPlan> {
    const taskId = this.generateTaskId();

    // Create SDK options using shared utility
    const sdkOptions = createAgentSdkOptions({
      apiKey: this.apiKey,
      model: agentOptions?.model || this.model,
      apiBaseUrl: agentOptions?.apiBaseUrl,
      cwd: process.cwd(),
      permissionMode: 'bypassPermissions',
    });

    try {
      // Query planning agent
      const queryResult = query({
        prompt: this.createPlanningPrompt(userRequest),
        options: sdkOptions,
      });

      // Collect response
      let fullResponse = '';
      for await (const message of queryResult) {
        const parsed = parseSDKMessage(message);
        if (parsed.content) {
          fullResponse += parsed.content;
        }
      }

      // Extract JSON from response
      const planData = this.extractPlanFromResponse(fullResponse);

      // Create plan object
      const plan: LongTaskPlan = {
        taskId,
        originalRequest: userRequest,
        title: planData.title || 'Untitled Task',
        description: planData.description || userRequest,
        subtasks: planData.subtasks || [],
        totalSteps: planData.subtasks?.length || 0,
        createdAt: new Date().toISOString(),
      };

      // Validate plan
      this.validatePlan(plan);

      return plan;
    } catch (error) {
      throw new Error(`Task planning failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Extract JSON plan from agent response.
   * Handles cases where agent wraps JSON in markdown or adds explanatory text.
   */
  private extractPlanFromResponse(response: string): any {
    let cleaned = response.trim();

    // Remove markdown code blocks if present
    const jsonCodeBlockMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (jsonCodeBlockMatch) {
      const [, extracted] = jsonCodeBlockMatch;
      cleaned = extracted;
    }

    // Try to find JSON object boundaries
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');

    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      cleaned = cleaned.substring(firstBrace, lastBrace + 1);
    }

    try {
      return JSON.parse(cleaned);
    } catch (error) {
      throw new Error(`Failed to parse plan JSON: ${error instanceof Error ? error.message : String(error)}\n\nExtracted content:\n${cleaned}`);
    }
  }

  /**
   * Validate that the plan meets requirements.
   */
  private validatePlan(plan: LongTaskPlan): void {
    if (!plan.title || plan.title.trim() === '') {
      throw new Error('Plan must have a title');
    }

    if (!plan.subtasks || plan.subtasks.length === 0) {
      throw new Error('Plan must have at least one subtask');
    }

    if (plan.subtasks.length > 10) {
      throw new Error(`Plan should have at most 10 subtasks (current: ${  plan.subtasks.length  })`);
    }

    // Validate each subtask
    for (let i = 0; i < plan.subtasks.length; i++) {
      const subtask = plan.subtasks[i];

      if (subtask.sequence !== i + 1) {
        throw new Error(`Subtask ${i + 1} has incorrect sequence number: ${subtask.sequence}`);
      }

      if (!subtask.title || subtask.title.trim() === '') {
        throw new Error(`Subtask ${i + 1} must have a title`);
      }

      if (!subtask.description || subtask.description.trim() === '') {
        throw new Error(`Subtask ${i + 1} must have a description`);
      }

      if (!subtask.inputs || !subtask.outputs) {
        throw new Error(`Subtask ${i + 1} must have inputs and outputs`);
      }

      if (!subtask.outputs.summaryFile) {
        throw new Error(`Subtask ${i + 1} must specify a summaryFile in outputs`);
      }

      // Validate markdown requirements if present
      if (subtask.outputs.markdownRequirements) {
        for (let j = 0; j < subtask.outputs.markdownRequirements.length; j++) {
          const req = subtask.outputs.markdownRequirements[j];

          if (!req.id || req.id.trim() === '') {
            throw new Error(`Subtask ${i + 1} markdown requirement ${j + 1} must have an id`);
          }

          if (!req.title || req.title.trim() === '') {
            throw new Error(`Subtask ${i + 1} markdown requirement ${j + 1} must have a title`);
          }

          if (!req.content || req.content.trim() === '') {
            throw new Error(`Subtask ${i + 1} markdown requirement ${j + 1} must have content description`);
          }

          if (typeof req.required !== 'boolean') {
            throw new Error(`Subtask ${i + 1} markdown requirement ${j + 1} must specify required as boolean`);
          }

          // Check for duplicate IDs
          const duplicateCount = subtask.outputs.markdownRequirements!.filter(r => r.id === req.id).length;
          if (duplicateCount > 1) {
            throw new Error(`Subtask ${i + 1} has duplicate markdown requirement id: ${req.id}`);
          }
        }
      }
    }

    // Validate inter-step references point to valid sections
    this.validateInterStepReferences(plan);
  }

  /**
   * Validate that cross-step references are valid.
   */
  private validateInterStepReferences(plan: LongTaskPlan): void {
    for (let i = 0; i < plan.subtasks.length; i++) {
      const subtask = plan.subtasks[i];

      // Check if sources reference previous steps
      if (subtask.inputs.sources) {
        for (const source of subtask.inputs.sources) {
          // Match pattern like "subtask-1/summary.md#section-id"
          const match = source.match(/^subtask-(\d+)\/[^#]+(?:#(.+))?$/);
          if (match) {
            const [, stepStr, sectionId] = match;
            const sourceStep = parseInt(stepStr, 10);

            // Check that source step exists and is before current step
            if (sourceStep >= subtask.sequence) {
              throw new Error(`Subtask ${i + 1} references future or current step ${sourceStep} in sources`);
            }

            // If section reference exists, validate it's defined in the source step
            if (sectionId) {
              const sourceSubtask = plan.subtasks[sourceStep - 1];
              if (sourceSubtask.outputs.markdownRequirements) {
                const hasSection = sourceSubtask.outputs.markdownRequirements.some(r => r.id === sectionId);
                if (!hasSection) {
                  throw new Error(`Subtask ${i + 1} references undefined section '${sectionId}' from step ${sourceStep}`);
                }
              } else {
                throw new Error(`Subtask ${i + 1} references section '${sectionId}' from step ${sourceStep}, but that step has no markdown requirements defined`);
              }
            }
          }
        }
      }
    }
  }
}
