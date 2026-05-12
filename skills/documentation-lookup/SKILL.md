---
name: documentation-lookup
description: Look up current official documentation before answering or implementing version-sensitive framework, library, API, CLI, or provider behavior. Use for setup, config, API references, examples, migrations, and named technologies such as React, Vite, Supabase, Tailwind, shadcn/ui, Ionic, Expo, Playwright, OpenAI, Stripe, or deployment providers.
metadata:
  source: everything-claude-code
  source_path: skills/documentation-lookup/SKILL.md
  source_commit: 4e66b2882da9afb9747468b08a253ca2f09c85f3
  adapted_for: traffic-one
---

Traffic One precedence: follow this skill only where it does not conflict with
Traffic One AGENTS.md and rules/*.md. Prefer official docs and primary sources;
adapt examples to Traffic One's approved stack.

# Documentation Lookup

Use this skill when correctness depends on current framework, library, provider,
or CLI behavior.

## Source order

1. Local project docs, lockfiles, config, and installed versions.
2. Available MCP/documentation connectors, if configured.
3. Official vendor/framework documentation.
4. Primary source repositories, release notes, changelogs, or package metadata.
5. Community sources only for non-authoritative context, never as the sole basis
   for API behavior.

For OpenAI product/API questions, use official OpenAI sources only unless the
user asks otherwise.

## Workflow

1. Identify the exact library/product and version when discoverable.
2. Resolve the official docs page or primary source.
3. Read only the sections needed for the user task.
4. Implement or answer using the verified behavior.
5. Cite the docs/source in the user-facing answer when the user asked for facts,
   version-sensitive behavior, or links.

## Guardrails

- Do not rely on training memory for current CLI flags, config shape, package
  names, provider limits, auth flows, or deployment behavior.
- Do not paste secrets into external docs/search queries. Redact tokens, URLs
  with credentials, customer data, and private topology.
- If docs conflict with project rules, say so and follow the stricter Traffic
  One rule unless the user explicitly changes the stack decision.
- If no reliable source is available, state what is unverified and choose the
  smallest reversible step.

## Common Traffic One lookups

- Vite config/plugin behavior and build limitations.
- Supabase Auth, Storage, Realtime, RLS, Edge Functions, and CLI commands.
- Tailwind/shadcn/ui primitive installation and component APIs.
- Playwright, Lighthouse, and axe testing APIs.
- Ionic/Capacitor native packaging and permission behavior.
- Expo/React Native release and config behavior.
