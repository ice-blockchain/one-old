---
name: ui-demo
description: Record polished UI demo videos using Playwright. Use when the user asks to create a demo, walkthrough, screen recording, or tutorial video of a web application. Produces WebM videos with visible cursor, natural pacing, and professional feel.
metadata:
  source: everything-claude-code
  source_path: skills/ui-demo/SKILL.md
  source_commit: 4e66b2882da9afb9747468b08a253ca2f09c85f3
  adapted_for: traffic-one
---

# UI Demo Video Recorder

Record polished demo videos of web applications using Playwright's video recording with an injected cursor overlay, natural pacing, and storytelling flow.

## When to Activate

- User asks for a "demo video", "screen recording", "walkthrough", or "tutorial"
- User wants to showcase a feature or workflow visually
- User needs a video for documentation, onboarding, or stakeholder presentation

## Three-Phase Process

Every demo goes through three phases: **Discover -> Rehearse -> Record**. Never skip straight to recording.

---

## Phase 1: Discover

Before writing any script, explore the target pages to understand what is actually there.

### Why

You cannot script what you have not seen. Fields may be `<input>` not `<textarea>`, dropdowns may be custom components not `<select>`, and comment boxes may support `@mentions` or `#tags`. Assumptions break recordings silently.

### How

Navigate to each page in the flow and dump its interactive elements:

```javascript
// Run this for each page in the flow BEFORE writing the demo script
const fields = await page.evaluate(() => {
  const els = [];
  document.querySelectorAll('input, select, textarea, button, [contenteditable]').forEach(el => {
    if (el.offsetParent !== null) {
      els.push({
        tag: el.tagName,
        type: el.type || '',
        name: el.name || '',
        placeholder: el.placeholder || '',
        text: el.textContent?.trim().substring(0, 40) || '',
        contentEditable: el.contentEditable === 'true',
        role: el.getAttribute('role') || '',
      });
    }
  });
  return els;
});
console.log(JSON.stringify(fields, null, 2));
```

### What to look for

- **Form fields**: Are they `<select>`, `<input>`, custom dropdowns, or comboboxes?
- **Select options**: Dump option values AND text. Placeholders often have `value="0"` or `value=""` which looks non-empty. Use `Array.from(el.options).map(o => ({ value: o.value, text: o.text }))`. Skip options where text includes "Select" or value is `"0"`.
- **Rich text**: Does the comment box support `@mentions`, `#tags`, markdown, or emoji? Check placeholder text.
- **Required fields**: Which fields block form submission? Check `required`, `*` in labels, and try submitting empty to see validation errors.
- **Dynamic content**: Do fields appear after other fields are filled?
- **Button labels**: Exact text such as `"Submit"`, `"Submit Request"`, or `"Send"`.
- **Table column headers**: For table-driven modals, map each `input[type="number"]` to its column header instead of assuming all numeric inputs mean the same thing.

### Output

A field map for each page, used to write correct selectors in the script. Example:

```text
/purchase-requests/new:
  - Budget Code: <select> (first select on page, 4 options)
  - Desired Delivery: <input type="date">
  - Context: <textarea> (not input)
  - BOM table: inline-editable cells with span.cursor-pointer -> input pattern
  - Submit: <button> text="Submit"

/purchase-requests/N (detail):
  - Comment: <input placeholder="Type a message..."> supports @user and #PR tags
  - Send: <button> text="Send" (disabled until input has content)
```

---

## Phase 2: Rehearse

Run through all steps without recording. Verify every selector resolves.

### Why

Silent selector failures are the main reason demo recordings break. Rehearsal catches them before you waste a recording.

### How

Use `ensureVisible`, a wrapper that logs and fails loudly:

```javascript
async function ensureVisible(page, locator, label) {
  const el = typeof locator === 'string' ? page.locator(locator).first() : locator;
  const visible = await el.isVisible().catch(() => false);
  if (!visible) {
    const msg = `REHEARSAL FAIL: "${label}" not found - selector: ${typeof locator === 'string' ? locator : '(locator object)'}`;
    console.error(msg);
    const found = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('button, input, select, textarea, a'))
        .filter(el => el.offsetParent !== null)
        .map(el => `${el.tagName}[${el.type || ''}] "${el.textContent?.trim().substring(0, 30)}"`)
        .join('\n  ');
    });
    console.error('  Visible elements:\n  ' + found);
    return false;
  }
  console.log(`REHEARSAL OK: "${label}"`);
  return true;
}
```

### Rehearsal script structure

```javascript
const steps = [
  { label: 'Login email field', selector: '#email' },
  { label: 'Login submit', selector: 'button[type="submit"]' },
  { label: 'New Request button', selector: 'button:has-text("New Request")' },
  { label: 'Budget Code select', selector: 'select' },
  { label: 'Delivery date', selector: 'input[type="date"]:visible' },
  { label: 'Description field', selector: 'textarea:visible' },
  { label: 'Add Item button', selector: 'button:has-text("Add Item")' },
  { label: 'Submit button', selector: 'button:has-text("Submit")' },
];

let allOk = true;
for (const step of steps) {
  if (!await ensureVisible(page, step.selector, step.label)) {
    allOk = false;
  }
}
if (!allOk) {
  console.error('REHEARSAL FAILED - fix selectors before recording');
  process.exit(1);
}
console.log('REHEARSAL PASSED - all selectors verified');
```

### When rehearsal fails

1. Read the visible-element dump.
2. Find the correct selector.
3. Update the script.
4. Re-run rehearsal.
5. Only proceed when every selector passes.

---

## Phase 3: Record

Only after discovery and rehearsal pass should you create the recording.

### Recording Principles

#### 1. Storytelling Flow

Plan the video as a story. Follow user-specified order, or use this default:

- **Entry**: Login or navigate to the starting point
- **Context**: Pan the surroundings so viewers orient themselves
- **Action**: Perform the main workflow steps
- **Variation**: Show a secondary feature such as settings, theme, or localization
- **Result**: Show the outcome, confirmation, or new state

#### 2. Pacing

- After login: `4s`
- After navigation: `3s`
- After clicking a button: `2s`
- Between major steps: `1.5-2s`
- After the final action: `3s`
- Typing delay: `25-40ms` per character

#### 3. Cursor Overlay

`async injectCursor(page)` — append a fixed-position `#demo-cursor` div holding
an SVG arrow (`drop-shadow`, `z-index: 999999`, `pointer-events: none`,
`transition: left/top 0.1s`) and a `mousemove` listener that tracks it to
`e.clientX/Y`. Idempotent (bail if `#demo-cursor` exists). Re-call after every
navigation — the overlay is destroyed on navigate.

#### 4. Mouse Movement

`async moveAndClick(page, locator, label, opts = {})` — never teleport: resolve
the locator (`.first()`), bail with a logged warning if not visible, then
`scrollIntoViewIfNeeded` → `page.mouse.move(centerX, centerY, { steps: 10 })`
with short pauses → `el.click(clickOpts)` → `postClickDelay` (default 800ms).
Always pass a descriptive `label` for debugging.

#### 5. Typing

`async typeSlowly(page, locator, text, label, charDelay = 35)` — type visibly,
not instant-fill: `moveAndClick` to focus, `el.fill('')` to clear, then
`el.pressSequentially(text, { delay: charDelay })`. Bail with a warning if not
visible.

#### 6. Scrolling

Use smooth scroll instead of jumps:

```javascript
await page.evaluate(() => window.scrollTo({ top: 400, behavior: 'smooth' }));
await page.waitForTimeout(1500);
```

#### 7. Dashboard Panning

`async panElements(page, selector, maxCount = 6)` — for the first `maxCount`
matches above the fold (`box.y < 700`), move the cursor to each element's center
(`steps: 8`) with a ~600ms pause, so the viewer's eye is led across key cards.
Wrap each element in try/catch with a logged warning.

#### 8. Subtitles

`async injectSubtitleBar(page)` — append a fixed bottom-bar `#demo-subtitle` div
(centered, translucent black background, white system font, `opacity` 0,
`transition: opacity 0.3s`, `pointer-events: none`). Idempotent. Re-call
alongside `injectCursor(page)` after every navigation.

`async showSubtitle(page, text)` — set the bar's `textContent` and fade it in
(`opacity: 1`) when `text` is truthy, otherwise fade out; pause ~800ms when
showing text.

Usage pattern:

```javascript
await showSubtitle(page, 'Step 1 - Logging in');
await showSubtitle(page, 'Step 2 - Dashboard overview');
await showSubtitle(page, '');
```

Guidelines:

- Keep subtitle text short, ideally under 60 characters.
- Use `Step N - Action` format for consistency.
- Clear the subtitle during long pauses where the UI can speak for itself.

## Script Template

Skeleton of the recorder script the agent expands. Top: `'use strict'`,
`require('playwright')` + `path`/`fs`, then constants —
`BASE_URL = process.env.QA_BASE_URL || 'http://localhost:3000'`, a `VIDEO_DIR`
under `__dirname`, an `OUTPUT_NAME` (`demo-FEATURE.webm`), and
`REHEARSAL = process.argv.includes('--rehearse')`. Paste the helpers
(`injectCursor`, `injectSubtitleBar`, `showSubtitle`, `moveAndClick`,
`typeSlowly`, `ensureVisible`, `panElements`) below the constants.

The async IIFE then:

1. `chromium.launch({ headless: true })`.
2. **Rehearsal branch** (`if (REHEARSAL)`): plain context at 1280x720, walk the
   flow running `ensureVisible` per selector, close, return.
3. **Record branch**: context with `recordVideo: { dir: VIDEO_DIR, size: 1280x720 }`
   and matching `viewport`. In a `try`, `injectCursor` + `injectSubtitleBar`,
   then drive the story — `showSubtitle('Step N - ...')` → actions, re-injecting
   both overlays after each `page.goto`, ending with `showSubtitle(page, '')`.
   `catch` logs `DEMO ERROR`. `finally` closes the context, then
   `page.video().path()` → `fs.copyFileSync` to the stable `OUTPUT_NAME` (logging
   src/dest on failure), then `browser.close()`.

Usage:

```bash
# Phase 2: Rehearse
node demo-script.cjs --rehearse

# Phase 3: Record
node demo-script.cjs
```

## Checklist Before Recording

- [ ] Discovery phase completed
- [ ] Rehearsal passes with all selectors OK
- [ ] Headless mode enabled
- [ ] Resolution set to `1280x720`
- [ ] Cursor and subtitle overlays re-injected after every navigation
- [ ] `showSubtitle(page, 'Step N - ...')` used at major transitions
- [ ] `moveAndClick` used for all clicks with descriptive labels
- [ ] `typeSlowly` used for visible input
- [ ] No silent catches; helpers log warnings
- [ ] Smooth scrolling used for content reveal
- [ ] Key pauses are visible to a human viewer
- [ ] Flow matches the requested story order
- [ ] Script reflects the actual UI discovered in phase 1

## Common Pitfalls

1. Cursor disappears after navigation - re-inject it.
2. Video is too fast - add pauses.
3. Cursor is a dot instead of an arrow - use the SVG overlay.
4. Cursor teleports - move before clicking.
5. Select dropdowns look wrong - show the move, then pick the option.
6. Modals feel abrupt - add a read pause before confirming.
7. Video file path is random - copy it to a stable output name.
8. Selector failures are swallowed - never use silent catch blocks.
9. Field types were assumed - discover them first.
10. Features were assumed - inspect the actual UI before scripting.
11. Placeholder select values look real - watch for `"0"` and `"Select..."`.
12. Popups create separate videos - capture popup pages explicitly and merge later if needed.
