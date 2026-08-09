// src/modules/plan-guard/__tests__/plan-static-deny-prose.test.ts
// The CONTRACT on plan-static's twelve constant-render deny paragraphs, as
// prose. plan-static.test.ts asserts which RULE fires (its fake block returns
// the block name, deliberately, so wording cannot break it); nothing asserted
// what the agent actually reads. Every one of these twelve used to be one or
// two sentences that named a rule and stopped — "Avoid the any type", "React
// Native UI must use native primitives" — so the reader was told a convention
// and never told what was wrong with THIS write, whether re-issuing it would
// help, or what to do next.
//
// The population is exactly the twelve rules in plan-static.ts whose block
// renders a CONSTANT text: the fourteen static rules minus `component-placement`
// ({{TARGET}}) and `cross-feature-import` ({{CURRENT}}/{{CROSS}}), which
// interpolate a call-site variable and are shaped by it. Constant renders are
// where a rewrite is most dangerous, because there is no interpolated value
// keeping two of them apart — see the render-space test at the bottom.
//
// ── The three properties, and why each one is here ───────────────────────────
//
//   1. FOUR SENTENCES. Cause, what is specifically wrong, that an unchanged
//      re-issue draws the same refusal, and an action. A floor, not a style
//      rule: each clause is a question the one- and two-sentence originals left
//      the reader to answer by guessing.
//   2. ENDS IN AN ACTION ITS OWN ADDRESSEE CAN TAKE, pinned per id below. The
//      same bar plan-runteam.test.ts's render-space table holds its recovery
//      paragraphs to, and it exists because a paragraph can satisfy every other
//      property while its remedy sits a sentence back from the end and the
//      reader stops at a prohibition.
//   3. NO PRESCRIBED RETRY. shared/state/deny-repeat.ts signs a refusal as
//      `denyTarget` plus the whole rendered reason and escalates at
//      DENY_REPEAT_ESCALATE_AT identical attempts, so a deny that TELLS the
//      agent to try again is prescribing a recovery that can trip the
//      escalation telling it to stop and report BLOCKED. shared/onboarding-
//      server/launch-timeout.ts bounds its own prescribed retry at ONE for
//      exactly this reason; these twelve prescribe none at all, and say so.
//
// The path is deliberately absent from all twelve. `filePath` is in scope at
// every call site, but plan-write/index.ts prefixes a static violation with its
// target ONLY when more than one file is being judged, so a single-file write
// renders the rule text unprefixed (plan-write.test.ts, 'a single-file static
// violation renders without a path prefix'). A path interpolated HERE would
// double that prefix on a multi-file patch and move the single-file render, so
// the last test asserts no rule text can carry one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as path from 'node:path';

import { DENY_REPEAT_ESCALATE_AT } from '../../../shared/state/deny-repeat';
import { applyVars, makeSkillBlock } from '../../../shared/skill-block';
import { makePlanBlock, planStaticViolations } from '../plan-static';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

// What SHIPS: the T1BLOCK bodies in modules/plan-guard/skill/SKILL.md, read
// through the production assembler.
const shipped = makePlanBlock(makeSkillBlock(() => REPO_ROOT));
// What renders when SKILL.md cannot be read: the verbatim TS fallback alone.
const fallbackOnly = (name: string, fallback: string, vars: Record<string, string | number | null | undefined> = {}): string =>
  applyVars(fallback, vars);

// ── the grid ─────────────────────────────────────────────────────────────────
// One row per branch plan-static can take, plus the exemptions and two-rule
// combinations, so the render space below is the gate's space and not a list of
// twelve strings. `isNative` is a real branch: it selects between two different
// style rules and two different DOM/primitive rules.

interface Cell { readonly label: string; readonly filePath: string; readonly content: string; readonly isNative: boolean }

// Built by concatenation so this test source does not itself trip the live plan
// gate when it is written into a project — the idiom plan-static.ts uses for
// its own WebSocket token, and plan-static.test.ts for these same five.
const INLINE_STATIC = 'style={' + '{ color: \'red\' }}';
const INLINE_DERIVED = 'style={' + '{ width: pct }}';
const WS = 'new ' + 'WebSocket("wss://x")';
const ANY = ': ' + 'any';
const DEEP = "from '../" + "../../packages/ui'";
const VE = "from '@vanilla" + "-extract/css'";
const CSSTS = "from './styles" + ".css.ts'";

const CELLS: readonly Cell[] = [
  { label: 'asset/png', filePath: 'apps/web/public/logo.png', content: '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n', isNative: false },
  { label: 'asset/jpeg-xml', filePath: 'apps/web/public/hero.jpeg', content: '<?xml version="1.0"?><svg></svg>\n', isNative: false },
  { label: 'asset/webp', filePath: 'apps/web/public/a.webp', content: '<svg></svg>', isNative: false },
  { label: 'asset/avif', filePath: 'apps/web/public/b.avif', content: '<svg></svg>', isNative: false },
  { label: 'pages/service', filePath: 'apps/web/src/pages/home.service.ts', content: 'export const x = 1;\n', isNative: false },
  { label: 'pages/store-tsx', filePath: 'src/pages/home.store.tsx', content: 'export const x = 1;\n', isNative: false },
  { label: 'expo/service-web', filePath: 'apps/web/app/home.service.ts', content: 'export const x = 1;\n', isNative: false },
  { label: 'expo/store-native', filePath: 'apps/mobile/app/index.store.tsx', content: 'export const x = 1;\n', isNative: true },
  { label: 'placement/web-tsx', filePath: 'apps/web/src/Widget.tsx', content: 'export const Widget = () => null;\n', isNative: false },
  { label: 'placement/native-tsx', filePath: 'apps/mobile/src/Widget.tsx', content: 'export const Widget = () => null;\n', isNative: true },
  { label: 'cross-feature/one', filePath: 'apps/web/src/features/cart/total.ts', content: "import { rate } from '@/features/checkout/api';\n", isNative: false },
  { label: 'cross-feature/two', filePath: 'apps/web/src/features/cart/x.ts', content: "import { a } from '@/features/checkout/api';\nimport { b } from '@/features/billing/api';\n", isNative: false },
  { label: 'deep-relative', filePath: 'apps/web/src/features/cart/button.ts', content: `import { Button } ${DEEP};\n`, isNative: false },
  { label: 'default-export/components', filePath: 'apps/web/src/components/Badge.tsx', content: 'export default function Badge() { return null; }\n', isNative: false },
  { label: 'default-export/feature-entry', filePath: 'apps/web/src/features/contact/index.tsx', content: 'export default function C() {}\n', isNative: false },
  { label: 'native-inline/static', filePath: 'apps/mobile/src/components/Card.tsx', content: `<View ${INLINE_STATIC} />\n`, isNative: true },
  { label: 'native-inline/derived', filePath: 'apps/mobile/src/components/Bar.tsx', content: `<View ${INLINE_DERIVED} />\n`, isNative: true },
  { label: 'native-dom-tags', filePath: 'apps/mobile/src/components/Row.tsx', content: '<div>hello</div>\n', isNative: true },
  { label: 'web-inline/static', filePath: 'apps/web/src/components/Box.tsx', content: `<div ${INLINE_STATIC} />\n`, isNative: false },
  { label: 'web-inline/derived-allowed', filePath: 'apps/web/src/components/Bar.tsx', content: `<div ${INLINE_DERIVED} />\n`, isNative: false },
  { label: 'vanilla-extract/ts', filePath: 'apps/web/src/components/theme.ts', content: `import { style } ${VE};\n`, isNative: false },
  { label: 'vanilla-extract/tsx', filePath: 'apps/web/src/components/theme.tsx', content: `import { style } ${VE};\n`, isNative: false },
  { label: 'css-ts/ts', filePath: 'apps/web/src/components/panel.ts', content: `import { box } ${CSSTS};\n`, isNative: false },
  { label: 'css-ts/tsx', filePath: 'apps/web/src/components/panel.tsx', content: `import { box } ${CSSTS};\n`, isNative: false },
  { label: 'no-any/ts', filePath: 'apps/web/src/components/util.ts', content: `export const w = (v${ANY}) => v;\n`, isNative: false },
  { label: 'no-any/native', filePath: 'apps/mobile/src/components/util.ts', content: `export const w = (v${ANY}) => v;\n`, isNative: true },
  { label: 'no-any/test-exempt', filePath: 'apps/web/src/components/__tests__/util.test.ts', content: `export const w = (v${ANY}) => v;\n`, isNative: false },
  { label: 'websocket/ts', filePath: 'apps/web/src/components/live.ts', content: `export const open = () => ${WS};\n`, isNative: false },
  { label: 'websocket/allowed', filePath: 'packages/ws-client/src/x.ts', content: `export const open = () => ${WS};\n`, isNative: false },
  { label: 'clean/web', filePath: 'apps/web/src/components/Button.tsx', content: 'export const Button = () => null;\n', isNative: false },
  { label: 'clean/native', filePath: 'apps/mobile/src/components/Button.tsx', content: 'export const Button = () => null;\n', isNative: true },
  { label: 'combo/any+websocket', filePath: 'apps/web/src/components/live2.ts', content: `export const w = (v${ANY}) => ${WS};\n`, isNative: false },
  { label: 'combo/default+inline', filePath: 'apps/web/src/components/Combo.tsx', content: `export default function C() { return <div ${INLINE_STATIC} />; }\n`, isNative: false },
  { label: 'combo/native-inline+dom', filePath: 'apps/mobile/src/components/Both.tsx', content: `<div ${INLINE_STATIC} />\n`, isNative: true },
];

// ── the population, and the terminating action each paragraph owes ───────────
// The regex is the LAST sentence, anchored at end-of-text: an action that
// slides earlier in a rewrite fails here, which is the defect this bar exists
// for. Every one of them is something the writer of the refused file can do
// from where it is standing — an edit inside the same file, or (where the
// remedy may be a relocation the role's allowlist forbids) a `BLOCKED` digest
// entry, the action run-team-runtime-allowlist-gap already prescribes.

interface Pinned {
  readonly id: string;
  /** A payload that makes exactly this rule fire. */
  readonly cell: string;
  /** The action the paragraph must END in. */
  readonly action: RegExp;
}

const PINNED: readonly Pinned[] = [
  { id: 'asset-extension-mismatch', cell: 'asset/png', action: /so it holds on an existing codebase too\.$/ },
  { id: 'pages-service-files', cell: 'pages/service', action: /so the architect can compile a home for it\.$/ },
  { id: 'expo-route-service-files', cell: 'expo/service-web', action: /name this path in your digest with verdict `BLOCKED`\.$/ },
  { id: 'deep-relative-package', cell: 'deep-relative', action: /the fix is an edit to the import line, never a relocation\.$/ },
  { id: 'default-export', cell: 'default-export/components', action: /the matching change at each import site, never a relocation\.$/ },
  { id: 'native-inline-style', cell: 'native-inline/static', action: /both edits stay inside this same file\.$/ },
  { id: 'native-dom-tags', cell: 'native-dom-tags', action: /and `TextInput` for `input`\.$/ },
  { id: 'web-inline-style', cell: 'web-inline/static', action: /a genuinely derived width or transform may remain\.$/ },
  { id: 'vanilla-extract-import', cell: 'vanilla-extract/ts', action: /editing the imports and the markup in this same file\.$/ },
  { id: 'css-ts-import', cell: 'css-ts/ts', action: /theme them through the HSL CSS variables in `globals\.css`\.$/ },
  { id: 'no-any', cell: 'no-any/ts', action: /so a mock or fixture may keep its coarse typing\.$/ },
  { id: 'websocket-location', cell: 'websocket/ts', action: /the transport module you need in your digest with verdict `BLOCKED`\.$/ },
];

function cellFor(label: string): Cell {
  const found = CELLS.find((candidate) => candidate.label === label);
  assert.ok(found, `no grid cell labelled ${label}`);
  return found!;
}

/** The one rendered line the pinned cell produces, through a chosen assembler. */
function renderOne(pinned: Pinned, block: typeof shipped): string {
  const cell = cellFor(pinned.cell);
  const lines = planStaticViolations(cell.filePath, cell.content, cell.isNative, block);
  assert.equal(lines.length, 1,
    `fixture ${pinned.cell} must trip exactly one rule (${pinned.id}); it produced ${lines.length}`);
  return lines[0]!;
}

// A sentence ends at `.` followed by whitespace-and-a-capital, or by the end of
// the text. Deliberately naive: every dotted token these paragraphs use
// (`.tsx`, `.css.ts`, `../../../packages/…`, `globals.css`) continues with a
// lowercase letter, a slash or another dot, so none of them splits. A rewrite
// that introduces one that DOES would over-count, which is why the floor is
// paired with a mutation that removes a whole sentence.
function sentenceCount(text: string): number {
  return text.split(/\.(?=\s+[A-Z]|$)/).filter((piece) => piece.trim() !== '').length;
}

test('the constant-render static denies say four things: cause, what is wrong, that a retry is futile, and an action', () => {
  for (const pinned of PINNED) {
    const rendered = renderOne(pinned, shipped);
    const count = sentenceCount(rendered);
    assert.ok(
      count >= 4,
      `${pinned.id} renders ${count} sentence(s), not four. A static deny must name the CAUSE, say what is `
      + 'specifically wrong with this write, say that re-issuing it unchanged draws the same refusal, and END in an '
      + `action. What it renders today:\n    ${rendered}`,
    );
    // The futility clause is the one an agent acts on FIRST — without it the
    // cheapest next move looks like re-issuing the same bytes, which is the
    // loop deny-repeat.ts exists to count.
    assert.match(
      rendered, /draws the same refusal/,
      `${pinned.id} never tells the reader that an unchanged re-issue is refused identically`,
    );
  }
});

test('every constant-render static deny ENDS in an action its own addressee can take', () => {
  for (const pinned of PINNED) {
    const rendered = renderOne(pinned, shipped);
    assert.match(
      rendered, pinned.action,
      `${pinned.id} does not END in its pinned action — it ends in "${rendered.slice(-100)}". A remedy that sits a `
      + 'sentence back from the end is a paragraph the reader stops reading at a prohibition.',
    );
    // …and the action must not BE the futility clause. A paragraph that ends
    // "re-issuing this draws the same refusal" has told the agent only what
    // not to do, which is the exact shape the bar rejects.
    assert.doesNotMatch(
      rendered, /draws the same refusal[^.]*\.\s*$/,
      `${pinned.id} ends on the futility clause, so its last word to the reader is a prohibition`,
    );
  }
});

test('no static deny prescribes a retry, so its own remedy can never trip the repeat escalation', () => {
  for (const pinned of PINNED) {
    const rendered = renderOne(pinned, shipped);
    assert.doesNotMatch(
      rendered, /\bretry\b|\bretries\b|\btry again\b|\bre-?issue it\b/i,
      `${pinned.id} prescribes a retry. shared/state/deny-repeat.ts signs a refusal as denyTarget plus the whole `
      + `rendered reason and escalates at ${DENY_REPEAT_ESCALATE_AT} identical attempts, so a prescribed retry can `
      + 'drive the agent into the escalation that tells it to stop and report BLOCKED for doing what it was told. '
      + 'Bound any retry strictly below that (launch-timeout.ts prescribes at most ONE), or prescribe none.',
    );
  }
});

test('a torn install renders the same paragraph: the verbatim fallback matches what SKILL.md ships', () => {
  for (const pinned of PINNED) {
    assert.equal(
      renderOne(pinned, fallbackOnly), renderOne(pinned, shipped),
      `${pinned.id}: the TS fallback and the shipped T1BLOCK are two different refusals. SKILL.md is what ships and `
      + 'what the operator reviews; the fallback is what renders when the skill tree is unreachable. Apply the edit '
      + 'to both.',
    );
  }
});

test('no static rule text names its own file, so the aggregator owns the path prefix', () => {
  // plan-write/index.ts prefixes each static line with its target ONLY when
  // more than one file is judged, which is what keeps a single-file write
  // byte-identical to what it rendered before that fix landed. A rule that
  // interpolated `filePath` itself would double the prefix on a multi-file
  // patch and move the single-file render.
  for (const cell of CELLS) {
    for (const line of planStaticViolations(cell.filePath, cell.content, cell.isNative, shipped)) {
      assert.equal(
        line.includes(cell.filePath), false,
        `${cell.label}: the rule text embeds its own target path (${cell.filePath}). The naming belongs to `
        + 'plan-write/index.ts, conditional on there being more than one file to name.',
      );
    }
  }
});

// ── the render space, which is where a prose rewrite actually goes wrong ─────
// The twelve constant renders have no interpolated value keeping them apart, so
// two of them can be made byte-identical by a rewrite that reads fine in
// isolation — and deny-repeat.ts signs on the rendered reason, so a merge puts
// two different causes in ONE escalation bucket and an agent clearing them one
// at a time is told it is looping. Measured across the whole grid, before and
// after the four-sentence rewrite: 29 denying cells, 32 violation lines, 16
// distinct texts (twelve constant plus two `component-placement` targets and
// two `cross-feature-import` shapes), 19 distinct whole-cell renders. The
// counts are asserted rather than described, because a count is what a
// collapse moves.
test('the full render space collapses nowhere: 16 distinct texts across 29 denying cells', () => {
  const sha = (text: string): string => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
  const lineOwner = new Map<string, string>();
  const cellRenders = new Set<string>();
  let denyingCells = 0;
  let totalLines = 0;

  for (const cell of CELLS) {
    const lines = planStaticViolations(cell.filePath, cell.content, cell.isNative, shipped);
    if (lines.length === 0) continue;
    // Which RULE produced each line, independent of wording, so a collision is
    // reported as the pair of rules it merges. Same inputs, same order — a
    // two-rule cell yields two names, positionally paired with its two lines.
    const rules = planStaticViolations(cell.filePath, cell.content, cell.isNative, (name: string) => name);
    assert.equal(rules.length, lines.length, `${cell.label}: rule names and rendered lines must pair up`);
    denyingCells += 1;
    totalLines += lines.length;
    cellRenders.add(sha(lines.join('\n')));
    lines.forEach((line, index) => {
      const rule = rules[index]!;
      const owner = lineOwner.get(line);
      if (owner !== undefined) {
        assert.equal(
          owner, rule,
          `two DIFFERENT static rules now render byte-identical text (${owner} and ${rule}). They share one `
          + 'deny-repeat signature from here on, so an agent clearing them one file at a time is counted as looping '
          + `and escalated at ${DENY_REPEAT_ESCALATE_AT} attempts:\n    ${line}`,
        );
      }
      lineOwner.set(line, rule);
    });
  }

  assert.equal(denyingCells, 29, 'grid coverage: the number of cells that produce at least one violation');
  assert.equal(totalLines, 32, 'grid coverage: total violation lines, including the three two-rule combinations');
  assert.equal(
    lineOwner.size, 16,
    'the distinct-text count moved. UP means a render split (fine on purpose, wrong by accident); DOWN means two '
    + 'previously-distinct refusals merged into one escalation bucket.',
  );
  assert.equal(cellRenders.size, 19, 'distinct whole-cell renders');
});
