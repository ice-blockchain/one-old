// src/shared/digest-verdict.ts
// Shared machine-verdict parser. Settlement (`exactDigestVerdict` in
// terminal-verdict.ts) and the readiness gates (`digestClaimsVerdict`) must
// agree: every `verdict:` line counts, a trailing other machine token fails
// closed, and conflicting lines fail closed. Leaf — no imports from
// plan-readiness or run-agent, so neither side can cycle.

const DIGEST_VERDICT_TOKENS = /\b(PLAN_READY|IMPLEMENTED|BLOCKED|APPROVED|CHANGES_REQUESTED|TESTS_GREEN|TESTS_FAILING|DELEGATED_OK|SHIPPED|FAILED)\b/g;

export function digestHasVerdictLine(digest: string): boolean {
  return /^[ \t]*verdict[ \t]*:/im.test(digest);
}

export function exactDigestVerdict(digest: string): string | null {
  // The token must be the FIRST thing after `verdict:`, but a trailing summary on the
  // same line is tolerated. Requiring a bare line made a fully GREEN run impossible to
  // settle: observed live in cursor-15c, the tester wrote
  //   `verdict: TESTS_GREEN — 37 tests passed; pages 87%, apps/web 70.1%.`
  // which parsed as NO verdict, so reviewer APPROVED + tester TESTS_GREEN + a passing QA
  // report still left the run `nonterminal` forever — and, through buildSettlement, also
  // kept the project from ever flipping to maintenance. Agents naturally append a summary;
  // the parser, not the prose, was the thing that had to give.
  const verdicts: string[] = [];
  for (const match of digest.matchAll(/^[ \t]*verdict[ \t]*:[ \t]*([A-Z][A-Z_-]*)\b([^\n]*)$/gim)) {
    const token = match[1]?.toUpperCase();
    if (!token) continue;
    // A DIFFERENT machine token inside the trailing text (e.g. "TESTS_GREEN — was
    // TESTS_FAILING") is ambiguous, so it still fails closed. Prose never picks a winner;
    // it can only be neutral.
    const trailingConflict = [...String(match[2] || '').toUpperCase().matchAll(DIGEST_VERDICT_TOKENS)]
      .some((hit) => hit[1] !== token);
    if (trailingConflict) return null;
    verdicts.push(token);
  }
  const firstVerdict = verdicts[0];
  if (!firstVerdict) return null;
  // Multiple identical lines are harmless, but conflicting machine verdicts fail
  // closed instead of letting prose order or a stale handoff line choose a winner.
  return verdicts.every((verdict) => verdict === firstVerdict) ? firstVerdict : null;
}
