#!/usr/bin/env tsx
/**
 * survey/results.ts — Aggregate and display survey results.
 *
 * Environment variables:
 *   SURVEY_ID  (required) Survey identifier
 *
 * Output: JSON object with aggregated results per question.
 *
 * Exit codes:
 *   0 — success
 *   1 — error
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

interface ChoiceResult {
  option: string;
  count: number;
  percentage: number;
}

interface TextResult {
  responses: string[];
}

interface QuestionResult {
  questionId: string;
  questionText: string;
  questionType: string;
  totalResponses: number;
  choiceResults?: ChoiceResult[];
  textResults?: TextResult[];
}

interface SurveyResults {
  surveyId: string;
  title: string;
  status: string;
  deadline: string;
  totalTargetUsers: number;
  totalResponses: number;
  responseRate: number;
  questions: QuestionResult[];
}

function aggregateChoiceQuestion(
  question: SurveyQuestion,
  responses: Record<string, { answers: Record<string, string | string[]> }>,
): QuestionResult {
  const counts: Record<string, number> = {};
  for (const opt of question.options ?? []) {
    counts[opt] = 0;
  }

  let totalResponses = 0;

  for (const response of Object.values(responses)) {
    const answer = response.answers[question.id];
    if (answer === undefined) continue;
    totalResponses++;

    if (question.type === 'single_choice') {
      if (typeof answer === 'string' && counts[answer] !== undefined) {
        counts[answer]++;
      }
    } else if (question.type === 'multiple_choice') {
      if (Array.isArray(answer)) {
        for (const item of answer) {
          if (typeof item === 'string' && counts[item] !== undefined) {
            counts[item]++;
          }
        }
      }
    }
  }

  const choiceResults: ChoiceResult[] = Object.entries(counts).map(([option, count]) => ({
    option,
    count,
    percentage: totalResponses > 0 ? Math.round((count / totalResponses) * 100) : 0,
  }));

  return {
    questionId: question.id,
    questionText: question.text,
    questionType: question.type,
    totalResponses,
    choiceResults,
  };
}

function aggregateTextQuestion(
  question: SurveyQuestion,
  responses: Record<string, { answers: Record<string, string | string[]> }>,
): QuestionResult {
  const textResults: string[] = [];

  for (const response of Object.values(responses)) {
    const answer = response.answers[question.id];
    if (answer !== undefined && typeof answer === 'string' && answer.trim()) {
      textResults.push(answer);
    }
  }

  return {
    questionId: question.id,
    questionText: question.text,
    questionType: question.type,
    totalResponses: textResults.length,
    textResults,
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

  let data: string;
  try {
    data = await readFile(surveyFile, 'utf-8');
  } catch (err: unknown) {
    const nodeErr = err as { code?: string };
    if (nodeErr.code === 'ENOENT') {
      exit(`Survey ${surveyId} not found`);
    }
    throw err;
  }

  const survey: SurveyFile = parseSurveyFile(data, surveyFile);
  const totalResponses = Object.keys(survey.responses).length;
  const responseRate = survey.targetUsers.length > 0
    ? Math.round((totalResponses / survey.targetUsers.length) * 100)
    : 0;

  // Check for unanswered users
  const answeredUsers = new Set(Object.keys(survey.responses));
  const unansweredUsers = survey.targetUsers.filter((u) => !answeredUsers.has(u));

  // Anonymize responses if needed
  const responsesForAggregation: Record<string, { answers: Record<string, string | string[]> }> = {};
  if (survey.anonymous) {
    let idx = 0;
    for (const [_userId, response] of Object.entries(survey.responses)) {
      responsesForAggregation[`anonymous_${idx++}`] = response;
    }
  } else {
    for (const [userId, response] of Object.entries(survey.responses)) {
      responsesForAggregation[userId] = response;
    }
  }

  // Aggregate results per question
  const questionResults: QuestionResult[] = survey.questions.map((q) => {
    if (q.type === 'text') {
      return aggregateTextQuestion(q, responsesForAggregation);
    }
    return aggregateChoiceQuestion(q, responsesForAggregation);
  });

  const results: SurveyResults & { unansweredUsers?: string[] } = {
    surveyId: survey.id,
    title: survey.title,
    status: survey.status,
    deadline: survey.deadline,
    totalTargetUsers: survey.targetUsers.length,
    totalResponses,
    responseRate,
    questions: questionResults,
  };

  // Only include unanswered users list if not anonymous
  if (!survey.anonymous) {
    results.unansweredUsers = unansweredUsers;
  }

  console.log(JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
