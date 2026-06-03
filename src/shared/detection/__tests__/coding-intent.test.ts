import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isLikelyCodingPrompt } from '../index';

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
