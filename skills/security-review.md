---
description: >
  Use PROACTIVELY whenever the user asks to review, audit, or check code for security issues,
  or when writing authentication, authorization, token handling, or any code that touches
  user data, passwords, secrets, or environment variables.
  Triggers: "review security", "is this secure", "check for vulnerabilities", "auth",
  "JWT", "token", "password", "env var", "API key", "dangerouslySetInnerHTML".
---

> ⚛️ react-best-practices — security-review skill

## Security checklist — run through every item

### Tokens & auth
- [ ] Access tokens NOT in `localStorage` (use `httpOnly` cookies or in-memory)
- [ ] No tokens or secrets logged to `console.*`
- [ ] Token expiry validated client-side before sensitive requests
- [ ] Auth header injected only in the axios interceptor, nowhere else

### API & data
- [ ] No user input interpolated raw into URL paths
- [ ] All mutation payloads validated with a Zod schema before sending
- [ ] No `VITE_` env vars contain secrets (they are public to the browser)
- [ ] `.env` and `.env.local` are in `.gitignore`
- [ ] `.env.example` documents every required variable (values redacted)

### XSS
- [ ] No `dangerouslySetInnerHTML` without explicit DOMPurify sanitisation
- [ ] No `eval()` or `new Function()` with user-supplied input

### Dependencies
- [ ] `npm audit` passes with no high/critical issues
- [ ] Major versions pinned in `package.json`

### If any item fails — explain the risk and provide the corrected code.
