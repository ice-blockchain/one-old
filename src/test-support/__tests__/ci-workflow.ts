// src/test-support/__tests__/ci-workflow.ts
// A structural reader for this repo's GitHub workflow files, a shell reader for
// the `run:` bodies inside them, and the audit that decides whether a job REALLY
// runs the measurements it is credited with.
//
// WHY THIS IS A MODULE AND NOT FOUR REGEXES IN A TEST. The check it replaces
// asked three substring questions of the whole file — "does any non-comment
// line anywhere name this file", "does the text after the job header contain
// this filename", "does that text contain enough `did not run::` markers" — and
// a substring question cannot tell WHERE it was answered. Measured against the
// committed workflow: deleting both session-start steps outright, leaving the
// filename in one comment inside the serial job and one `echo` inside the
// PARALLEL job, left both checks green while the serial job ran one fewer test.
//
// AND WHY A SHELL READER ON TOP OF THAT. The first parser fixed WHERE the
// filename was found and kept asking whether it was FOUND, which lost the same
// hole one line to the left: an `echo "temporarily skipping <file>"` inside the
// enforcing job, on a genuine `run:` line, is a token in the right place and
// executes nothing. Token presence is not execution, so what is detected now is
// an INVOCATION — a test runner, reached by a reachable command, with the file
// as one of its positional arguments. The same reader answers three other
// questions no substring can: whether `set -o pipefail` is a command or a word
// inside an `echo`, which pipelines actually mask a status, and whether a
// command is behind a `false &&` guard.
//
// Four structural weaknesses composed into the original hole:
//
//   1. "named anywhere in the workflows directory" counts a mention in a job
//      that cannot enforce anything. The question is whether the ENFORCING job
//      runs the file, so the reader has to know which job a line belongs to.
//   2. `text.slice(indexOf('\n  latency-budget:'))` runs to end of file, so
//      everything in every LATER job was inside what the check called the serial
//      job. A job ends where the next job header begins — and a header this
//      reader cannot recognise silently appends the next job's steps to the
//      previous one, so the header grammar has to admit the ordinary spellings
//      (quoted key, trailing comment, trailing tab) rather than one of them.
//   3. A raw substring test does not skip comments, in either syntax — YAML `#`
//      lines and shell `#` lines inside a `run:` block are both prose.
//   3b. The reader kept step keys and threw away job keys, so the two GitHub
//      evaluates ABOVE every step — a job-level `continue-on-error:` and a
//      job-level `if:` — were invisible. Either is a one-line, fully green
//      defeat of every per-step property below it: with the first, every step
//      still runs and every report step still exits 1 while the workflow is
//      green; with the second, no step runs at all, so the runtime half has
//      nothing to catch either. The audit checked the same two keys on steps
//      and never asked the job.
//   4. A `run:` body the reader cannot read yields a step with no commands,
//      which is indistinguishable from a step that runs nothing — so every
//      count over such a body is a count with a hole in it. That is why the
//      block-scalar grammar here accepts explicit indentation indicators and
//      auto-detected content indents, and why the callers pair per step instead
//      of counting steps.
//
// WHY THE YAML IS NOW PARSED BY A PARSER, and why that is a reversal.
//
// This file used to say "no YAML dependency: the hook runtime is
// dependency-free and the test tree inherits that", and read jobs and steps
// with an indentation grammar of six regexes. Every rule below cites one fact —
// what I see is what GitHub sees — and the reader was the only component here
// with no check of its own fidelity: 96 tests verified the rules, none verified
// the substrate they share. Measured on the committed file, with the whole
// suite green (96 pass / 0 fail) on every row:
//
//   "continue-on-error": true   at job level   — not a key, not refused
//   'if': false                 at job level   — not a key, not refused
//   "needs": generate-check     at job level   — the key round 5 inverted the
//                                                rule to catch, invisible
//   "continue-on-error": true   on a step      — measurement or install step
//   - "name": x                 a step         — merged into the step BEFORE it
//
// All five are ordinary YAML for the same document. The grammar demanded a BARE
// key at job level and at step level while already admitting quoted spellings
// for job headers and for `on:`, so it was inconsistent with itself, and the
// docblock on `WorkflowJob.keys` ("EVERY key this job declares at indent 4")
// was false in two independent ways — a quoted key was not recorded, and
// neither was `steps:`.
//
// Widening two regexes closes those five and not the class. The class is that a
// hand-rolled grammar is a DENYLIST OF SPELLINGS: it can only admit the ones
// somebody has already been defeated by, which is the same defect round 5 fixed
// one level up when it inverted the job-key rule. A differential test against a
// real parser would measure today's divergences on today's corpus and say
// nothing about the spelling nobody put in the corpus. So the grammar is gone
// and the document is read by `yaml` (2.9.0, ISC, zero runtime dependencies of
// its own), a devDependency.
//
// THE DEPENDENCY RULE THIS DOES NOT BREAK. AGENTS.md forbids npm packages in
// `dist/scripts`, the hook runtime. tsconfig.build.json — the config
// src/build/build-runtime.ts compiles with — excludes `src/**/__tests__/**` and
// `src/**/*.test.ts`, so this file is not in that tree, and its only importers
// are the two test files beside it. Several runtime files still parse YAML-ish
// input by hand (src/shared/hook/workspace-declaration.ts,
// src/shared/skill-filters/index.ts); they stay dependency-free and are not
// touched.
//
// WHAT IS STILL THIS FILE'S OWN, and what the fidelity test below is therefore
// about: the PROJECTION from a YAML document onto the jobs, steps and keys the
// audit reasons over. Every defect above was a projection defect wearing a
// parse defect's clothes — a key dropped, a step attached to its neighbour —
// and that is the layer the differential test in latency-budget-ci.test.ts
// compares against an independent traversal of the same document.
//
// AND THE LIMIT, stated rather than implied: `yaml` is not GitHub. GitHub
// Actions parses workflows with its own implementation, so agreement here is
// agreement with a widely used YAML 1.2 implementation and not proof about the
// runner. That residual is smaller than the one it replaces and it is not zero.
// Where the two are known to differ this file takes the fail-closed side: an
// unreadable file yields no jobs, which fails the audit rather than passing it,
// and it says WHY in a finding of its own — see `workflowRefusal`.

import {
  isAlias, isMap, isScalar, isSeq, LineCounter, parseAllDocuments, visit,
  type Document, type Node, type Pair, type YAMLMap,
} from 'yaml';

/** One step of one job, with comment lines already removed from `run`. */
export interface WorkflowStep {
  readonly name: string;
  /** 1-based line of the step's first key, for error messages. */
  readonly line: number;
  /** The `if:` expression verbatim, or null when the step has none. */
  readonly if: string | null;
  /**
   * True when the key is present and is anything other than the literal
   * `false`. Fail-closed on purpose: `continue-on-error: ${{ inputs.soft }}` is
   * a masked status whichever way the expression lands, and a reader that only
   * recognised the literal `true` would call it clean.
   */
  readonly continueOnError: boolean;
  /** The `shell:` declaration verbatim, or null when the step relies on the runner default. */
  readonly shell: string | null;
  /**
   * The step's `id:`, or null when it declares none.
   *
   * Recorded because a condition can NAME one: the measurement steps of the
   * enforcing job are gated on `steps.install.outcome == 'success'`, and a
   * reader that does not know which ids exist cannot tell that condition from
   * one referring to a step that was deleted, renamed or never existed. GitHub
   * resolves the missing context to null, the comparison is false, the step
   * skips, and the job is green — one deleted line, no other edit.
   */
  readonly id: string | null;
  /** The `uses:` reference, or null for a `run:` step. */
  readonly uses: string | null;
  /** Step-level `env:` entries, values unquoted. */
  readonly env: ReadonlyMap<string, string>;
  /** Lines of the `run:` scalar, comment-only lines dropped. */
  readonly run: readonly string[];
}

/** One key of a job's mapping, with its value rendered for a message. */
export interface WorkflowJobKey {
  readonly name: string;
  readonly value: string;
  readonly line: number;
}

export interface WorkflowJob {
  readonly id: string;
  readonly line: number;
  readonly steps: readonly WorkflowStep[];
  /**
   * EVERY key this job's mapping declares, in file order, in every spelling
   * YAML permits for a key.
   *
   * Everything, not a chosen few, and that inversion is the point. The reader
   * kept four names here — `uses`, `continue-on-error`, `if`, `strategy` — and
   * threw the rest away, which is a denylist: it can only refuse the keys
   * somebody already thought of, so it is permanently one round behind
   * whoever is writing the next one. That is not a hypothesis about this file's
   * future, it is its history — each round refused the key the previous round
   * was defeated by, and `needs:` (a dependency on a job carrying `if: false`
   * skips this job, and a skipped job does not fail a run) was green through
   * all of them. With the whole set recorded, the audit can require the job to
   * carry ONLY known-safe keys, so the next unconsidered one reddens by
   * default and gets admitted, if at all, in a diff a reviewer reads.
   *
   * THE SENTENCE ABOVE WAS FALSE UNTIL THE PARSER LANDED, in two ways at once,
   * and it is the sentence the whole inversion rests on: the indentation
   * grammar it used to be written against recorded only BARE keys, so
   * `"needs": generate-check` was not one, and it never recorded `steps:` at
   * all because that key was consumed by an earlier branch. `steps:` now
   * appears here like any other key, which is why it is in ALLOWED_JOB_KEYS.
   */
  readonly keys: readonly WorkflowJobKey[];
  /** A job-level `uses:` — a reusable-workflow call, which has no steps of its own. */
  readonly usesWorkflow: string | null;
  /** Did the job declare a `steps:` key at all? Separates "no steps" from "unreadable". */
  readonly declaresSteps: boolean;
  /**
   * A job-level `continue-on-error:`, verbatim, or null when absent.
   *
   * Kept as the raw text rather than a boolean because the finding has to be
   * able to quote what it found: `true`, an expression and an empty value are
   * three different edits and only one of them is plausibly a mistake.
   */
  readonly continueOnError: string | null;
  /** A job-level `if:`, verbatim, or null when absent. */
  readonly if: string | null;
  /** Does the job declare a `strategy:` (a matrix)? */
  readonly strategy: boolean;
  /**
   * The `runs-on:` value, rendered — a label, or a JSON array for a label set
   * or a `group:`/`labels:` mapping — or null when the job declares none.
   *
   * Recorded because the audit's own defence of admitting the key was that it
   * cannot decide whether anything runs, and that argument only covers a label
   * that does not EXIST. A label that exists and selects a busy machine is a
   * different thing: on one, four of five budgets in this job report
   * INCONCLUSIVE and their report steps exit 0 on a warning, which is the
   * "passes having measured nothing" shape this whole file is about. So the
   * value is read and checked rather than admitted unexamined.
   */
  readonly runsOn: string | null;
}

/**
 * The parsed document, or null with a REASON when this module refuses the file.
 *
 * REFUSAL IS A FINDING, NOT A GAP — and for a round that was true of the COUNT
 * and false of the MESSAGE, which is the half that decides whether a check
 * survives. A refused file yields no jobs, so the audit said `declares no `on:`
 * block this reader can find`, `has no job `generate-check``, `has no job
 * `latency-budget`` — three findings, none of them true, about a file whose
 * `on:` block and both jobs are plainly there. A maintainer sent three times to
 * look at things that are fine concludes the check is noise and deletes it. So
 * the reason travels with the refusal and every audit reports it as a refusal,
 * naming the parser's own error code and line.
 *
 * WHAT IS REFUSED, and what each citation rests on:
 *
 *   - a parse error, reported with `yaml`'s own code (`DUPLICATE_KEY`,
 *     `TAB_AS_INDENT`, `BAD_INDENT`, …). Duplicate keys and tabs-as-indentation
 *     are hard YAML errors, so no conformant parser reads such a file;
 *   - a `<<:` merge key. GitHub Actions does not support merge keys — this one
 *     survived the audit of round 6's citations — and `yaml` does not resolve
 *     them under the 1.2 core schema either, so the two disagree about the
 *     resulting mapping;
 *   - an alias with no anchor to resolve, or one that resolves through itself.
 *     A recursive anchor is a document with no finite projection;
 *   - more than one non-empty document. This reader reads one. Whether GitHub
 *     loads the first or refuses the file is NOT verifiable from this
 *     repository, and the previous version of this comment asserted it;
 *   - a root that is not a mapping.
 *
 * ANCHORS AND ALIASES ARE NOT REFUSED, and that reversal is the correction of a
 * false citation this file made five times over. GitHub Actions has supported
 * them since 2025-09-18, and its own documentation's worked example is reusing
 * an entire job configuration — the shape this reader used to reject. The cost
 * was not hypothetical: DRY-ing the five near-identical report steps below with
 * the feature GitHub recommends made this checker report three present jobs as
 * missing. They are RESOLVED here (`Reader.resolve`) rather than merely
 * tolerated, because tolerating them without resolving them reads an aliased
 * job as an empty one, which is the same false red with a different message.
 */
interface Reader {
  readonly document: Document.Parsed | null;
  /** Why the file was refused, naming the parser's own code, or null. */
  readonly refusal: string | null;
  readonly lineOf: (offset: number | undefined) => number;
  /** An alias replaced by the node it names; anything else unchanged. */
  readonly resolve: (value: unknown) => unknown;
}

/** A refusal, with `yaml`'s own vocabulary in it wherever `yaml` has one. */
function refused(lineOf: Reader['lineOf'], reason: string): Reader {
  return { document: null, refusal: reason, lineOf, resolve: (value) => value };
}

function parseWorkflowDocument(text: string): Reader {
  const lineCounter = new LineCounter();
  const lineOf = (offset: number | undefined): number => (
    offset === undefined ? 0 : lineCounter.linePos(offset).line
  );
  let documents: Document.Parsed[];
  try {
    documents = parseAllDocuments(text, { lineCounter, logLevel: 'silent' });
  } catch (error) {
    // MEASURED, rather than left as a defensive gesture: on `yaml` 2.9.0 the
    // only input that reaches here is a NON-STRING one (`TypeError: source is
    // not a string`). A BOM, lone surrogates, NUL and C1 bytes, 8 MiB scalars
    // and 8 MiB lines all parse clean; reserved indicators, unclosed flow,
    // tabs, duplicate keys, `%YAML 1.3` and 100k nesting levels all arrive in
    // `doc.errors` instead. It is kept because the alternative is this module
    // throwing out of a caller that only knows how to handle a refusal, and it
    // is EXECUTED by latency-budget-ci.test.ts through a type assertion — the
    // one admissible fixture, since a well-typed caller cannot produce one.
    return refused(lineOf, `\`yaml\` threw ${error instanceof Error ? error.message : String(error)}`);
  }
  // A trailing `---` produces a second, EMPTY document — `contents` is a null
  // SCALAR rather than `null`, which is why counting documents was not enough —
  // and refusing the file for it was a disagreement between this reader and its
  // own oracle: `parse()` reads one document with all its jobs. An empty
  // document carries no structure to disagree about, so it is dropped rather
  // than counted.
  const content = documents.filter((candidate) => (
    candidate.errors.length > 0
    || !(candidate.contents === null || (isScalar(candidate.contents) && candidate.contents.value === null))
  ));
  if (content.length === 0) return refused(lineOf, 'the file declares no YAML document with anything in it');
  if (content.length > 1) {
    return refused(
      lineOf,
      `the file contains ${content.length} YAML documents — a second one starts at line`
      + ` ${lineOf(content[1]!.range[0])} — and this reader reads one (whether GitHub loads the first or refuses`
      + ' the file is NOT verifiable from this repository, so the fail-closed answer is taken)',
    );
  }
  const document = content[0]!;
  const error = document.errors[0];
  if (error) {
    const line = error.linePos?.[0]?.line ?? lineOf(error.pos[0]);
    return refused(lineOf, `\`yaml\` reports ${error.code} at line ${line}: ${error.message.split('\n')[0]}`);
  }
  let refusal: string | null = null;
  visit(document, {
    Pair: (_key, pair) => {
      if (refusal !== null) return visit.BREAK;
      if (isScalar(pair.key) && pair.key.value === '<<') {
        refusal = `a \`<<:\` merge key at line ${lineOf(pair.key.range?.[0])}, which GitHub Actions does not`
          + ' support (anchors and aliases it does; the merge key is a separate YAML feature and is not resolved'
          + ' by this reader either, so the two would disagree about the resulting mapping)';
        return visit.BREAK;
      }
      return undefined;
    },
    Alias: (_key, node, path) => {
      if (refusal !== null) return visit.BREAK;
      const target = node.resolve(document);
      if (target === undefined) {
        refusal = `the alias \`*${node.source}\` at line ${lineOf(node.range?.[0])} names an anchor this file`
          + ' does not declare before it';
        return visit.BREAK;
      }
      if (path.includes(target as unknown as Node)) {
        refusal = `the alias \`*${node.source}\` at line ${lineOf(node.range?.[0])} resolves through itself, so`
          + ' this document has no finite reading';
        return visit.BREAK;
      }
      return undefined;
    },
  });
  if (refusal !== null) return refused(lineOf, refusal);
  if (!isMap(document.contents)) {
    return refused(lineOf, 'the document\'s root is not a mapping, so it declares no `jobs:` at all');
  }
  const resolve = (value: unknown): unknown => (isAlias(value) ? value.resolve(document) ?? null : value);
  return { document, refusal: null, lineOf, resolve };
}

/**
 * Why this module will not read `text`, or null when it will.
 *
 * Exported because a refusal has to be SAID. Every audit below asks this first
 * and reports the answer instead of the absences a refusal produces.
 */
export function workflowRefusal(text: string): string | null {
  return parseWorkflowDocument(text).refusal;
}

/** The key of a pair as a string, or null when it is not a scalar key. */
function pairKey(pair: Pair<unknown, unknown>): string | null {
  return isScalar(pair.key) ? String(pair.key.value) : null;
}

function pairKeyLine(pair: Pair<unknown, unknown>, lineOf: Reader['lineOf']): number {
  return isScalar(pair.key) ? lineOf(pair.key.range?.[0]) : 0;
}

/**
 * A node rendered for comparison and for messages.
 *
 * A scalar renders as its resolved value — so `if: false` is `'false'` and
 * `if: ${{ always() && false }}` is that expression — which is what every rule
 * below compares against. A collection renders as compact JSON, which is only
 * ever used to quote a `runs-on:` back to a maintainer. An absent value is the
 * empty string, deliberately not null: `continue-on-error:` with nothing after
 * it is a key that is PRESENT, and the rules below turn on presence.
 */
function valueText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (isScalar(value)) return value.value === null || value.value === undefined ? '' : String(value.value);
  if (isMap(value) || isSeq(value)) return JSON.stringify(value.toJSON());
  return String(value);
}

/**
 * The lines of a `run:` scalar, comment-only lines dropped.
 *
 * The scalar arrives already de-indented and already folded-or-not according
 * to its own header, which is the fidelity the indentation grammar did not
 * have: it treated `>` as if it were `|`, so a FOLDED body read as a list of
 * commands when GitHub would hand the shell one joined line. Shell `#` lines
 * are dropped here for the same reason YAML comments are dropped by the
 * parser — both are prose, and counting either as evidence that a command runs
 * is the defect this module exists to close.
 */
function runLines(scalar: string): string[] {
  const lines = scalar.split('\n');
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
  return lines.filter((line) => !line.trimStart().startsWith('#'));
}

function readStep(map: YAMLMap<unknown, unknown>, reader: Reader): WorkflowStep {
  const { lineOf, resolve } = reader;
  const env = new Map<string, string>();
  const step = {
    name: '',
    line: lineOf(map.range?.[0]),
    if: null as string | null,
    continueOnError: false,
    shell: null as string | null,
    id: null as string | null,
    uses: null as string | null,
    env,
    run: [] as string[],
  };
  for (const pair of map.items) {
    const key = pairKey(pair);
    if (key === null) continue;
    const value = resolve(pair.value);
    if (key === 'name' || key === 'uses') {
      // First one wins, and `uses:` stands in for a missing `name:` — a step
      // written as a bare `- uses: ./.github/actions/measure` still has to be
      // nameable in a finding.
      if (key === 'uses') step.uses = valueText(value);
      if (!step.name) step.name = valueText(value);
    } else if (key === 'if') {
      step.if = valueText(value);
    } else if (key === 'continue-on-error') {
      step.continueOnError = valueText(value) !== 'false';
    } else if (key === 'shell') {
      step.shell = valueText(value);
    } else if (key === 'id') {
      step.id = valueText(value);
    } else if (key === 'env') {
      if (isMap(value)) {
        for (const entry of value.items) {
          const name = pairKey(entry);
          if (name !== null) env.set(name, valueText(resolve(entry.value)));
        }
      }
    } else if (key === 'run') {
      step.run = isScalar(value) ? runLines(valueText(value)) : [];
    }
  }
  return step;
}

function readJob(pair: Pair<unknown, unknown>, reader: Reader): WorkflowJob {
  const { lineOf, resolve } = reader;
  const id = pairKey(pair) ?? '';
  const body = resolve(pair.value);
  const keys: WorkflowJobKey[] = [];
  const steps: WorkflowStep[] = [];
  const job = {
    id,
    line: pairKeyLine(pair, lineOf),
    steps,
    keys,
    usesWorkflow: null as string | null,
    declaresSteps: false,
    continueOnError: null as string | null,
    if: null as string | null,
    strategy: false,
    runsOn: null as string | null,
  };
  if (!isMap(body)) return job;
  for (const entry of body.items) {
    const key = pairKey(entry);
    if (key === null) continue;
    const value = resolve(entry.value);
    keys.push({ name: key, value: valueText(value), line: pairKeyLine(entry, lineOf) });
    // Six names are also lifted into fields of their own because callers ask
    // about them by name. A job-level `uses:` is a reusable-workflow call
    // ("this job has no steps" and "this job delegates its steps to another
    // file" want different sentences said to the maintainer);
    // `continue-on-error:`, `if:` and `strategy:` are each evaluated by GitHub
    // ABOVE everything a step can say; `runs-on:` decides the machine every
    // measurement here is taken on; `steps:` is the job. Recording only a
    // chosen few was the defect — see `WorkflowJob.keys`.
    if (key === 'uses') job.usesWorkflow = valueText(value);
    else if (key === 'continue-on-error') job.continueOnError = valueText(value);
    else if (key === 'if') job.if = valueText(value);
    else if (key === 'strategy') job.strategy = true;
    else if (key === 'runs-on') job.runsOn = valueText(value);
    else if (key === 'steps') {
      job.declaresSteps = true;
      if (isSeq(value)) {
        for (const item of value.items) {
          const step = resolve(item);
          if (isMap(step)) steps.push(readStep(step, reader));
        }
      }
    }
  }
  return job;
}

/**
 * Split a workflow into jobs and steps.
 *
 * A file this module refuses to read yields NO JOBS, which fails the audit
 * rather than passing it — and every audit asks `workflowRefusal` first, so the
 * finding says the file was refused and why, instead of reporting the jobs it
 * could not look for as missing. See `parseWorkflowDocument`.
 */
export function parseWorkflowJobs(text: string): WorkflowJob[] {
  const reader = parseWorkflowDocument(text);
  const root = reader.document?.contents;
  if (!isMap(root)) return [];
  const jobs = reader.resolve(root.items.find((pair) => pairKey(pair) === 'jobs')?.value);
  if (!isMap(jobs)) return [];
  return jobs.items.filter((pair) => pairKey(pair) !== null).map((pair) => readJob(pair, reader));
}

/** What a workflow's top-level `on:` block says. */
export interface WorkflowTriggers {
  /** Did the file declare an `on:` key this reader could find at all? */
  readonly declared: boolean;
  /** Event names, in file order, in every spelling `on:` permits. */
  readonly events: readonly string[];
  /**
   * `<event>.<key>` for every key nested under an event — `push.branches`,
   * `pull_request.paths`, and so on. A filter is not a lesser trigger: it is
   * the difference between "on every push" and "on the pushes somebody chose".
   */
  readonly filters: readonly string[];
}

/**
 * Read the workflow-level `on:` block.
 *
 * THE SHARPEST INSTANCE OF THE DEFECT THIS MODULE KEEPS HAVING, which is why
 * it is here rather than left to the reader's judgement. The audit refuses a
 * job-level `if:` on the enforcing job, and the REASON it gives is that "`on:
 * push` and `on: pull_request` at the top of the file already say when it
 * runs" — a rule citing a fact nothing verified. Replacing both triggers with
 * `workflow_dispatch:`, or attaching a `paths:` filter to each, leaves a
 * structurally perfect enforcing job that never runs on the pushes that matter,
 * and every other check in this file stays green over it.
 *
 * Every spelling, because refusing to read one is how a reader reports a file
 * with triggers as a file with none: block form (`on:` with events nested
 * under it), inline scalar (`on: push`), inline list
 * (`on: [push, pull_request]`) and block list (`on:` then `- push`). The
 * quoted key spellings (`"on":`, `'on':`) need no case of their own now — the
 * parser resolves all three to the same key, which is the whole reason it is
 * here.
 */
export function parseWorkflowTriggers(text: string): WorkflowTriggers {
  const { document, resolve } = parseWorkflowDocument(text);
  const events: string[] = [];
  const filters: string[] = [];
  const root = document?.contents;
  if (!isMap(root)) return { declared: false, events, filters };
  const on = root.items.find((pair) => pairKey(pair) === 'on');
  if (!on) return { declared: false, events, filters };

  const value = resolve(on.value);
  if (isSeq(value)) {
    for (const item of value.items) {
      const name = valueText(item);
      if (name !== '') events.push(name);
    }
  } else if (isMap(value)) {
    for (const entry of value.items) {
      const event = pairKey(entry);
      if (event === null) continue;
      events.push(event);
      // `push: { branches: [main] }` and `push: [main]` are filters written on
      // the event's own line; a nested block gives one filter per key.
      const under = resolve(entry.value);
      if (isMap(under)) {
        for (const filter of under.items) {
          const name = pairKey(filter);
          if (name !== null) filters.push(`${event}.${name}`);
        }
      } else if (under !== null && valueText(under) !== '') {
        filters.push(`${event}.<inline>`);
      }
    }
  } else {
    const name = valueText(value);
    if (name !== '') events.push(name);
  }

  return { declared: true, events, filters };
}

// ── the shell inside a `run:` body ──────────────────────────────────────────
// Everything below exists because the three questions this module has to answer
// about a `run:` body are all questions about COMMANDS, and every one of them
// was previously answered by a substring:
//
//   "does this step run <file>"        -> `echo "skipping <file>"` said yes
//   "is pipefail on before the pipe"   -> `echo "set -o pipefail"` said yes
//   "does this step swallow a failure" -> a `|| true` inside a quoted string
//                                          said yes
//
// This is not a shell. It is a tokenizer that knows quoting, comments, line
// continuations, redirections and the five list operators, which is what those
// three questions need and no more. Anything it cannot read it reports as
// unreadable, and every caller treats unreadable as a finding.

/** One command in a `run:` body, with the position and reachability facts callers need. */
export interface ShellCommand {
  /** Words with quotes removed and redirections dropped. */
  readonly words: readonly string[];
  /** First word that is not a `NAME=value` assignment, or '' for a bare assignment. */
  readonly head: string;
  /** Character offset in the joined body — the only ordering callers may use. */
  readonly at: number;
  /** Index of the pipeline this command belongs to; elements of one pipeline share it. */
  readonly pipeline: number;
  /** 0 for the first element of a pipeline. */
  readonly indexInPipeline: number;
  /** The list operator immediately before this command, '' at the start of a body. */
  readonly precededBy: '' | '|' | '&&' | '||' | ';';
  /**
   * False when an earlier element of the same `&&` chain can never succeed.
   *
   * Narrow on purpose: the literal `false` and nothing cleverer. A dead guard
   * is the cheapest way to keep a real invocation in the diff while running
   * nothing, and a checker that cannot see `false && node --test <file>` is
   * one substitution away from being defeated in the review it just passed.
   */
  readonly reachable: boolean;
}

const REDIRECTION = /^[0-9]*(?:>>?|<<?)&?[-0-9]*$/;
/** Shell keywords and negations that stand in front of the command they govern. */
const KEYWORDS = new Set(['if', '!', 'then', 'elif', 'else', 'fi', 'while', 'until', 'do', 'done', 'time']);

/**
 * Split one `run:` body into commands.
 *
 * Exported because it is the load-bearing half of three findings and deserves
 * its own cases: driving it directly is the only way to state what this module
 * believes about `echo "set -o pipefail"` without going through a workflow.
 */
export function shellCommands(body: string): ShellCommand[] {
  const out: ShellCommand[] = [];
  let words: string[] = [];
  let token = '';
  let hasToken = false;
  let start = -1;
  let pipeline = 0;
  let indexInPipeline = 0;
  let precededBy: ShellCommand['precededBy'] = '';
  /** Set when an `&&` chain has already run a command that cannot succeed. */
  let chainDead = false;

  const endToken = (): void => {
    if (hasToken) {
      words.push(token);
      token = '';
      hasToken = false;
    }
  };
  const endCommand = (operator: '|' | '&&' | '||' | ';' | 'end'): void => {
    endToken();
    // Redirections are not arguments. `npm test > "$log" 2>&1` must not read as
    // a command whose argument list contains the log, and `2>&1` carries its own
    // target while `>` takes the next word.
    const arguments_: string[] = [];
    for (let i = 0; i < words.length; i += 1) {
      const word = words[i]!;
      if (REDIRECTION.test(word)) {
        if (!word.includes('&')) i += 1;
        continue;
      }
      arguments_.push(word);
    }
    if (arguments_.length > 0) {
      // The head is the first word that is neither an assignment nor a control
      // keyword: `if ! grep …` is a grep, and `if ! node --test <file>` is an
      // invocation of the file, not of `if`.
      const head = arguments_.find((word) => !/^[A-Za-z_]\w*=/.test(word) && !KEYWORDS.has(word)) ?? '';
      out.push({ words: arguments_, head, at: start, pipeline, indexInPipeline, precededBy, reachable: !chainDead });
      if (head === 'false' && operator === '&&') chainDead = true;
    }
    words = [];
    start = -1;
    if (operator === '|') indexInPipeline += 1;
    else {
      pipeline += 1;
      indexInPipeline = 0;
    }
    if (operator === ';' || operator === 'end') chainDead = false;
    precededBy = operator === 'end' ? '' : operator;
  };

  for (let i = 0; i < body.length; i += 1) {
    const char = body[i]!;
    if (char === '\\') {
      const next = body[i + 1];
      if (next === '\n') { i += 1; continue; }
      if (next !== undefined) {
        token += next;
        hasToken = true;
        if (start < 0) start = i;
        i += 1;
        continue;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      const close = body.indexOf(char, i + 1);
      const end = close < 0 ? body.length : close;
      token += body.slice(i + 1, end);
      hasToken = true;
      if (start < 0) start = i;
      i = end;
      continue;
    }
    if (char === '$' && body[i + 1] === '(') {
      // A command substitution is one opaque word: its contents are a nested
      // shell this reader does not descend into, and treating its `|` as a
      // pipeline operator of the OUTER command would invent pipelines.
      let depth = 1;
      let j = i + 2;
      for (; j < body.length && depth > 0; j += 1) {
        if (body[j] === '(') depth += 1;
        else if (body[j] === ')') depth -= 1;
      }
      token += body.slice(i, j);
      hasToken = true;
      if (start < 0) start = i;
      i = j - 1;
      continue;
    }
    if (char === '#' && !hasToken) {
      const end = body.indexOf('\n', i);
      i = end < 0 ? body.length : end - 1;
      continue;
    }
    if (char === ' ' || char === '\t') { endToken(); continue; }
    if (char === '\n') { endCommand(';'); continue; }
    if (char === '|') {
      if (body[i + 1] === '|') { endCommand('||'); i += 1; continue; }
      endCommand('|');
      continue;
    }
    if (char === '&') {
      // `2>&1` is one redirection word, not a background `&`. Reading it as a
      // separator split `npm test 2>&1 | tee "$log"` into a command called
      // `npm test` and a pipeline whose first element was the word `1`, so the
      // pipeline that hides the suite's exit status stopped being one.
      if (hasToken && /[<>]$/.test(token)) { token += char; continue; }
      if (body[i + 1] === '&') { endCommand('&&'); i += 1; continue; }
      endCommand(';');
      continue;
    }
    if (char === ';') { endCommand(';'); continue; }
    if (char === '{' || char === '}' || char === '(' || char === ')') {
      // Group boundaries end a command without joining a pipeline. The group's
      // own pipe (`{ …; } | tee log`) is seen when the `|` is reached.
      endCommand(';');
      continue;
    }
    token += char;
    hasToken = true;
    if (start < 0) start = i;
  }
  endCommand('end');
  return out;
}

/** The joined, comment-free `run:` body of a step. */
export function stepBody(step: WorkflowStep): string {
  return step.run.join('\n');
}

/**
 * Flags that take their value as the NEXT word, so that word is not a
 * positional argument. `--test` is deliberately absent: the file after it is
 * exactly the invocation this module is looking for.
 */
const VALUE_FLAGS = new Set([
  '--import', '--require', '-r', '--loader', '--experimental-loader', '--conditions',
  '--test-reporter', '--test-reporter-destination', '--test-name-pattern', '--test-skip-pattern',
  '--test-shard', '--test-concurrency', '--test-timeout', '--env-file', '--prefix', '-e', '--eval',
]);

/** Wrapper words that pass the rest of the line through to another command. */
const WRAPPERS = new Set(['env', 'exec', 'command', 'nice', 'sudo', 'npx', 'nohup', 'stdbuf']);

/** Programs that run a test FILE named on their command line. */
const TEST_RUNNERS = new Set(['node', 'nodejs', 'bun', 'deno', 'tsx', 'vitest', 'jest', 'mocha', 'ava', 'tap']);

function basename(word: string): string {
  const slash = word.lastIndexOf('/');
  return slash < 0 ? word : word.slice(slash + 1);
}

/**
 * The positional arguments of a test-runner invocation, or null when this
 * command is not one.
 *
 * "An invocation" is the whole point: a runner reached by a reachable command,
 * with the path as an argument the runner will act on. `echo <file>`,
 * `FILE=<file>`, `# node --test <file>` and `false && node --test <file>` are
 * all commands that name the file and run nothing, and the previous version of
 * this module counted every one of them as a measurement.
 *
 * For the node family a `--test` flag is required, because `node <file>` is not
 * a test run and this repo's budgets are node:test files. Dedicated runners
 * (vitest, jest, …) need no flag: naming a file IS the invocation.
 */
function runnerArguments(command: ShellCommand): string[] | null {
  if (!command.reachable) return null;
  const words = [...command.words];
  // Leading `NAME=value` assignments, control keywords and wrapper words.
  while (words.length > 0) {
    const first = words[0]!;
    if (/^[A-Za-z_][\w]*=/.test(first) || KEYWORDS.has(first) || WRAPPERS.has(basename(first))) {
      words.shift();
      continue;
    }
    break;
  }
  if (words.length === 0) return null;
  const program = basename(words[0]!);
  if (!TEST_RUNNERS.has(program)) return null;
  const rest = words.slice(1);
  const nodeFamily = program === 'node' || program === 'nodejs' || program === 'bun' || program === 'deno';
  if (nodeFamily && !rest.some((word) => word === '--test' || word.startsWith('--test='))) return null;

  const positional: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const word = rest[i]!;
    if (word.startsWith('-')) {
      if (VALUE_FLAGS.has(word)) i += 1;
      continue;
    }
    positional.push(word);
  }
  return positional;
}

/**
 * Test files this step INVOKES: named as a positional argument of a reachable
 * test-runner command.
 *
 * A path is matched literally, `./` prefix aside. A file supplied through a
 * matrix expression, a composite action or a wrapper script is therefore not
 * seen — deliberately, and the audit's message says so instead of asserting the
 * step does not run it. That direction is the safe one: a legitimate refactor
 * gets a red with an accurate explanation and a one-line fix, while the shape
 * this module exists to catch (a step that names the file and measures nothing)
 * gets the red it earns.
 */
/**
 * A test file's extension, in every spelling `node --test` resolves.
 *
 * `.test.ts` alone made the extension a category rather than a spelling: a
 * budget file renamed to `.mts` stopped being seen as invoked, so the step
 * running it dropped out of the invoked set while the coverage rule kept
 * demanding it be there. This repo already has an `.mts` source
 * (src/runners/lighthouse/index.mts), so the rename is one a maintainer might
 * make for ordinary reasons and get an inexplicable red for.
 */
const TEST_FILE = /\.test\.(?:ts|mts|cts)$/;
const TEST_FILE_MENTION = /[\w./-]+\.test\.(?:ts|mts|cts)\b/g;

export function testFilesInvokedBy(step: WorkflowStep): string[] {
  const invoked: string[] = [];
  for (const command of shellCommands(stepBody(step))) {
    const positional = runnerArguments(command);
    if (!positional) continue;
    for (const argument of positional) {
      const normalized = argument.replace(/^\.\//, '');
      if (TEST_FILE.test(normalized)) invoked.push(normalized);
    }
  }
  return invoked;
}

/**
 * Test files MENTIONED anywhere in this step's body, invoked or not.
 *
 * For messages only. "This step names the file but never hands it to a test
 * runner" is a different sentence from "no step mentions this file at all", and
 * a maintainer reading the second when the first is true goes looking in the
 * wrong place.
 */
export function testFilesNamedBy(step: WorkflowStep): string[] {
  const named: string[] = [];
  for (const line of step.run) {
    for (const match of line.matchAll(TEST_FILE_MENTION)) named.push(match[0].replace(/^\.\//, ''));
  }
  return named;
}

/**
 * Does a command turn `pipefail` on?
 *
 * Matched on the tokenized command rather than the text, so `echo "set -o
 * pipefail"` is what it is: a step printing the name of a shell option it never
 * set. And the combined spelling counts — `set -euo pipefail` is the STRICTER
 * form, and reading it as unprotected told maintainers that the safer line was
 * the unsafe one.
 */
function enablesPipefail(command: ShellCommand): boolean {
  if (command.head !== 'set') return false;
  const words = command.words.slice(command.words.indexOf('set') + 1);
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i]!;
    if (!word.startsWith('-')) continue;
    // `-o pipefail`, `-euo pipefail`: the option letter is `o` anywhere in the
    // cluster and `pipefail` is its argument.
    if (/^-[A-Za-z]*o$/.test(word) && words[i + 1] === 'pipefail') return true;
  }
  return false;
}

/**
 * Programs whose non-zero exit is the thing a step exists to report.
 *
 * The pipefail rule is about a pipeline HIDING one of these, so the head of the
 * pipeline's first element decides whether the rule applies. Without that
 * distinction the rule flags every `grep … | awk …` in a report step, which is
 * a pipeline whose last status is exactly the one the step wants — and a
 * checker that reds on the correct shape is a checker somebody deletes.
 */
const STATUS_BEARING = new Set([
  'npm', 'pnpm', 'yarn', 'node', 'nodejs', 'bun', 'deno', 'tsx', 'go', 'pytest', 'python', 'python3',
  'make', 'cargo', 'ruff', 'playwright', 'vitest', 'jest', 'mocha', 'bash', 'sh', 'git',
]);

/** A pipeline of this step whose first element's status a later element hides. */
interface MaskedPipeline {
  /** Head program whose status is being masked. */
  readonly program: string;
  /** Offset of the pipeline's first element. */
  readonly at: number;
  /** Heads of the downstream elements, for the message. */
  readonly downstream: readonly string[];
}

function maskedPipelines(step: WorkflowStep): MaskedPipeline[] {
  const commands = shellCommands(stepBody(step));
  const masked: MaskedPipeline[] = [];
  for (const command of commands) {
    if (command.indexInPipeline !== 0) continue;
    const downstream = commands.filter((other) => (
      other.pipeline === command.pipeline && other.indexInPipeline > 0
    ));
    if (downstream.length === 0) continue;
    if (!command.reachable) continue;
    const program = basename(command.head);
    if (!STATUS_BEARING.has(program)) continue;
    masked.push({ program, at: command.at, downstream: downstream.map((other) => basename(other.head)) });
  }
  return masked;
}

function pipefailOffsets(step: WorkflowStep): number[] {
  return shellCommands(stepBody(step)).filter(enablesPipefail).map((command) => command.at);
}

/** Pipelines of this step that mask a status with no `pipefail` set before them. */
function unprotectedPipelines(step: WorkflowStep): MaskedPipeline[] {
  const enabled = pipefailOffsets(step);
  return maskedPipelines(step).filter((pipe) => !enabled.some((offset) => offset < pipe.at));
}

/**
 * Every step, in ANY job, that pipes a status-bearing command into something
 * else without `set -o pipefail` first.
 *
 * Separate from the enforcing-job audit because the exposure is not confined to
 * that job and is at its worst outside it. A shell pipeline reports the exit
 * status of its LAST command, so `npm test 2>&1 | tee "$log"` exits 0 when the
 * whole suite is red, and the report step beside it only ever asks whether the
 * expected measurements appeared in the log. Five steps in this workflow are one
 * deleted line away from certifying nothing, and until recently nothing
 * asserted the line was there.
 *
 * Widened from `| tee` to any downstream element: `| cat > log`, `| head`,
 * `| jq .` and `| tee log` mask a status identically, and there is no reason the
 * one spelling this repo happens to use should be the only one checked.
 */
export function stepsPipingWithoutPipefail(workflow: string): string[] {
  const offenders: string[] = [];
  for (const job of parseWorkflowJobs(workflow)) {
    for (const step of job.steps) {
      for (const pipe of unprotectedPipelines(step)) {
        offenders.push(
          `${job.id} / "${step.name}" (line ${step.line}): \`${pipe.program}\` piped into `
          + `\`${pipe.downstream.join('` | `')}\``,
        );
      }
    }
  }
  return offenders;
}

/**
 * Every step, in any job, whose status a pipeline masks — protected or not.
 *
 * This is the population the pipefail rule is checked against, and it exists
 * because "at least four such steps" did not do that job. The file has five;
 * the guard needed four; so exactly one could be made invisible to the reader
 * and the slack absorbed it. Callers compare this SET against the steps they
 * expect, so a step that stops being read is a missing name rather than a
 * number that still clears.
 */
export function stepsWithMaskedStatus(workflow: string): string[] {
  const found: string[] = [];
  for (const job of parseWorkflowJobs(workflow)) {
    for (const step of job.steps) {
      if (maskedPipelines(step).length > 0) found.push(`${job.id} / "${step.name}"`);
    }
  }
  return found;
}

/** The log a step's pipeline writes (`| tee <path>`), or null when it writes none. */
function logWrittenBy(step: WorkflowStep): string | null {
  const commands = shellCommands(stepBody(step));
  for (const command of commands) {
    if (command.indexInPipeline === 0) continue;
    if (basename(command.head) !== 'tee') continue;
    const target = command.words.slice(1).find((word) => !word.startsWith('-'));
    if (target) return target;
  }
  return null;
}

export interface EnforcingJobAuditOptions {
  /** Whole workflow file text. */
  readonly workflow: string;
  /** Path used in messages only. */
  readonly workflowPath: string;
  /** The job that is supposed to enforce the budgets. */
  readonly jobId: string;
  /** Repo-relative paths of every file that asserts a budget. */
  readonly budgetFiles: readonly string[];
  /**
   * Env a measurement step MUST declare when it invokes a given file.
   *
   * Passed in rather than listed here so the caller can supply the name from
   * the constant the instrument itself exports: a switch whose CI spelling is
   * a hand-typed string is one rename away from being set on nothing, which is
   * the state `T1_LATENCY_BUDGET_STRICT` was in for three rounds.
   */
  readonly requiredStepEnv?: readonly {
    readonly file: string;
    readonly name: string;
    readonly value: string;
  }[];
}

/**
 * What a report step has to demand, and why it is not the test's NAME.
 *
 * The name-shaped version of this guard was defeated by the same trick as the
 * static half, one layer down: the hollow step's `echo` printed the three test
 * names into the log, and `grep -qF "<name>"` ticked. A name is something the
 * step can say; the numbers are something only the measurement can produce. So
 * a report step must grep for the instrument's own verdict line WITH its
 * columns in it — `LATENCY BUDGET PASS · <label>  n= … wall p50/p95/max …` or
 * the INCONCLUSIVE line with `wall p95 … >= …` — and those phrases are what is
 * required here.
 *
 * Reporter-independence is the reason the requirement names the instrument's
 * columns rather than TAP: node:test defaults to `tap` on Node 22 and `spec` on
 * Node 26, so the per-test result line has two spellings and the diagnostic has
 * one.
 */
const VERDICT_EVIDENCE = /LATENCY BUDGET/;
const NUMERIC_EVIDENCE = /wall p50\/p95\/max|wall p95 /;

/**
 * The exact conditions a measurement step of the enforcing job may carry.
 *
 * A LIST OF LITERAL STRINGS, not a token scan, and the difference is a live
 * defeat: `if: ${{ !cancelled() && false }}` contains `!cancelled()`, satisfied
 * the substring form of this rule, and runs never — after which the report step
 * beside it finds no log and exits 0 by design. Any term that is false on
 * `push` and `pull_request` does the same, so there is no substring that
 * separates the honest spellings from the muted ones. An allowlist can only be
 * widened deliberately, one line at a time, in a diff a reviewer reads.
 *
 * AND AN ALLOWLISTED CONDITION IS STILL AN EXPRESSION OVER STATE. The one
 * admitted here reads a context — `steps.install.outcome` — and for two rounds
 * nothing in this repository asserted that a step with that id existed, so
 * three one-line edits left this audit fully green with all four budgets
 * unmeasured: delete the `id:` line (the context resolves to null and the
 * comparison is false), put `if: false` on the install step, or give it any
 * other condition that skips (a skipped step's outcome is `skipped`). The
 * install-FAILURE route was never the hole — a failed step carrying no
 * continue-on-error fails the job — the step's identity and reachability were.
 * `stepContextReferences` below is how every id an admitted condition names is
 * now checked to exist, to run before the measurement, and to be unskippable.
 */
const MEASUREMENT_CONDITIONS: readonly string[] = [
  "${{ !cancelled() && steps.install.outcome == 'success' }}",
];

/**
 * The exact conditions a REPORT step of the enforcing job may carry.
 *
 * Same rule as above and for the same reason. `always()` was checked as a
 * SUBSTRING, so `if: ${{ always() && false }}` was an admitted report step that
 * never runs — and a report step that never runs is precisely the hollow green
 * it was written to refuse, because the measurement it reports on can then be
 * absent with nothing left to notice.
 */
const REPORT_CONDITIONS: readonly string[] = ['always()'];

/**
 * Keys the enforcing job may carry at job level. AN ALLOWLIST, deliberately.
 *
 * Enumerating the FORBIDDEN keys is always one round behind whoever writes the
 * next one, which is this file's actual history: `continue-on-error:` and `if:`
 * were added after they were used, `strategy:` after that, and `needs:` — a
 * dependency on a job carrying `if: false` skips this job, and a skipped job
 * does not fail a run; a dependency on the fast job un-enforces every budget on
 * every run where that job is red — was green through all three rounds. So the
 * question is inverted: the job must carry only these four, and anything else
 * is a finding until somebody adds it here on purpose.
 *
 * Why each of these four is safe:
 *
 *   - `name:` is display text. It cannot decide whether anything runs.
 *   - `runs-on:` selects the machine, and it is admitted only with its VALUE
 *     CHECKED — see REQUIRED_RUNNER_LABEL, which is where the argument for it
 *     now lives, because the argument that used to be here was aimed at the
 *     wrong failure.
 *   - `timeout-minutes:` can only cut a run short, i.e. make it red.
 *   - `steps:` is the job. It is in this list because the reader now records
 *     it like any other key; the grammar that preceded the parser consumed it
 *     in a branch of its own and never put it in `keys` at all.
 *
 * `uses:` is not here because a job-level `uses:` is a reusable-workflow call
 * and gets its own, earlier, "this is a limit of this check" answer.
 */
const ALLOWED_JOB_KEYS: readonly string[] = ['name', 'runs-on', 'timeout-minutes', 'steps'];

/**
 * The runner this job's measurements have to be taken on, as a VALUE and not
 * as a key that is merely permitted.
 *
 * WHY A PIN, AND WHAT THE PREVIOUS ARGUMENT MISSED. Admitting `runs-on:`
 * unexamined was defended with "a label that does not exist leaves the job
 * queued and the check pending, which is not a green". That is true of a
 * NONEXISTENT label — GitHub queues such a job for up to 24 hours and then
 * cancels it — and it is an answer to the wrong question. A label that EXISTS
 * and selects a busy machine is the case that matters here: `runs-on:
 * [self-hosted, linux, shared]` is a green audit today, and on a shared runner
 * four of this job's five budgets report INCONCLUSIVE with their report steps
 * exiting 0 on a warning, which is exactly the "passes having measured
 * nothing" this whole file exists for. Deleting the key entirely was green
 * too. The value was never read.
 *
 * So this job pins its runner, and what the pin protects is the IDLE-RUNNER
 * PREMISE every other rule here rests on: one file, alone, on a machine that
 * has done nothing else. A GitHub-hosted `ubuntu-latest` is a fresh VM per
 * job; a self-hosted or reused runner is not, and the difference is not
 * visible in any verdict this job prints — an inconclusive verdict looks the
 * same whatever made the machine busy.
 *
 * AND THE SENTENCE THAT IS NOW AN ASSUMPTION RATHER THAN A CLAIM. "Pending is
 * not a green" depends on whether this check is REQUIRED, which is a
 * server-side branch-protection setting: `.github/` in this repository holds
 * two workflow files, no ruleset, no CODEOWNERS, no branch-protection
 * export. A rule citing a fact unverifiable from the repository, inside a
 * checker whose doctrine is that a rule must verify what it cites, is the
 * defect this file keeps having. It is recorded here as an assumption, it is
 * not load-bearing for anything below, and the pin above does not depend on
 * it.
 */
const REQUIRED_RUNNER_LABEL = 'ubuntu-latest';

/** Job keys refused with a message of their own, so the allowlist does not double-report them. */
const SEPARATELY_REFUSED_JOB_KEYS: readonly string[] = ['continue-on-error', 'if', 'strategy'];

/**
 * The events this workflow must fire on, and the fact the job-level `if:`
 * refusal below rests on. See `parseWorkflowTriggers`.
 */
const REQUIRED_TRIGGERS: readonly string[] = ['pull_request', 'push'];

/**
 * The one finding a refused file produces, in place of the absences it causes.
 *
 * WHAT THIS REPLACES. A refusal makes `parseWorkflowJobs` return nothing, and
 * every audit then reported what it could not find: three sentences saying the
 * `on:` block and both jobs are missing, about a file containing all three.
 * The maintainer who tripped it was DRY-ing five duplicated report steps with
 * YAML anchors — a feature GitHub Actions has supported since 2025-09-18 and
 * documents — and the three findings pointed at everything except the reason.
 * A check that lies about a file is deleted, and deserves to be.
 *
 * So: one finding, naming the parser's own code and line, saying plainly that
 * NOTHING was checked. `subject` is what this particular audit would have been
 * checking, so the three that run over one file each say which question went
 * unanswered rather than repeating one sentence three times.
 */
function refusalFinding(workflow: string, workflowPath: string, subject: string): string | null {
  const refusal = workflowRefusal(workflow);
  if (refusal === null) return null;
  return `${workflowPath} was REFUSED by this checker, not audited: ${refusal}. Nothing was checked — not`
    + ` ${subject} — so this finding is not a claim that anything in the file is missing or wrong; the jobs and`
    + ' steps it declares may all be present and correct. Either fix the spelling named above, or, if GitHub'
    + ' accepts it and this reader should too, widen src/test-support/__tests__/ci-workflow.ts and add the case'
    + ' to READER_CORPUS in the same commit.';
}

/** `steps.<id>.<property>` references inside an `if:` expression. */
function stepContextReferences(expression: string): { id: string; property: string }[] {
  const found: { id: string; property: string }[] = [];
  for (const match of expression.matchAll(/\bsteps\.([A-Za-z_][\w-]*)\.([A-Za-z_][\w-]*)/g)) {
    found.push({ id: match[1]!, property: match[2]! });
  }
  return found;
}

/**
 * The shell every measurement and report step of the enforcing job must declare.
 *
 * GitHub runs `shell: bash` as `bash --noprofile --norc -eo pipefail {0}`, and
 * the harness that PROVES these report bodies behave (latency-budget-ci.test.ts
 * executes them) runs them exactly that way. Under the runner default
 * (`bash -e {0}`, no pipefail) or under `shell: sh` the same body takes
 * different exits — measured on the committed hook-timing body, where the
 * divergence is an annotation that CI never prints. So the declaration is part
 * of what the proof is about, and a step that drops it has moved out from under
 * its own evidence.
 */
const REQUIRED_SHELL = 'bash';

/**
 * Everything wrong with the enforcing job, as a list of sentences. Empty means
 * the job really invokes every budget file, in a step that can fail, with its
 * own report step able to fail on its behalf.
 *
 * Returned rather than asserted so the caller can drive this against a
 * SYNTHETIC workflow and require a non-empty answer — a checker that cannot be
 * shown failing on a hollow workflow is not a checker, and the hollow workflow
 * is the case that motivated this file.
 */
/**
 * The trigger block, which is a FACT THE JOB AUDIT'S OWN REFUSAL CITES.
 *
 * Separate from `auditEnforcingJob` and run beside it, because a perfect
 * enforcing job in a file that never runs measures exactly as much as a hollow
 * one — and because the refusal of a job-level `if:` is justified in this
 * module's own words by "the triggers at the top of the file already say when
 * it runs". Those triggers are part of this check or that sentence is
 * decoration.
 */
export function auditWorkflowTriggers(
  options: { readonly workflow: string; readonly workflowPath: string; readonly jobId: string },
): string[] {
  const { workflow, workflowPath, jobId } = options;
  const refusal = refusalFinding(workflow, workflowPath, `when the \`${jobId}\` job runs`);
  if (refusal) return [refusal];
  const findings: string[] = [];
  const triggers = parseWorkflowTriggers(workflow);
  const events = [...triggers.events].sort();
  if (!triggers.declared) {
    findings.push(
      `${workflowPath} declares no \`on:\` block this reader can find, so nothing here says when the`
      + ` \`${jobId}\` job runs — and a job that never runs enforces nothing while every other check in`
      + ' this file stays green over it.',
    );
  } else if (events.join(',') !== REQUIRED_TRIGGERS.join(',')) {
    findings.push(
      `${workflowPath} fires on ${events.map((event) => `\`${event}\``).join(', ') || '(no event)'} rather than`
      + ` on exactly ${REQUIRED_TRIGGERS.map((event) => `\`${event}\``).join(' and ')}. Every budget in this repo`
      + ` is enforced in the \`${jobId}\` job of this file, and swapping these triggers for a manual one leaves`
      + ' that job structurally perfect and never executed on the pushes that matter. This is also the fact the'
      + ' job-level `if:` refusal below rests on: that refusal says the job needs no condition BECAUSE the'
      + ' triggers already say when it runs, so the two rules stand or fall together.',
    );
  }
  if (triggers.filters.length > 0) {
    findings.push(
      `${workflowPath} attaches ${triggers.filters.map((filter) => `\`${filter}\``).join(', ')} to its triggers.`
      + ' A path or branch filter is the same self-mute as a manual trigger with a smaller blast radius: the'
      + ` \`${jobId}\` job then runs on the pushes somebody chose rather than on the pushes that happen, and a`
      + ' change that breaches a budget without touching a filtered path is merged green.',
    );
  }
  return findings;
}

/**
 * Keys the job that RUNS THIS CHECKER may carry. A second allowlist, because
 * the two jobs are not the same shape.
 *
 * `strategy:` is here and refused there: the checker's matrix over
 * `ubuntu-latest` and `macos-latest` is the point of that job (`golden:update`
 * is a maintainer command run on macOS and nothing used to hash the tree
 * anywhere but ubuntu), whereas a matrix over the ENFORCING job would take its
 * measurements on more than one runner at once. `runs-on:` is here without a
 * pinned value for the same reason: the checker's runner is a matrix
 * expression, and no idle-runner premise rests on it.
 */
const ALLOWED_CHECKER_JOB_KEYS: readonly string[] = ['name', 'runs-on', 'strategy', 'timeout-minutes', 'steps'];

/** Wrapper words in front of a package-manager invocation of the suite. */
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn']);

/**
 * Every reachable invocation of the suite in this step, with what it passes on.
 *
 * THE ARGUMENTS ARE THE POINT, and recording them is the fix for a defeat that
 * is strictly cheaper than the ones this audit already refuses. `npm test --
 * --test-name-pattern='zzzz-no-such-test'` and `npm test -- --test-only` both
 * satisfy "a step reachably runs the suite" and both run NOTHING: measured on
 * Node 26.5.0 against a file containing one FAILING test, each exits 0 and
 * prints `tests 1 / pass 1 / fail 0`, so the suite is silenced and the log
 * looks like a green run. (CI pins Node 22; that version is unmeasured here.)
 * A denylist of filter flags would be the shape this file keeps being defeated
 * by, so the invocation must carry NOTHING beyond the script name and anything
 * else is refused for being unconsidered — including a flag in front of the
 * script name, which stops being an invocation this function can vouch for and
 * is reported by its ABSENCE instead.
 */
function suiteInvocations(step: WorkflowStep, script: string): { readonly extra: readonly string[] }[] {
  const found: { extra: readonly string[] }[] = [];
  for (const command of shellCommands(stepBody(step))) {
    if (!command.reachable) continue;
    // `2>&1` is a word of the command and not an argument of the script. It is
    // on the committed line, so counting it as an extra argument would refuse
    // the file this audit is written about.
    const words = command.words.filter((word) => !/^\d*(?:>>?|<)/.test(word));
    while (words.length > 0 && (
      KEYWORDS.has(words[0]!) || WRAPPERS.has(basename(words[0]!)) || /^[A-Za-z_]\w*=/.test(words[0]!)
    )) words.shift();
    if (!PACKAGE_MANAGERS.has(basename(words[0] ?? ''))) continue;
    // `npm test` and `npm run test` are the same invocation; `npm run build`
    // is neither, and `npm --silent test` is not one this function recognises.
    const rest = words[1] === 'run' ? words.slice(2) : words.slice(1);
    if (rest[0] !== script) continue;
    found.push({ extra: rest.slice(1) });
  }
  return found;
}

/** Does this step reachably run the whole suite (`npm test` and its spellings)? */
function runsSuiteScript(step: WorkflowStep, script: string): boolean {
  return suiteInvocations(step, script).length > 0;
}

/**
 * Evidence that a body REFUSES a suite that ran (almost) nothing.
 *
 * The static half above can only see the workflow. A filter reaching the runner
 * from anywhere else — the `test` script in package.json, `NODE_OPTIONS`, an
 * `.npmrc` — produces the same silent green and no workflow rule can see it.
 * The log can: the runner prints its own count, and a suite of thousands
 * reporting a few hundred passes did not run. So the count is the closure, and
 * this is what the job must contain for the closure to exist.
 */
const SUITE_COUNT_EVIDENCE = /\bpass\b/;
const COUNT_FLOOR_EVIDENCE = /-lt\b|-le\b/;

export interface CheckerJobAuditOptions {
  readonly workflow: string;
  readonly workflowPath: string;
  /** The job whose steps run the suite this file belongs to. */
  readonly jobId: string;
  /** The package script that runs that suite. */
  readonly suiteScript: string;
}

/**
 * The job that runs this checker, held to the same job-level discipline.
 *
 * WHY THIS EXISTS, AND WHERE THE RECURSION ACTUALLY STOPS. Something runs the
 * audit above, and until now nothing said anything about it: `auditEnforcingJob`
 * was only ever called for `latency-budget`, and the one assertion that named
 * the checker's own job asserted that the job NAMES exist and nothing about
 * what they carry. Two measured defeats, both unquoted, both fully green
 * against the committed suite: `continue-on-error: true` on the checker job
 * (`npm test` reds, the job reds, the RUN is green, so every rule in this file
 * is evaluated and none of them can fail anything), and `if: github.event_name
 * == 'workflow_dispatch'` on the checker job (it never runs on a push).
 *
 * Round 5 moved no boundary and added rules inside the one round 4 drew. This
 * moves it out by one and then STOPS, and the stopping point is an argument
 * rather than an omission:
 *
 *   - the first defeat is closed HERE, completely. A job carrying
 *     `continue-on-error:`, `needs:`, or any unconsidered key still RUNS, so
 *     this audit runs inside it, so the finding is produced on the very push
 *     that introduces the key.
 *   - the second is closed only PARTLY, and no rule in any repository can close
 *     it fully. A job switched off by a condition that is false on `push` and
 *     `pull_request` does not run the checker that would object, so the objection
 *     cannot be raised on the push that introduces it. What the rule below does
 *     buy is every condition that is SOMETIMES true — the job runs on those
 *     occasions and reds — and a refusal that a reviewer reads in the diff.
 *     What is left is not a hole this file can plug: whether a check that never
 *     reported blocks a merge is branch-protection configuration, which is
 *     server-side and is not in this repository. That is the same limit the
 *     `runs-on:` pin records, and it is stated in both places rather than
 *     assumed in either.
 *
 * AND THE BOUNDARY WAS DRAWN ON THE WRONG AXIS, which is the round-6 finding
 * this version answers. The two defeats above are both JOB-level, and job-level
 * coverage here became exhaustive (an allowlist over every key the parser
 * records — `permissions:` and `env:` are refused with the right message). The
 * residual had moved to which STEP keys decide execution, and four one-line
 * edits to the suite step were measured fully green against the committed file:
 * `if: false`, `if: ${{ github.event_name == 'workflow_dispatch' }}`,
 * `npm test -- --test-name-pattern='zzzz-no-such-test'`, `npm test --
 * --test-only`. The full residual, by construction rather than by example:
 *
 *   (a) a JOB-level condition false on push and pull_request — refused on
 *       presence, unclosable at introduction, as argued above;
 *   (b) a STEP-level condition on the suite step — the same shape one level in,
 *       strictly cheaper, and not refused at all until now. Refused on presence
 *       below, with the same residual as (a) and no more;
 *   (c) a runner-level FILTER — and this one is CLOSABLE, because the runner
 *       prints its own count and a suite that ran nothing says so. Closed in
 *       two places: the invocation must be bare (this file), and the log must
 *       show a plausible pass count (a step of the job, required below), which
 *       also catches a filter arriving from package.json or `NODE_OPTIONS`
 *       where no workflow rule can see it;
 *   (d) deleting this file, which is the fixed point below.
 *
 * There is no third level. This job runs the suite that contains this function,
 * so the checker checks the job that runs it; that is a fixed point, not a
 * regress, and the one thing it cannot observe is its own absence.
 */
export function auditCheckerJob(options: CheckerJobAuditOptions): string[] {
  const { workflow, workflowPath, jobId, suiteScript } = options;
  const refusal = refusalFinding(workflow, workflowPath, `whether \`npm ${suiteScript}\` runs and can fail`);
  if (refusal) return [refusal];
  const findings: string[] = [];
  const job = parseWorkflowJobs(workflow).find((candidate) => candidate.id === jobId);
  if (!job) {
    return [
      `${workflowPath} has no job \`${jobId}\`. That job is where \`${suiteScript}\` runs, and this whole file is`
      + ' one test inside it: with the job gone, every rule here is written down and none of them is evaluated.',
    ];
  }

  const runners = job.steps.filter((step) => runsSuiteScript(step, suiteScript));
  if (runners.length === 0) {
    findings.push(
      `${workflowPath} job \`${jobId}\` has no step that reachably runs \`npm ${suiteScript}\`, so nothing in CI`
      + ' executes the audit in this file. Naming it is not running it — an `echo`, a comment or a `false &&`'
      + ' guard leaves the command in the diff and runs nothing.',
    );
  }
  for (const step of runners) {
    if (step.continueOnError) {
      findings.push(
        `${workflowPath} job \`${jobId}\` step "${step.name}" (line ${step.line}) runs the suite with`
        + ' `continue-on-error`, so a red suite cannot fail the job and every rule in this file is evaluated with'
        + ' nothing riding on the answer.',
      );
    }
    const swallowed = shellCommands(stepBody(step)).some((command) => (
      command.precededBy === '||' && (command.head === 'true' || command.head === ':')
    ));
    if (swallowed) {
      findings.push(
        `${workflowPath} job \`${jobId}\` step "${step.name}" (line ${step.line}) swallows the suite's failure`
        + ' with `|| true`.',
      );
    }
    // ── the STEP axis, which is where the defeat moved ────────────────────────
    // Job-level coverage here is exhaustive (an allowlist over every key the
    // parser records). The keys that were never read are the STEP's, and they
    // decide execution just as completely: `if: false` on this one step, or
    // `if: ${{ github.event_name == 'workflow_dispatch' }}`, leaves the job
    // running, every job-level rule satisfied, and the suite unrun — measured,
    // zero findings, against the committed file. The enforcing job holds its
    // measurement steps to a literal `if:` allowlist for exactly this reason;
    // the rule existed one job over and was never carried across.
    if (step.if !== null) {
      findings.push(
        `${workflowPath} job \`${jobId}\` step "${step.name}" (line ${step.line}) carries \`if: ${step.if}\`, and`
        + ` that condition decides whether \`npm ${suiteScript}\` — the only execution this whole file gets —`
        + ' runs at all. REFUSED ON PRESENCE, for the reason the job-level condition above it is: a condition is'
        + ' an expression language, so an allowlist of "safe" ones has to rule on `${{ always() && false }}`, and'
        + ' every widening of it is somewhere to hide a term that is false on `push`. This step needs no'
        + ' condition — the job it is in already has none, and the triggers say when that runs.',
      );
    }
    for (const invocation of suiteInvocations(step, suiteScript)) {
      if (invocation.extra.length === 0) continue;
      // `--test-shard=N/M` partitions the suite. `--test-concurrency=N`
      // overlaps the per-file Node+tsx processes (default on a 2-vCPU
      // Windows runner is 1, which is why each shard sat at ~30m). Neither
      // is a silent-green filter. `--` is npm's operand separator.
      // Anything else (`--test-only`, a name pattern) stays refused.
      const extras = invocation.extra.filter((word) => word !== '--');
      if (extras.length > 0 && extras.every((word) => (
        /^--test-shard=/.test(word) || /^--test-concurrency=\d+$/.test(word)
      ))) continue;
      findings.push(
        `${workflowPath} job \`${jobId}\` step "${step.name}" (line ${step.line}) passes`
        + ` \`${invocation.extra.join(' ')}\` to \`npm ${suiteScript}\`. The suite is invoked BARE here or not at`
        + ' all: a runner-level filter (`--test-name-pattern`, `--test-only`, a narrowed glob) makes the command'
        + ' exit 0 having run nothing while printing a green summary — measured on Node 26.5.0, a file holding'
        + ' one FAILING test reports `tests 1 / pass 1 / fail 0` under either flag. Refused for being'
        + ' unconsidered rather than for being known-bad, because a list of forbidden flags is a list of the'
        + ' ones somebody was already defeated by, and the next runner release adds another.',
      );
    }
  }

  // ── and the same defeat arriving from OUTSIDE the workflow ────────────────
  // A filter can also come from the `test` script in package.json, from
  // `NODE_OPTIONS`, or from an `.npmrc`, and no rule about this file can see
  // any of them. The runner's own summary can: a suite of thousands reporting a
  // few hundred passes did not run. That check is the only closable member of
  // the residual, so it is required rather than recommended.
  const suiteLogs = runners.map((step) => logWrittenBy(step)).filter((log): log is string => log !== null);
  if (runners.length > 0 && suiteLogs.length === 0) {
    findings.push(
      `${workflowPath} job \`${jobId}\` runs \`npm ${suiteScript}\` without teeing it to a log, so nothing`
      + ' afterwards can check that the suite RAN rather than being filtered down to nothing.',
    );
  }
  for (const log of suiteLogs) {
    const proves = job.steps.some((step) => {
      const body = stepBody(step);
      return body.includes(log)
        && body.includes('did not run::')
        && /\bexit 1\b/.test(body)
        && SUITE_COUNT_EVIDENCE.test(body)
        && COUNT_FLOOR_EVIDENCE.test(body);
    });
    if (proves) continue;
    findings.push(
      `${workflowPath} job \`${jobId}\` writes the suite log ${log} and no step of the job holds it to a MINIMUM`
      + ' COUNT. A step is needed that reads that log, takes the runner\'s own `pass` count, compares it against'
      + ' a floor (`-lt`), and `exit 1`s with a `did not run::` annotation when it is short. Without it the'
      + ' cheapest defeat of this whole file is a filter flag the workflow never mentions — in the `test` script,'
      + ' in `NODE_OPTIONS`, in an `.npmrc` — after which the command exits 0, the log reads green, and every'
      + ' rule here is evaluated over a suite that ran nothing.',
    );
  }

  for (const key of job.keys) {
    if (ALLOWED_CHECKER_JOB_KEYS.includes(key.name) || SEPARATELY_REFUSED_JOB_KEYS.includes(key.name)) continue;
    findings.push(
      `${workflowPath} job \`${jobId}\` carries a job-level \`${key.name}:\` (line ${key.line}), which is not one of`
      + ` the keys the job running \`npm ${suiteScript}\` may have`
      + ` (${ALLOWED_CHECKER_JOB_KEYS.map((one) => `\`${one}\``).join(', ')}). Refused for being unconsidered, for`
      + ' the same reason the enforcing job\'s list is an allowlist: a list of forbidden keys only ever contains'
      + ' the ones somebody was already defeated by.',
    );
  }
  if (job.continueOnError !== null && job.continueOnError !== 'false') {
    findings.push(
      `${workflowPath} job \`${jobId}\` sets a JOB-LEVEL \`continue-on-error: ${job.continueOnError}\` (line`
      + ` ${job.line}). Every step runs, \`npm ${suiteScript}\` still reds, the job still reds — and the RUN is`
      + ' green, because a failed job that continues on error does not fail the run. So every rule in this file is'
      + ' evaluated on every push and none of them can fail anything. One line, no step touched.',
    );
  }
  if (job.if !== null) {
    findings.push(
      `${workflowPath} job \`${jobId}\` carries a JOB-LEVEL \`if: ${job.if}\` (line ${job.line}), which decides`
      + ` whether \`npm ${suiteScript}\` runs at all. Refused on presence: this job needs no condition, because the`
      + ' triggers at the top of the file already say when it runs, and that is asserted by auditWorkflowTriggers'
      + ' rather than assumed. Note what this rule can and cannot do — a condition that is never true on `push`'
      + ' or `pull_request` skips this job, and a skipped job does not run the check that would object, so the'
      + ' finding cannot be raised on the push that introduces it. It is raised on any run where the condition'
      + ' does hold, and it is a refusal a reviewer reads in the diff.',
    );
  }
  if (job.strategy) {
    // A matrix is legitimate here and an EMPTY one is the third spelling of
    // "this job does not run": `include: []` is valid Actions and produces zero
    // job instances, with every step below still reading as fine.
    const declared = job.keys.find((key) => key.name === 'strategy')?.value ?? '';
    let matrixEntries = 0;
    try {
      const matrix = (JSON.parse(declared) as { matrix?: Record<string, unknown> }).matrix;
      if (matrix && typeof matrix === 'object') {
        for (const value of Object.values(matrix)) if (Array.isArray(value) && value.length > 0) matrixEntries += 1;
      }
    } catch { matrixEntries = 0; }
    if (matrixEntries === 0) {
      findings.push(
        `${workflowPath} job \`${jobId}\` declares a \`strategy:\` (line ${job.line}) with no non-empty matrix`
        + ` dimension (\`${declared}\`). An empty matrix — \`include: []\` is valid — produces ZERO job instances,`
        + ` so \`npm ${suiteScript}\` runs zero times while every step below still reads as fine.`,
      );
    }
  }
  return findings;
}

export function auditEnforcingJob(options: EnforcingJobAuditOptions): string[] {
  const { workflow, workflowPath, jobId, budgetFiles } = options;
  const refusal = refusalFinding(workflow, workflowPath, `whether \`${jobId}\` measures anything`);
  if (refusal) return [refusal];
  const requiredStepEnv = options.requiredStepEnv ?? [];
  const findings: string[] = [];

  const job = parseWorkflowJobs(workflow).find((candidate) => candidate.id === jobId);
  if (!job) {
    return [
      `${workflowPath} has no job \`${jobId}\`. That job is where every latency budget in this repo is`
      + ' enforced; renaming or deleting it un-enforces all of them at once. If it moved, point this'
      + ' check at the new name.',
    ];
  }
  if (job.usesWorkflow !== null) {
    return [
      `${workflowPath} job \`${jobId}\` delegates to the reusable workflow \`${job.usesWorkflow}\`, so its`
      + ' measurements are not steps in this file and this check cannot follow them. That is a limit of this'
      + ' check, not a defect in the workflow: point it at the called file, or keep the measurement steps here.',
    ];
  }
  if (job.steps.length === 0) {
    return [
      `${workflowPath} job \`${jobId}\` has zero steps`
      + `${job.declaresSteps ? ' under its `steps:` key, which this reader could not read' : ' and no `steps:` key'}`
      + ' — either way nothing in it can measure anything, which is not a pass.',
    ];
  }

  // ── the keys that sit ABOVE every step property below ─────────────────────
  // Checked first because when one of these is set, nothing further down means
  // anything: the steps can be perfect and the job still enforces nothing.
  //
  // An ALLOWLIST, and the inversion is the fix for the pattern this file kept
  // repeating — three rounds of naming the key that defeated the previous
  // round, while `needs:` sat unread through all of them. Three names still get
  // a message of their own below, because what each of them does is worth a
  // sentence; everything else is refused here for being unconsidered rather
  // than for being known-bad.
  for (const key of job.keys) {
    if (ALLOWED_JOB_KEYS.includes(key.name) || SEPARATELY_REFUSED_JOB_KEYS.includes(key.name)) continue;
    const needs = key.name === 'needs'
      ? ' `needs:` in particular is not a lesser key than the three named above: a dependency that is SKIPPED'
        + ' skips this job too, and a skipped job does not fail a run, so `needs: <a job carrying `if: false`>`'
        + ' is the job-level `if:` defeat with an extra hop. Depending on the fast job additionally un-enforces'
        + ' every budget on every run where that job is red — which is also the moment this job is most worth'
        + ' having, and it destroys the idle-runner property the job exists for.'
      : '';
    findings.push(
      `${workflowPath} job \`${jobId}\` carries a job-level \`${key.name}:\` (line ${key.line}), which is not one`
      + ` of the keys this job may have (${ALLOWED_JOB_KEYS.map((one) => `\`${one}\``).join(', ')}).${needs}`
      + ' REFUSED FOR BEING UNCONSIDERED, not for being known-bad, and that is the whole point of the rule: a'
      + ' list of forbidden keys can only ever contain the ones somebody was already defeated by, which is the'
      + ' history of this check. If this key is safe here, add it to ALLOWED_JOB_KEYS with the reason it cannot'
      + ' decide whether these measurements happen — one line, in a diff a reviewer reads.',
    );
  }
  if (job.runsOn !== REQUIRED_RUNNER_LABEL) {
    findings.push(
      `${workflowPath} job \`${jobId}\` ${job.runsOn === null ? 'declares no `runs-on:`' : `runs on \`${job.runsOn}\``}`
      + ` rather than on \`${REQUIRED_RUNNER_LABEL}\`. Every rule in this audit rests on ONE premise about this`
      + ' job — one file at a time, alone, on a machine that has done nothing else — and the runner label is the'
      + ' only thing that decides it. A GitHub-hosted `ubuntu-latest` is a fresh VM per job; a self-hosted or'
      + ' shared label selects a machine with a history, and on one of those four of the five budgets here report'
      + ' INCONCLUSIVE while their report steps exit 0 on a warning by design, which is this job passing having'
      + ' measured nothing. The value was previously admitted unread, on the argument that a label that does not'
      + ' EXIST leaves the check pending; that argument does not reach a label that exists and is busy.',
    );
  }
  if (job.continueOnError !== null && job.continueOnError !== 'false') {
    findings.push(
      `${workflowPath} job \`${jobId}\` sets a JOB-LEVEL \`continue-on-error: ${job.continueOnError}\` (line`
      + ` ${job.line}). Every step still runs and every report step still exits 1 — and the workflow is green`
      + ' anyway, because a failed job that continues on error does not fail the run. This is the strongest'
      + ' self-mute available here: it needs no edit to any step, so every per-step property this check'
      + ' verifies stays exactly as it is. Delete the key; there is no value of it this job can carry.',
    );
  }
  if (job.if !== null) {
    findings.push(
      `${workflowPath} job \`${jobId}\` carries a JOB-LEVEL \`if: ${job.if}\` (line ${job.line}), which decides`
      + ' whether ANY of its steps run at all. A condition restricting it to manual dispatch, or one that is'
      + ' simply never true, skips the whole job and leaves this audit with nothing to object to and the report'
      + ' steps with no log to read. REFUSED ON PRESENCE, not on what it evaluates to, and that is a choice'
      + ' between two honest rules: a condition is an expression language — `&&`, `||`, function calls, context'
      + ' objects — so an allowlist of "safe" expressions has to rule on things like'
      + " `always() && github.event_name != 'schedule'`, and every widening of it is somewhere to hide a `&&"
      + ' false`. This job needs no condition: `on: push` and `on: pull_request` at the top of the file already'
      + ' say when it runs — and that is asserted rather than assumed, by auditWorkflowTriggers, which is where'
      + ' this sentence used to point without anything checking it. If a condition ever becomes necessary, the'
      + ' argument for it belongs in this check, next to the reason the job exists.',
    );
  }
  if (job.strategy) {
    findings.push(
      `${workflowPath} job \`${jobId}\` declares a \`strategy:\` (line ${job.line}). A matrix over the ENFORCING`
      + ' job has no correct setting: more than one entry runs these measurements on more than one runner at'
      + ' once, which is precisely the contention the job exists to avoid, and an EMPTY one (`include: []` is'
      + ' valid) runs them zero times while every step below still reads as fine. Refused on presence, for the'
      + ' same reason the `if:` above is.',
    );
  }

  const runners = new Map<string, WorkflowStep[]>();
  for (const step of job.steps) {
    for (const file of testFilesInvokedBy(step)) {
      if (!budgetFiles.includes(file)) continue;
      const list = runners.get(file) ?? [];
      list.push(step);
      runners.set(file, list);
    }
  }

  for (const file of budgetFiles) {
    if (runners.has(file)) continue;
    const mentions = job.steps.filter((step) => testFilesNamedBy(step).includes(file));
    // Only LOCAL composite actions are worth naming here. Every job in this
    // repo starts with `actions/checkout` and `actions/setup-node`, and a hint
    // that one of those might be running a budget file is noise wearing the
    // shape of help.
    const usesActions = job.steps.filter((step) => step.uses !== null && step.uses.startsWith('./'));
    const named = mentions.length > 0
      ? ` The name appears in ${mentions.map((step) => `"${step.name}" (line ${step.line})`).join(', ')},`
        + ' but not as an argument to a test runner — an `echo`, a comment or an unused variable names a file'
        + ' without running it.'
      : '';
    const indirect = usesActions.length > 0
      ? ` This job calls the local action(s) ${usesActions.map((step) => `\`${step.uses}\``).join(', ')}; if one of`
        + ' them runs this file, this check cannot see inside it.'
      : '';
    findings.push(
      `${file} asserts a latency budget that no step of \`${jobId}\` INVOKES — no reachable command in the job`
      + ` hands this path to a test runner.${named}${indirect} It still runs inside \`npm test\`, but on that path`
      + ' an INCONCLUSIVE verdict is a skip and the workflow step over the suite log only warns —'
      + ' deliberately, because a 2-vCPU runner executing the parallel suite is inside the inconclusive region'
      + ` by construction. FIX: add a step to \`${jobId}\` in ${workflowPath} that runs this file alone, naming`
      + ' the path literally (a matrix expression, a composite action or a wrapper script is invisible here),'
      + ' and a report step beside it that fails when the measurement did not happen. Do NOT make the parallel'
      + ' path strict: that is red on every push for a reason no code change can fix.',
    );
  }

  const measurements = job.steps.filter((step) => testFilesInvokedBy(step).some((file) => budgetFiles.includes(file)));

  for (const step of job.steps) {
    if (step.continueOnError) {
      findings.push(`\`${jobId}\` step "${step.name}" (line ${step.line}) sets continue-on-error, so its failure`
        + ' cannot fail the job.');
    }
    // `|| true` as a COMMAND, not as a substring: the string `"… || true …"`
    // inside an `echo` swallows nothing, and reading one as the other is how a
    // checker acquires a false positive that gets it weakened.
    const swallowed = shellCommands(stepBody(step)).some((command) => (
      command.precededBy === '||' && (command.head === 'true' || command.head === ':')
    ));
    if (swallowed) {
      findings.push(`\`${jobId}\` step "${step.name}" (line ${step.line}) swallows a failure with \`|| true\`.`);
    }
  }

  for (const step of measurements) {
    for (const pipe of unprotectedPipelines(step)) {
      findings.push(
        `\`${jobId}\` step "${step.name}" (line ${step.line}) pipes the measurement (\`${pipe.program}\`) into`
        + ` \`${pipe.downstream.join('` | `')}\` without \`set -o pipefail\` ahead of it. A pipeline reports the`
        + ' LAST command\'s status, so the step would exit 0 on a failing budget and the report step beside it —'
        + ' which only checks that the measurement HAPPENED — would tick. This is the one line standing between'
        + ' a breached budget and a green job.',
      );
    }
    if (step.if === null || !MEASUREMENT_CONDITIONS.includes(step.if)) {
      findings.push(
        `\`${jobId}\` step "${step.name}" (line ${step.line}) does not carry one of the exact conditions a`
        + ` measurement in this job may have (${MEASUREMENT_CONDITIONS.map((one) => `\`${one}\``).join(' or ')});`
        + ` it has ${step.if === null ? 'no `if:` at all' : `\`${step.if}\``}. Without \`!cancelled()\` an earlier`
        + ' breach skips it and the job reports one failure when it measured none of the rest — every measurement'
        + ' here is independent and all of them should be taken on the same idle runner. With any OTHER term in'
        + ' the condition the step can be switched off without being deleted, which is the same self-mute spelled'
        + ' in one word, so this is matched against exact spellings rather than scanned for `!cancelled()`. A new'
        + ' condition is one line added to that list.',
      );
    }
    // ── the state an admitted condition READS ────────────────────────────────
    // An exact-match allowlist fixes the SPELLING of the condition and says
    // nothing about what it evaluates to. The admitted one names a step by id,
    // and for two rounds nothing checked that the step existed, ran before this
    // one, or could not itself be skipped — three one-line edits, each leaving
    // this whole audit green with every budget unmeasured.
    for (const reference of stepContextReferences(step.if ?? '')) {
      const named = job.steps.find((candidate) => candidate.id === reference.id);
      if (!named) {
        findings.push(
          `\`${jobId}\` step "${step.name}" (line ${step.line}) is conditioned on`
          + ` \`steps.${reference.id}.${reference.property}\`, and NO step in this job declares`
          + ` \`id: ${reference.id}\`. GitHub resolves the missing context to null, the comparison is false, and`
          + ' this measurement never runs — after which its report step finds no log and exits 0 by design, so'
          + ' the job is green having measured nothing. Deleting one `id:` line is the entire edit. Either'
          + ' restore the id on the step this condition means, or change the condition (and the allowlist it is'
          + ' matched against) to name a step that exists.',
        );
        continue;
      }
      if (job.steps.indexOf(named) > job.steps.indexOf(step)) {
        findings.push(
          `\`${jobId}\` step "${step.name}" (line ${step.line}) is conditioned on`
          + ` \`steps.${reference.id}.${reference.property}\`, but step "${named.name}" (line ${named.line}) runs`
          + ' AFTER it. A step that has not run yet has no outcome, so the condition is false on every run and'
          + ' this measurement never happens.',
        );
      }
      if (named.if !== null) {
        findings.push(
          `\`${jobId}\` step "${step.name}" (line ${step.line}) is conditioned on`
          + ` \`steps.${reference.id}.${reference.property}\`, and the step it names — "${named.name}" (line`
          + ` ${named.line}) — itself carries \`if: ${named.if}\`. A SKIPPED step's outcome is \`skipped\`, not`
          + ' `success`, so one condition on that step switches off every measurement conditioned on it and the'
          + " job stays green. The premise this allowlist rests on is that the admitted condition's only"
          + ' skipping term is a step that FAILED — and a failed step carrying no `continue-on-error` fails the'
          + ' job, which is the whole argument. A step that can skip breaks it.',
        );
      }
    }
    for (const required of requiredStepEnv) {
      if (!testFilesInvokedBy(step).includes(required.file)) continue;
      const declared = step.env.get(required.name);
      if (declared === required.value) continue;
      findings.push(
        `\`${jobId}\` step "${step.name}" (line ${step.line}) runs ${required.file} without`
        + ` \`${required.name}: '${required.value}'\` in its \`env:\``
        + `${declared === undefined ? '' : ` (it sets \`${declared}\`)`}. That file's verdict is three-valued,`
        + ' and this step is the one place its third value is supposed to be fatal — on an idle runner, where'
        + ' an unanswerable measurement is a statement about the runner rather than about the machine being'
        + ' busy. Without the switch the row skips here exactly as it does everywhere else, and a skip is how a'
        + ' budget stops being enforced without anything going red.',
      );
    }
    if (step.shell !== REQUIRED_SHELL) {
      findings.push(
        `\`${jobId}\` step "${step.name}" (line ${step.line}) does not declare \`shell: ${REQUIRED_SHELL}\``
        + `${step.shell === null ? ' (it has no `shell:` key, so it takes the runner default)' : ` (it declares \`${step.shell}\`)`}.`
        + ' `shell: bash` is `bash --noprofile --norc -eo pipefail {0}`; the runner default is `bash -e {0}` with'
        + ' no pipefail, and `sh` is a different shell again. The `set -o pipefail` line inside this body and the'
        + ' harness that executes it both assume the first one.',
      );
    }

    const log = logWrittenBy(step);
    if (log === null) {
      findings.push(
        `\`${jobId}\` step "${step.name}" (line ${step.line}) invokes a budget file but tees to no log, so nothing`
        + ' can check afterwards that the measurement it names actually happened.',
      );
      continue;
    }
    const after = job.steps.slice(job.steps.indexOf(step) + 1);
    const readsLog = after.filter((candidate) => stepBody(candidate).includes(log));
    const paired = readsLog.find((candidate) => {
      const body = stepBody(candidate);
      return body.includes('did not run::')
        && /\bexit 1\b/.test(body)
        && REPORT_CONDITIONS.includes(candidate.if ?? '')
        && VERDICT_EVIDENCE.test(body)
        && NUMERIC_EVIDENCE.test(body);
    });
    if (!paired) {
      const near = readsLog.length > 0
        ? ` "${readsLog[0]!.name}" (line ${readsLog[0]!.line}) does read that log; what it is missing is one of`
          + ' the properties below.'
        : ' No later step in this job reads that log at all.';
      findings.push(
        `\`${jobId}\` step "${step.name}" (line ${step.line}) has no report step of its own.${near} A measurement`
        + ' needs a LATER step that reads its own log'
        + ` (${log}), carries exactly \`if: ${REPORT_CONDITIONS.join('` or `if: ')}\` (matched against exact`
        + ' spellings for the same reason the measurement condition is: `always() && false` contains'
        + ' `always()` and never runs), `exit 1`s with a'
        + ' `did not run::` annotation, and demands the instrument\'s own verdict line WITH ITS NUMBERS'
        + ' (`LATENCY BUDGET …` plus `wall p50/p95/max …` or `wall p95 …`) rather than the test\'s NAME — a name'
        + ' is something a hollow step can `echo` into the log, the numbers are not. Without that pairing the'
        + ' step ticks green when the test it names was renamed, filtered out or deleted, and a count of guards'
        + ' across the whole job does not supply it: one report step carrying three guards satisfies a total'
        + ' while the other measurements have none.',
      );
    } else if (paired.shell !== REQUIRED_SHELL) {
      findings.push(
        `\`${jobId}\` report step "${paired.name}" (line ${paired.line}) does not declare`
        + ` \`shell: ${REQUIRED_SHELL}\``
        + `${paired.shell === null ? ' (no `shell:` key, so it takes the runner default)' : ` (it declares \`${paired.shell}\`)`}.`
        + ' Its body is the thing latency-budget-ci.test.ts executes to prove this step rejects a log with no'
        + ' measurement in it, and that proof runs the body the way GitHub runs `shell: bash`'
        + ' (`bash --noprofile --norc -eo pipefail`). Under another shell the same body reaches different exits —'
        + ' on the committed hook-timing body the divergence is a red with no annotation attached — so the step'
        + ' would have moved out from under its own evidence.',
      );
    }
  }

  return findings;
}
