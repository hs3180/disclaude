#!/usr/bin/env node

/**
 * Survey store helper script.
 *
 * Manages survey state files in workspace/data/surveys/.
 * Used by the survey skill Agent via Bash.
 *
 * Usage:
 *   node survey-store.mjs create <surveyId> <question> <optionsJson> <chatId> <createdBy>
 *   node survey-store.mjs vote <surveyId> <userOpenId> <optionValue> <optionLabel>
 *   node survey-store.mjs results <surveyId>
 *   node survey-store.mjs close <surveyId>
 *   node survey-store.mjs list
 */

import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const SURVEYS_DIR = join(process.cwd(), 'workspace', 'data', 'surveys');

function ensureDir() {
  if (!existsSync(SURVEYS_DIR)) {
    mkdirSync(SURVEYS_DIR, { recursive: true });
  }
}

function surveyPath(id) {
  return join(SURVEYS_DIR, `${id}.json`);
}

function readSurvey(id) {
  const path = surveyPath(id);
  if (!existsSync(path)) {
    console.error(JSON.stringify({ error: 'NOT_FOUND', message: `Survey ${id} not found` }));
    process.exit(1);
  }
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function writeSurvey(survey) {
  ensureDir();
  writeFileSync(surveyPath(survey.id), JSON.stringify(survey, null, 2) + '\n');
}

// Commands

function cmdCreate(surveyId, question, optionsJson, chatId, createdBy) {
  let options;
  try {
    options = JSON.parse(optionsJson);
  } catch {
    console.error(JSON.stringify({ error: 'INVALID_OPTIONS', message: 'Options must be valid JSON array' }));
    process.exit(1);
  }

  if (!Array.isArray(options) || options.length === 0) {
    console.error(JSON.stringify({ error: 'INVALID_OPTIONS', message: 'Options must be a non-empty array' }));
    process.exit(1);
  }

  const survey = {
    id: surveyId,
    question,
    options: options.map((opt, i) => ({
      label: typeof opt === 'string' ? opt : opt.label,
      value: typeof opt === 'string' ? `opt_${String.fromCharCode(97 + i)}` : opt.value,
    })),
    createdBy,
    chatId,
    createdAt: new Date().toISOString(),
    closedAt: null,
    status: 'active',
    responses: {},
    anonymous: false,
    maxParticipants: null,
  };

  writeSurvey(survey);
  console.log(JSON.stringify({ success: true, survey }));
}

function cmdVote(surveyId, userOpenId, optionValue, optionLabel) {
  const survey = readSurvey(surveyId);

  if (survey.status === 'closed') {
    console.error(JSON.stringify({ error: 'SURVEY_CLOSED', message: 'This survey is closed' }));
    process.exit(1);
  }

  const isUpdate = !!survey.responses[userOpenId];

  survey.responses[userOpenId] = {
    option: optionValue,
    label: optionLabel,
    timestamp: new Date().toISOString(),
  };

  writeSurvey(survey);

  // Calculate summary - initialize all known option labels to 0
  const totalVotes = Object.keys(survey.responses).length;
  const optionCounts = {};
  for (const opt of survey.options) {
    optionCounts[opt.label] = 0;
  }
  for (const resp of Object.values(survey.responses)) {
    optionCounts[resp.label] = (optionCounts[resp.label] || 0) + 1;
  }

  console.log(JSON.stringify({
    success: true,
    isUpdate,
    totalVotes,
    optionCounts,
  }));
}

function cmdResults(surveyId) {
  const survey = readSurvey(surveyId);

  const totalVotes = Object.keys(survey.responses).length;
  const optionCounts = {};
  const optionPercentages = {};

  for (const opt of survey.options) {
    optionCounts[opt.label] = 0;
  }

  for (const resp of Object.values(survey.responses)) {
    optionCounts[resp.label] = (optionCounts[resp.label] || 0) + 1;
  }

  for (const [label, count] of Object.entries(optionCounts)) {
    optionPercentages[label] = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;
  }

  // Generate bar visualization
  const bars = {};
  for (const [label, pct] of Object.entries(optionPercentages)) {
    const filled = Math.round(pct / 10);
    bars[label] = '█'.repeat(filled) + '░'.repeat(10 - filled);
  }

  console.log(JSON.stringify({
    success: true,
    survey: {
      id: survey.id,
      question: survey.question,
      status: survey.status,
      createdAt: survey.createdAt,
      closedAt: survey.closedAt,
    },
    totalVotes,
    optionCounts,
    optionPercentages,
    bars,
  }));
}

function cmdClose(surveyId) {
  const survey = readSurvey(surveyId);

  if (survey.status === 'closed') {
    console.error(JSON.stringify({ error: 'ALREADY_CLOSED', message: 'Survey is already closed' }));
    process.exit(1);
  }

  survey.status = 'closed';
  survey.closedAt = new Date().toISOString();

  writeSurvey(survey);
  console.log(JSON.stringify({ success: true, closedAt: survey.closedAt }));
}

function cmdList() {
  ensureDir();
  const files = readdirSync(SURVEYS_DIR).filter(f => f.startsWith('survey-') && f.endsWith('.json'));

  const surveys = files.map(f => {
    try {
      const data = JSON.parse(readFileSync(join(SURVEYS_DIR, f), 'utf-8'));
      return {
        id: data.id,
        question: data.question,
        status: data.status,
        totalVotes: Object.keys(data.responses).length,
        createdAt: data.createdAt,
      };
    } catch {
      return null;
    }
  }).filter(Boolean);

  console.log(JSON.stringify({ success: true, surveys }));
}

// Main
const [,, command, ...args] = process.argv;

switch (command) {
  case 'create':
    cmdCreate(...args);
    break;
  case 'vote':
    cmdVote(...args);
    break;
  case 'results':
    cmdResults(args[0]);
    break;
  case 'close':
    cmdClose(args[0]);
    break;
  case 'list':
    cmdList();
    break;
  default:
    console.error(JSON.stringify({ error: 'UNKNOWN_COMMAND', message: `Unknown command: ${command}` }));
    console.error('Available commands: create, vote, results, close, list');
    process.exit(1);
}
