---
description: >
  Use PROACTIVELY whenever the user asks to add an API call, create a service, fetch data from
  an endpoint, connect to a backend, or wire up HTTP requests.
  Triggers: "add an API call", "create a service for", "fetch [resource] from the API",
  "connect to the [name] endpoint", "call the API to", "I need to GET/POST/PUT/DELETE".
---

# Skill: Create Service

Confirm the service function and hook before creating any files.

1. State the file: `src/services/[domain].ts` or `src/features/[name]/services/`
2. State the function signature with typed return value
3. State the React Query hook that will wrap it
4. Ask: "Should I go ahead?"

<!-- TODO: full scaffold template goes here once structure is validated -->
