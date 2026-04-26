#!/usr/bin/env tsx
/**
 * survey/results.ts — Aggregate and display survey results.
 *
 * Environment variables:
 *   SURVEY_ID (required) Survey identifier
 *
 * Output: JSON with aggregated results per question.
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

interface ChoiceAggregation {
  questionId: string;
  questionText: string;
  type: 'single_choice' | 'multiple_choice';
  totalResponses: number;
  optionCounts: Record<string, number>;
}

interface TextAggregation {
  questionId: string;
  questionText: string;
  type: 'text';
  totalResponses: number;
  answers: Array<{ responder: string; answer: string }>;
}

type QuestionAggregation = ChoiceAggregation | TextAggregation;

function aggregateQuestion(
  question: SurveyQuestion,
  responses: SurveyFile['responses'],
  anonymous: boolean,
): QuestionAggregation {
  const responseEntries = Object.values(responses);

  if (question.type === 'single_choice' || question.type === 'multiple_choice') {
    const optionCounts: Record<string, number> = {};
    for (const option of question.options ?? []) {
      optionCounts[option] = 0;
    }

    for (const resp of responseEntries) {
      const answer = resp.answers[question.id];
      if (question.type === 'single_choice' && typeof answer === 'string') {
        if (optionCounts[answer] !== undefined) {
          optionCounts[answer]++;
        }
      } else if (question.type === 'multiple_choice' && Array.isArray(answer)) {
        for (const item of answer) {
          if (typeof item === 'string' && optionCounts[item] !== undefined) {
            optionCounts[item]++;
          }
        }
      }
    }

    return {
      questionId: question.id,
      questionText: question.text,
      type: question.type,
      totalResponses: responseEntries.length,
      optionCounts,
    };
  }

  // text type
  const answers: Array<{ responder: string; answer: string }> = [];
  for (const resp of responseEntries) {
    const answer = resp.answers[question.id];
    if (typeof answer === 'string') {
      answers.push({
        responder: anonymous ? 'anonymous' : resp.responder,
        answer,
      });
    }
  }

  return {
    questionId: question.id,
    questionText: question.text,
    type: 'text',
    totalResponses: responseEntries.length,
    answers,
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

  let survey: SurveyFile;
  try {
    const content = await readFile(surveyFile, 'utf-8');
    survey = parseSurveyFile(content, surveyFile);
  } catch (err) {
    if (err instanceof ValidationError) {
      exit(err.message);
    }
    exit(`Survey '${surveyId}' not found`);
  }

  const responseCount = Object.keys(survey.responses).length;
  const targetCount = survey.targetUsers.length;

  const results = {
    id: survey.id,
    title: survey.title,
    description: survey.description,
    status: survey.status,
    anonymous: survey.anonymous,
    totalResponses: responseCount,
    totalTargets: targetCount,
    responseRate: targetCount > 0 ? `${Math.round((responseCount / targetCount) * 100)}%` : '0%',
    questions: survey.questions.map((q) => aggregateQuestion(q, survey.responses, survey.anonymous)),
  };

  console.log(JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
