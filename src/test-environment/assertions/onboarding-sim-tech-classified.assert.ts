// onboarding-sim-tech-classified: the agent-classification fallback ran for
// real inside the wizard flow.
//
// The undetectable-repo shape (a bare Express/Mongoose API no deterministic
// marker recognizes) must route through the 'tech-detect' step and reach
// completion via applyAgentTechClassification — the same writer the
// `--set-tech` runner uses. Without this fence, a detection change that starts
// recognizing the fixture would silently skip the step and the case would prove
// nothing about the fallback.

import type { Assertion } from '../core/types';
import { effState, readJsonFile, result, str } from './util';
import * as path from 'path';

export const assertion: Assertion = {
  id: 'onboarding-sim-tech-classified',
  title: 'The agent tech-classification step ran and stamped the submission',
  appliesTo: (c) => c.layer === 'pure-node'
    && (c.scriptedAnswers ?? []).some((answer) => answer.step === 'tech-detect'),
  run: (ctx) => {
    const sim = readJsonFile(path.join(ctx.caseFolder, 'onboarding-sim.json'));
    if (!sim) return result(ctx, 'FAIL', 'No onboarding-sim.json was persisted — the flow sim never ran.');
    const steps = Array.isArray(sim.steps) ? sim.steps as Array<{ step?: unknown; ok?: unknown }> : [];
    const techStep = steps.find((step) => step.step === 'tech-detect');
    if (!techStep) {
      return result(ctx, 'FAIL', `The 'tech-detect' step never fired — detection classified the fixture deterministically, so the agent fallback was not exercised. Steps: ${steps.map((step) => String(step.step)).join(' → ') || '(none)'}.`);
    }
    if (techStep.ok !== true) {
      return result(ctx, 'FAIL', "The 'tech-detect' step ran but the classification was rejected.");
    }

    const state = effState(ctx);
    if (state.autoDetected !== false) {
      return result(ctx, 'FAIL', `The stamped identity must carry autoDetected:false (agent-classified), got ${String(state.autoDetected)}.`, {
        expected: false,
        actual: state.autoDetected,
      });
    }
    const stack = str(state.stack);
    const backend = str(state.backend);
    if (stack !== 'custom-backend' || backend !== 'node') {
      return result(ctx, 'FAIL', `The classification should derive stack=custom-backend backend=node from the submitted surfaces, got stack=${stack} backend=${backend}.`);
    }
    const evidence = Array.isArray(state.evidence) ? state.evidence.map(String) : [];
    if (!evidence.some((row) => row.startsWith('agent-classified:'))) {
      return result(ctx, 'FAIL', 'The stamped evidence carries no agent-classified row.');
    }
    return result(ctx, 'PASS', `tech-detect fired and the agent submission stamped stack=${stack} backend=${backend} autoDetected=false with agent-classified evidence; the wizard then completed normally.`);
  },
};
