#!/usr/bin/env tsx
/**
 * survey/results.ts — Aggregate and display results for a survey.
 *
 * Reads the survey file and produces a JSON summary of aggregated results.
 * For choice questions: counts per option with percentages.
 * For open_text questions: lists all text responses.
 *
 * Environment variables:
 *   SURVEY_ID (required) Survey identifier
 *
 * Exit codes:
 *   0 — success (results JSON printed to stdout)
 *   1 — validation error or survey not found
 */

import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  validateSurveyId,
  parseSurveyFile,
  SURVEY_DIR,
  ValidationError,
  type SurveyFile,
  type SurveyQuestion,
} from './schema.js';
import { withSharedLock } from './lock.js';

function exit(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

interface ChoiceResult {
  questionId: string;
  questionText: string;
  type: 'single_choice' | 'multiple_choice';
  totalResponses: number;
  options: Array<{
    label: string;
    count: number;
    percentage: number;
  }>;
}

interface TextResult {
  questionId: string;
  questionText: string;
  type: 'open_text';
  totalResponses: number;
  responses: Array<{ userId: string; text: string }>;
}

type QuestionResult = ChoiceResult | TextResult;

interface SurveyResults {
  surveyId: string;
  title: string;
  status: string;
  totalTargetUsers: number;
  totalResponses: number;
  responseRate: number;
  expiresAt: string;
  questions: QuestionResult[];
}

function aggregateResults(survey: SurveyFile): SurveyResults {
  const totalTargetUsers = survey.targetUsers.length;
  const totalResponses = Object.keys(survey.responses).length;
  const responseRate = totalTargetUsers > 0
    ? Math.round((totalResponses / totalTargetUsers) * 100)
    : 0;

  const questionResults: QuestionResult[] = survey.questions.map((q: SurveyQuestion) => {
    if (q.type === 'open_text') {
      const responses: Array<{ userId: string; text: string }> = [];
      for (const [userId, response] of Object.entries(survey.responses)) {
        const answer = response.answers[q.id];
        if (typeof answer === 'string') {
          responses.push({
            userId: survey.anonymous ? 'anonymous' : userId,
            text: answer,
          });
        }
      }
      return {
        questionId: q.id,
        questionText: q.text,
        type: 'open_text' as const,
        totalResponses: responses.length,
        responses,
      };
    }

    // Choice question (single or multiple)
    const optionCounts: Record<string, number> = {};
    if (q.options) {
      for (const opt of q.options) {
        optionCounts[opt] = 0;
      }
    }

    let answerCount = 0;
    for (const response of Object.values(survey.responses)) {
      const answer = response.answers[q.id];
      if (answer === undefined || answer === null) continue;

      answerCount++;
      if (Array.isArray(answer)) {
        for (const a of answer) {
          if (a in optionCounts) optionCounts[a]++;
        }
      } else if (typeof answer === 'string' && answer in optionCounts) {
        optionCounts[answer]++;
      }
    }

    const options = (q.options ?? []).map((opt) => ({
      label: opt,
      count: optionCounts[opt] ?? 0,
      percentage: answerCount > 0
        ? Math.round(((optionCounts[opt] ?? 0) / answerCount) * 100)
        : 0,
    }));

    return {
      questionId: q.id,
      questionText: q.text,
      type: q.type as 'single_choice' | 'multiple_choice',
      totalResponses: answerCount,
      options,
    };
  });

  return {
    surveyId: survey.id,
    title: survey.title,
    status: survey.status,
    totalTargetUsers,
    totalResponses,
    responseRate,
    expiresAt: survey.expiresAt,
    questions: questionResults,
  };
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

  // Check file exists
  try {
    await stat(surveyFile);
  } catch (err: unknown) {
    // @ts-expect-error - checking error code
    if (err?.code === 'ENOENT') {
      exit(`Survey ${surveyId} not found`);
    }
    exit(`Failed to access survey file: ${err}`);
  }

  // Read and aggregate under shared lock
  const lockPath = `${surveyFile}.lock`;
  await withSharedLock(lockPath, async () => {
    const content = await readFile(surveyFile, 'utf-8');
    const survey = parseSurveyFile(content, surveyFile);
    const results = aggregateResults(survey);
    process.stdout.write(JSON.stringify(results, null, 2) + '\n');
  });
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
