import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isLikelyCodingPrompt, isLikelyEditRequest, isRuntimeControlPrompt } from '../index';

test('isLikelyCodingPrompt: build/implementation prompts are coding', () => {
  for (const prompt of [
    'build a todo app with auth',
    'create a landing page',
    'add a login form',
    'scaffold the dashboard',
    'fix the failing test in src/app.ts',
    'refactor this component',
    'wire up the Supabase backend',
    'make me a React + Vite SaaS',
    'implement a REST API endpoint for users',
    'set up the database schema',
    'continue building the nextjs app',
    'deploy the site',
    'npm install and run the dev server',
  ]) {
    assert.equal(isLikelyCodingPrompt(prompt), true, `expected coding: ${prompt}`);
  }
});

test('isLikelyCodingPrompt: chit-chat / questions are not coding', () => {
  for (const prompt of [
    'hi there, how are you today?',
    'what is the capital of France?',
    'thanks, that was helpful',
    'can you explain how photosynthesis works?',
    'tell me a joke',
    'good morning',
    '',
  ]) {
    assert.equal(isLikelyCodingPrompt(prompt), false, `expected non-coding: ${prompt}`);
  }
});

test('isLikelyEditRequest: copy/UI tweaks the coding-intent heuristic misses still count', () => {
  for (const prompt of [
    'Change the hero headline to Master Software without Development', // the reported miss
    'shorten the title',
    'reword the tagline',
    'move the footer below the form',
    'make the headline bigger',          // also matches coding-intent ("make")
    'tweak the spacing on the pricing cards',
    'swap the hero copy',
  ]) {
    assert.equal(isLikelyEditRequest(prompt), true, `expected edit request: ${prompt}`);
    // None of the first few are caught by the narrower onboarding heuristic.
  }
  // The narrow heuristic genuinely missed the reported prompt — confirm the gap it closes.
  assert.equal(isLikelyCodingPrompt('Change the hero headline to Master Software without Development'), false);
});

test('isLikelyEditRequest: still rejects pure chit-chat / questions', () => {
  for (const prompt of ['how are you today?', 'thanks, that was helpful', 'good morning', 'tell me a joke', '']) {
    assert.equal(isLikelyEditRequest(prompt), false, `expected non-edit: ${prompt}`);
  }
});

test('isRuntimeControlPrompt: local server, process, port, and log commands stay with the parent', () => {
  for (const prompt of [
    'start the dev server',
    'please stop the local server',
    'restart preview server on port 4173',
    'restart the Vite dev server',
    'stop and restart the server',
    'run npm run dev',
    'pnpm dev',
    'check if port 5173 is in use',
    'is the development server running?',
    'check if process 1234 is running',
    'check process 123456',
    'inspect PID 987654 status',
    'is process 1234 running?',
    'what process is listening on port 3000',
    'stop the process listening on port 5173',
    'show me the local server logs',
    'view the dev server logs',
    'tail the logs from the preview server',
    'show the logs for the Vite dev server',
    'restart the dev server and show me the logs',
  ]) {
    assert.equal(isRuntimeControlPrompt(prompt), true, `expected runtime control: ${prompt}`);
  }
});

test('isRuntimeControlPrompt: implementation and near-miss server prompts still route normally', () => {
  for (const prompt of [
    'fix the server startup error',
    'change the server config',
    'add an endpoint to the server',
    'debug why the dev server crashes',
    'restart the server after changing the Vite config',
    'update the preview command',
    'npm install and run the dev server',
    'show the server logs and fix the exception',
    'restart the Vite dev server and change its config',
    'how does the development server work?',
  ]) {
    assert.equal(isRuntimeControlPrompt(prompt), false, `expected normal routing: ${prompt}`);
  }
});
