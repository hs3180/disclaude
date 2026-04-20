#!/usr/bin/env npx tsx
/**
 * Submit a response to an active survey.
 *
 * Records a user's answer to one or all questions. Enforces:
 * - Survey must be active
 * - User must be in targetUsers list
 * - One response per user (idempotent: overwrites if already submitted)
 * - Deadline must not have passed
 *
 * Environment variables:
 *   SURVEY_ID      - Survey identifier (required)
 *   SURVEY_RESPONDER- User's open_id (required)
 *   SURVEY_ANSWERS  - JSON array of { questionId, value } objects (required)
 *
 * @module skills/survey/submit
 */

import { readFile, writeFile, rename } from 'fs/promises';
import { existsSync } from 'fs';
import { getSurveyPath, type Survey, type UserResponse, type SurveyResponse } from './schema.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const surveyId = requireEnv('SURVEY_ID');
  const responder = requireEnv('SURVEY_RESPONDER');
  const answersRaw = requireEnv('SURVEY_ANSWERS');

  let answers: SurveyResponse[];
  try {
    answers = JSON.parse(answersRaw) as SurveyResponse[];
  } catch {
    throw new Error('Invalid JSON in SURVEY_ANSWERS');
  }

  const filePath = getSurveyPath(surveyId);

  if (!existsSync(filePath)) {
    throw new Error(`Survey "${surveyId}" not found`);
  }

  // Read survey
  const raw = await readFile(filePath, 'utf-8');
  const survey: Survey = JSON.parse(raw);

  // Validate status
  if (survey.status !== 'active') {
    throw new Error(`Survey "${surveyId}" is not active (current status: ${survey.status})`);
  }

  // Validate deadline
  if (survey.deadline) {
    const deadlineTime = new Date(survey.deadline).getTime();
    if (Date.now() > deadlineTime) {
      throw new Error(`Survey "${surveyId}" deadline has passed (${survey.deadline})`);
    }
  }

  // Validate responder is in target users
  if (!survey.targetUsers.includes(responder)) {
    throw new Error(`User "${responder}" is not a target user for survey "${surveyId}"`);
  }

  // Validate answers reference valid question IDs
  const questionIds = new Set(survey.questions.map(q => q.id));
  for (const answer of answers) {
    if (!questionIds.has(answer.questionId)) {
      throw new Error(`Unknown question ID: "${answer.questionId}"`);
    }
  }

  // Build user response
  const userResponse: UserResponse = {
    responder,
    repliedAt: new Date().toISOString(),
    answers,
  };

  // Replace existing response from same user, or append
  const existingIndex = survey.responses.findIndex(r => r.responder === responder);
  if (existingIndex >= 0) {
    survey.responses[existingIndex] = userResponse;
  } else {
    survey.responses.push(userResponse);
  }

  // Atomic write
  const tmpPath = filePath + '.tmp';
  await writeFile(tmpPath, JSON.stringify(survey, null, 2), 'utf-8');
  await rename(tmpPath, filePath);

  // Check if all target users have responded
  const respondedUsers = new Set(survey.responses.map(r => r.responder));
  const allResponded = survey.targetUsers.every(u => respondedUsers.has(u));
  const progress = `${survey.responses.length}/${survey.targetUsers.length}`;

  console.log(JSON.stringify({
    success: true,
    surveyId,
    progress,
    allResponded,
    message: `Response recorded for user "${responder}". Progress: ${progress}${allResponded ? ' — All users have responded!' : ''}`,
  }));
}

main().catch((err: Error) => {
  console.error(JSON.stringify({
    success: false,
    error: err.message,
  }));
  process.exit(1);
});
