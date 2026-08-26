// src/test-environment/core/briefing-ratchet.ts
// Local tally over recorded deny events: denyId × spawnIndex × host.
//
// This is the product KPI for Class-Briefing fires on the FIRST mutating tool.
// It is NOT a one-mcp telemetry field — collectMetadata stays locked to its
// five anonymous fields. Sequencing/Safety remaining on a first attempt is
// acceptable; Briefing-class on a first attempt is not.
//
// Runtime spawnIndex is 1-based (`nextSpawnIndex` uses Math.max(..., 1)). The
// plan's "spawnIndex 0" means first spawn / first attempt, which is
// `spawnIndex === 1` OR (when the index was omitted) the first unexpected deny
// of that (host, denyId) pair.

import { denyClassOf, isDenyId } from '../../config/deny-ids';

export const NAMED_RATCHET_DENY_IDS = [
  'default-export',
  'no-any',
  'performance-model-param',
  'repaired-materialization',
  'onboarding-server-deny-first',
] as const;

export type NamedRatchetDenyId = (typeof NAMED_RATCHET_DENY_IDS)[number];

const NAMED_RATCHET_DENY_ID_SET: ReadonlySet<string> = new Set(NAMED_RATCHET_DENY_IDS);

export interface BriefingTallyEvent {
  denyId?: string | null;
  spawnIndex?: number;
  host: string;
  expected?: boolean;
}

export interface BriefingTallyHit {
  denyId: string;
  spawnIndex: number;
  host: string;
}

export interface BriefingTally {
  briefingFirstAttempt: BriefingTallyHit[];
  namedRatchetHits: BriefingTallyHit[];
}

function isNamedRatchetDenyId(denyId: string): denyId is NamedRatchetDenyId {
  return NAMED_RATCHET_DENY_ID_SET.has(denyId);
}

// Omitted spawnIndex is reported as 1: that is the first-attempt slot the
// runtime would have assigned (`Math.max(..., 1)`).
function reportedSpawnIndex(event: BriefingTallyEvent): number {
  return typeof event.spawnIndex === 'number' ? event.spawnIndex : 1;
}

function hitOf(event: BriefingTallyEvent, denyId: string): BriefingTallyHit {
  return { denyId, spawnIndex: reportedSpawnIndex(event), host: event.host };
}

// First attempt = spawnIndex === 1, OR spawnIndex omitted on the first
// unexpected deny of that (host, denyId) pair. spawnIndex 2+ is a retry.
// A recorded 0 is not a first attempt — runtime never assigns 0.
function isFirstAttempt(events: readonly BriefingTallyEvent[], index: number): boolean {
  const event = events[index];
  if (!event || event.expected === true) return false;
  if (event.spawnIndex === 1) return true;
  if (event.spawnIndex !== undefined) return false;
  for (let prior = 0; prior < index; prior += 1) {
    const previous = events[prior];
    if (!previous || previous.expected === true) continue;
    if (previous.host === event.host && previous.denyId === event.denyId) return false;
  }
  return true;
}

export function tallyFirstAttemptBriefing(events: BriefingTallyEvent[]): BriefingTally {
  const briefingFirstAttempt: BriefingTallyHit[] = [];
  const namedRatchetHits: BriefingTallyHit[] = [];
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    if (event.expected === true) continue;
    const denyId = event.denyId;
    if (typeof denyId !== 'string' || !denyId) continue;
    if (isNamedRatchetDenyId(denyId)) {
      namedRatchetHits.push(hitOf(event, denyId));
    }
    if (!isDenyId(denyId)) continue;
    if (denyClassOf(denyId) !== 'briefing') continue;
    if (!isFirstAttempt(events, index)) continue;
    briefingFirstAttempt.push(hitOf(event, denyId));
  }
  return { briefingFirstAttempt, namedRatchetHits };
}

// Decision-log records have denyId and host but no spawnIndex (do not add one).
// The tally's omitted-index rule then treats the first unexpected (host, denyId)
// pair as first attempt. Claims are accepted when the caller already resolved
// a spawnIndex; this helper will not invent one from a multi-claim set.
export function tallyEventsFromDecisions(
  records: ReadonlyArray<{
    decision?: string | null;
    denyId?: string | null;
    host: string;
  }>,
  spawnIndex?: number,
): BriefingTallyEvent[] {
  const events: BriefingTallyEvent[] = [];
  for (const record of records) {
    if (record.decision !== 'deny') continue;
    events.push({
      denyId: record.denyId,
      host: record.host,
      ...(typeof spawnIndex === 'number' ? { spawnIndex } : {}),
    });
  }
  return events;
}
