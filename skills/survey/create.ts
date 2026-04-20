#!/usr/bin/env npx tsx
/**
 * Create a new survey.
 *
 * Reads survey parameters from environment variables and writes a JSON file
 * to `workspace/surveys/{surveyId}.json`.
 *
 * Environment variables:
 *   SURVEY_ID       - Unique identifier (required)
 *   SURVEY_TITLE    - Survey title (required)
 *   SURVEY_DESC     - Optional description
 *   SURVEY_ANONYMOUS- "true" / "false" (default: "false")
 *   SURVEY_DEADLINE - Optional ISO 8601 deadline
 *   SURVEY_TARGETS  - JSON array of open_id strings (required)
 *   SURVEY_QUESTIONS- JSON array of question objects (required)
 *
 * @module skills/survey/create
 */

import { existsSync } from 'fs';
import { writeFile, rename } from 'fs/promises';
import { join } from 'path';
import { getSurveyPath, isValidSurveyId, validateSurvey, type Survey, type SurveyQuestion } from './schema.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getEnv(name: string): string | undefined {
  return process.env[name];
}

function requireEnv(name: string): string {
  const value = getEnv(name);
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function parseJsonEnv<T>(name: string): T {
  const raw = requireEnv(name);
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`Invalid JSON in environment variable ${name}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const id = requireEnv('SURVEY_ID');
  const title = requireEnv('SURVEY_TITLE');
  const description = getEnv('SURVEY_DESC');
  const anonymousStr = getEnv('SURVEY_ANONYMOUS') ?? 'false';
  const anonymous = anonymousStr === 'true';
  const deadline = getEnv('SURVEY_DEADLINE') || undefined;
  const targets = parseJsonEnv<string[]>('SURVEY_TARGETS');
  const questions = parseJsonEnv<SurveyQuestion[]>('SURVEY_QUESTIONS');

  // Validate survey ID
  if (!isValidSurveyId(id)) {
    throw new Error(`Invalid survey ID: "${id}". Must match /^[a-zA-Z0-9_-]+$/ (no leading dots).`);
  }

  // Check uniqueness
  const filePath = getSurveyPath(id);
  if (existsSync(filePath)) {
    throw new Error(`Survey "${id}" already exists at ${filePath}`);
  }

  // Validate deadline format
  if (deadline && isNaN(Date.parse(deadline))) {
    throw new Error(`Invalid deadline format: "${deadline}". Must be ISO 8601.`);
  }

  // Build survey object
  const survey: Survey = {
    id,
    title,
    description: description || undefined,
    status: 'draft',
    anonymous,
    questions,
    createdAt: new Date().toISOString(),
    deadline,
    targetUsers: targets,
    responses: [],
  };

  // Validate
  const validationError = validateSurvey(survey);
  if (validationError) {
    throw new Error(`Survey validation failed: ${validationError}`);
  }

  // Atomic write: write to temp file, then rename
  const tmpPath = filePath + '.tmp';
  await writeFile(tmpPath, JSON.stringify(survey, null, 2), 'utf-8');
  await rename(tmpPath, filePath);

  // Output result
  console.log(JSON.stringify({
    success: true,
    surveyId: id,
    filePath,
    message: `Survey "${title}" created successfully (${questions.length} question(s), ${targets.length} target user(s))`,
  }));
}

main().catch((err: Error) => {
  console.error(JSON.stringify({
    success: false,
    error: err.message,
  }));
  process.exit(1);
});
