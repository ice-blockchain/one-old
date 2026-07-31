// config/cases/index.ts — aggregate every category file. Add a category = add
// one import + spread.

import type { Case } from '../../core/types';
import { NEW_PROJECT_CASES } from './new-project.cases';
import { PROJECT_LIFECYCLE_CASES } from './project-lifecycle.cases';
import { EXISTING_PROJECT_CASES } from './existing-project.cases';
import { FEATURE_AUTH_CASES } from './features-auth.cases';
import { FEATURE_ONBOARDING_CASES } from './features-onboarding.cases';
import { HOST_ENFORCEMENT_CASES } from './host-enforcement.cases';
import { RUN_SIM_CASES } from './run-sim.cases';
import { LINT_CORPUS_CASES } from './lint-corpus.cases';

export const ALL_CASES: Case[] = [
  ...FEATURE_ONBOARDING_CASES,
  ...LINT_CORPUS_CASES,
  ...RUN_SIM_CASES,
  ...HOST_ENFORCEMENT_CASES,
  ...NEW_PROJECT_CASES,
  ...PROJECT_LIFECYCLE_CASES,
  ...EXISTING_PROJECT_CASES,
  ...FEATURE_AUTH_CASES,
];
