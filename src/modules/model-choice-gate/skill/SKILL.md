---
name: traffic-one-model-choice-gate
description: Wording source for the Cursor model-choice fail-closed gate. Read at runtime via skillBlock(); enforcement lives in TS.
---

# Traffic One Model-Choice Gate

<!-- T1BLOCK:BEGIN model-choice-stop-first -->
Traffic One model-choice gate: build paused until the user chooses how to handle unavailable Cursor model(s).

{{TABLE}}

Paste the table above to the user in chat and end your turn. Do not spawn subagents, scaffold directly, edit project files, install dependencies, or simulate the team inline until the user replies `fallback` or `enable`.
<!-- T1BLOCK:END model-choice-stop-first -->

<!-- T1BLOCK:BEGIN model-choice-stop-repeat -->
Traffic One model-choice gate: build still paused. The user has not replied `fallback` or `enable` yet. Stop now and ask the user to choose; do not spawn subagents, scaffold directly, edit project files, install dependencies, or simulate the team inline.
<!-- T1BLOCK:END model-choice-stop-repeat -->
