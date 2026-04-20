#!/usr/bin/env npx tsx
/**
 * Activate or close a survey.
 *
 * Environment variables:
 *   SURVEY_ID     - Survey identifier (required)
 *   SURVEY_ACTION - "activate" or "close" (required)
 *
 * @module skills/survey/activate
 */

import { readFile, writeFile, rename } from 'fs/promises';
import { existsSync } from 'fs';
import { getSurveyPath, type Survey, type SurveyStatus } from './schema.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

const VALID_ACTIONS = new Set(['activate', 'close']);
const ACTION_STATUS_MAP: Record<string, SurveyStatus> = {
  activate: 'active',
  close: 'closed',
};

async function main(): Promise<void> {
  const surveyId = requireEnv('SURVEY_ID');
  const action = requireEnv('SURVEY_ACTION');

  if (!VALID_ACTIONS.has(action)) {
    throw new Error(`Invalid action: "${action}". Must be one of: ${[...VALID_ACTIONS].join(', ')}`);
  }

  const filePath = getSurveyPath(surveyId);

  if (!existsSync(filePath)) {
    throw new Error(`Survey "${surveyId}" not found`);
  }

  const raw = await readFile(filePath, 'utf-8');
  const survey: Survey = JSON.parse(raw);

  const newStatus = ACTION_STATUS_MAP[action];

  // Validate transition
  if (action === 'activate' && survey.status !== 'draft') {
    throw new Error(`Cannot activate survey "${surveyId}" (current status: ${survey.status}). Only draft surveys can be activated.`);
  }

  if (action === 'close' && survey.status !== 'active') {
    throw new Error(`Cannot close survey "${surveyId}" (current status: ${survey.status}). Only active surveys can be closed.`);
  }

  survey.status = newStatus;

  // Atomic write
  const tmpPath = filePath + '.tmp';
  await writeFile(tmpPath, JSON.stringify(survey, null, 2), 'utf-8');
  await rename(tmpPath, filePath);

  console.log(JSON.stringify({
    success: true,
    surveyId,
    previousStatus: survey.status === 'active' ? 'draft' : 'active',
    newStatus,
    message: `Survey "${surveyId}" is now ${newStatus}`,
  }));
}

main().catch((err: Error) => {
  console.error(JSON.stringify({
    success: false,
    error: err.message,
  }));
  process.exit(1);
});
