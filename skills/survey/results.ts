#!/usr/bin/env tsx
/**
 * survey/results.ts — Display aggregated survey results.
 *
 * Environment variables:
 *   SURVEY_ID  (required) Survey identifier
 *
 * Exit codes:
 *   0 — success
 *   1 — validation error
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  validateSurveyId,
  parseSurveyFile,
  SURVEY_DIR,
  ValidationError,
  type SurveyFile,
  type SurveyQuestion,
} from './schema.js';

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

function aggregateChoiceResults(
  question: SurveyQuestion,
  responses: SurveyFile['responses'],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const option of question.options ?? []) {
    counts[option] = 0;
  }

  for (const response of responses) {
    const answer = response.answers[question.id];
    if (answer === undefined) continue;

    if (question.type === 'single_choice') {
      const str = answer as string;
      if (counts[str] !== undefined) {
        counts[str]++;
      }
    } else if (question.type === 'multiple_choice') {
      const arr = answer as string[];
      for (const item of arr) {
        if (counts[item] !== undefined) {
          counts[item]++;
        }
      }
    }
  }

  return counts;
}

function formatResults(survey: SurveyFile): string {
  const lines: string[] = [];
  const totalResponses = survey.responses.length;
  const totalTargets = survey.targetUsers.length;

  lines.push(`📊 Survey: ${survey.title}`);
  if (survey.description) {
    lines.push(`   ${survey.description}`);
  }
  lines.push(`   Status: ${survey.status} | Responses: ${totalResponses}/${totalTargets}`);
  lines.push(`   Created: ${survey.createdAt} | Expires: ${survey.expiresAt}`);
  lines.push('');

  for (const question of survey.questions) {
    lines.push(`📝 ${question.text} (${question.type === 'single_choice' ? '单选' : question.type === 'multiple_choice' ? '多选' : '文本'})`);
    lines.push('─'.repeat(40));

    if (question.type === 'single_choice' || question.type === 'multiple_choice') {
      const counts = aggregateChoiceResults(question, survey.responses);
      const maxCount = Math.max(...Object.values(counts), 1);

      for (const [option, count] of Object.entries(counts)) {
        const bar = '█'.repeat(Math.round((count / maxCount) * 20));
        const pct = totalResponses > 0 ? ((count / totalResponses) * 100).toFixed(1) : '0.0';
        lines.push(`   ${option.padEnd(15)} ${bar} ${count} (${pct}%)`);
      }
    } else {
      // Text answers
      const textAnswers = survey.responses
        .map((r) => r.answers[question.id])
        .filter((a): a is string => typeof a === 'string');

      if (textAnswers.length === 0) {
        lines.push('   (no text responses)');
      } else {
        for (const answer of textAnswers) {
          if (survey.anonymous) {
            lines.push(`   • ${answer}`);
          } else {
            const responder = survey.responses.find(
              (r) => r.answers[question.id] === answer,
            );
            lines.push(`   • ${answer} — ${responder?.responder ?? 'anonymous'}`);
          }
        }
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

async function main() {
  const surveyId = process.env.SURVEY_ID;
  try {
    validateSurveyId(surveyId ?? '');
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }

  const surveyDir = resolve(SURVEY_DIR);
  const surveyFile = resolve(surveyDir, `${surveyId}.json`);

  // Path traversal protection
  if (!surveyFile.startsWith(surveyDir + '/')) {
    exit(`Path traversal detected for survey ID '${surveyId}'`);
  }

  let data: string;
  try {
    data = await readFile(surveyFile, 'utf-8');
  } catch (err: unknown) {
    const nodeErr = err as { code?: string };
    if (nodeErr.code === 'ENOENT') {
      exit(`Survey ${surveyId} not found`);
    }
    exit(`Failed to read survey file: ${err}`);
  }

  let survey: SurveyFile;
  try {
    survey = parseSurveyFile(data, surveyFile);
  } catch (err) {
    exit(err instanceof ValidationError ? err.message : String(err));
  }

  // Output results as JSON for programmatic use
  const output = {
    survey: {
      id: survey.id,
      title: survey.title,
      description: survey.description,
      status: survey.status,
      createdAt: survey.createdAt,
      expiresAt: survey.expiresAt,
      anonymous: survey.anonymous,
      totalTargets: survey.targetUsers.length,
      totalResponses: survey.responses.length,
      responseRate: survey.targetUsers.length > 0
        ? ((survey.responses.length / survey.targetUsers.length) * 100).toFixed(1) + '%'
        : 'N/A',
    },
    questions: survey.questions.map((q) => {
      const result: Record<string, unknown> = {
        id: q.id,
        type: q.type,
        text: q.text,
      };

      if (q.type === 'single_choice' || q.type === 'multiple_choice') {
        result.aggregated = aggregateChoiceResults(q, survey.responses);
      } else {
        result.answers = survey.responses
          .map((r) => r.answers[q.id])
          .filter((a): a is string => typeof a === 'string');
      }

      return result;
    }),
  };

  // Output both JSON and human-readable format
  console.log(JSON.stringify(output, null, 2));
  console.log('\n---\n');
  console.log(formatResults(survey));
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
