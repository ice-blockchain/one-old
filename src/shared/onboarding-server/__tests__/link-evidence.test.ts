import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { assistantPostedLink } from '../link-evidence';

const URL = 'https://traffic.io/onboarding/agent#p=61943&t=8dc34f6f06c3495b22766949448a58f118c42d7';

function withDir(fn: (dir: string) => void): void {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-linkev-')));
  try { fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const claudeAssistantLine = JSON.stringify({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text: `Open this link:\n\n${URL}\n\nI'll wait.` }] },
});
// The bootstrap's stdout carries the link too — inside a tool_result on a
// type:"user" record. That is NOT delivery.
const claudeToolResultLine = JSON.stringify({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', content: `TRAFFIC_ONE_SETUP_READY\nSetup link: ${URL}` }] },
});
const claudeSystemLine = JSON.stringify({ type: 'system', content: `banner ${URL}` });

test('claude: only an assistant-authored transcript message counts as a posted link', () => {
  withDir((dir) => {
    const transcript = path.join(dir, 'session.jsonl');

    fs.writeFileSync(transcript, `${claudeToolResultLine}\n${claudeSystemLine}\n`, 'utf8');
    assert.equal(
      assistantPostedLink({ url: URL, host: 'claude', raw: { transcript_path: transcript } }),
      false,
      'tool output and hook banners are the invisible producers this must never trust',
    );

    fs.appendFileSync(transcript, `${claudeAssistantLine}\n`, 'utf8');
    assert.equal(
      assistantPostedLink({ url: URL, host: 'claude', raw: { transcript_path: transcript } }),
      true,
      'an assistant chat message with the URL is user-visible delivery',
    );

    assert.equal(
      assistantPostedLink({ url: 'https://traffic.io/onboarding/agent#p=1&t=other', host: 'claude', raw: { transcript_path: transcript } }),
      false,
      'a DIFFERENT link (new server/token) is not evidence for this one',
    );
    assert.equal(assistantPostedLink({ url: URL, host: 'claude', raw: {} }), false, 'no transcript_path → no evidence');
    assert.equal(
      assistantPostedLink({ url: URL, host: 'claude', raw: { transcript_path: path.join(dir, 'missing.jsonl') } }),
      false,
      'unreadable transcript fails toward re-delivery',
    );
  });
});

test('codex: only agent_message / assistant response_item rollout records count', () => {
  withDir((dir) => {
    const sessionId = '019fbca1-eefc-79f3-840d-23d676040dd0';
    const dayDir = path.join(dir, 'sessions', '2026', '08', '01');
    fs.mkdirSync(dayDir, { recursive: true });
    const rollout = path.join(dayDir, `rollout-2026-08-01T12-22-36-${sessionId}.jsonl`);
    const env = { CODEX_HOME: dir } as NodeJS.ProcessEnv;

    // Bootstrap stdout + deny reason shapes — never evidence.
    fs.writeFileSync(rollout, `${JSON.stringify({
      type: 'response_item',
      payload: { type: 'custom_tool_call_output', output: `TRAFFIC_ONE_SETUP_READY\nSetup link: ${URL}` },
    })}\n`, 'utf8');
    assert.equal(assistantPostedLink({ url: URL, host: 'codex', sessionId, raw: {}, env }), false);

    fs.appendFileSync(rollout, `${JSON.stringify({
      type: 'event_msg',
      payload: { type: 'agent_message', message: `Complete the Traffic One setup here:\n\n${URL}` },
    })}\n`, 'utf8');
    assert.equal(assistantPostedLink({ url: URL, host: 'codex', sessionId, raw: {}, env }), true);

    // The response_item assistant twin alone is enough too.
    const twinOnly = path.join(dayDir, `rollout-2026-08-01T12-30-00-${sessionId}2.jsonl`);
    fs.writeFileSync(twinOnly, `${JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `Open Traffic One setup: ${URL}` }] },
    })}\n`, 'utf8');
    assert.equal(assistantPostedLink({ url: URL, host: 'codex', sessionId: `${sessionId}2`, raw: {}, env }), true);

    assert.equal(assistantPostedLink({ url: URL, host: 'codex', sessionId: 'unknown-session', raw: {}, env }), false);
    assert.equal(assistantPostedLink({ url: URL, host: 'codex', sessionId: '', raw: {}, env }), false);
  });
});

test('other hosts and empty urls never claim evidence', () => {
  assert.equal(assistantPostedLink({ url: URL, host: 'cursor', raw: {} }), false);
  assert.equal(assistantPostedLink({ url: '', host: 'claude', raw: { transcript_path: '/nope' } }), false);
});
