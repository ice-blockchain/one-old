---
description: >
  Use PROACTIVELY whenever the user asks to refactor, clean up, improve, simplify, or fix
  code quality issues in existing React code.
  Triggers: "refactor this", "clean up", "improve this code", "simplify", "this is messy",
  "too complex", "extract", "split this component", "this component is too big".
---

> ⚛️ react-best-practices — refactor skill

## Refactor checklist — evaluate in this order

### 1. Component size
- Over 150 lines? → split into sub-components
- Multiple concerns in one component? → extract each into its own file
- Data fetching + rendering mixed? → extract fetching into a `use[Name]` hook

### 2. State hygiene
- Server data stored in Zustand? → move to React Query
- State lifted higher than necessary? → push it down
- Multiple `useState` calls that always change together? → consolidate into `useReducer`

### 3. Performance
- Inline object/array in JSX props? → extract to `useMemo` or module-level const
- Callback created inline in JSX? → wrap with `useCallback`
- Full store object subscribed instead of a slice? → `useStore(s => s.field)`

### 4. Type safety
- Any `any` types? → replace with `unknown` + type guard, or the correct type
- Missing return types on service functions? → add explicit return types
- Implicit prop types? → add `ComponentNameProps` interface

### 5. Forbidden patterns
- `export default` on a component? → convert to named export
- Inline `style={{}}`? → convert to Tailwind classes
- `axios` called directly in a component? → move to a service function
- Cross-feature import? → refactor to shared `src/components/`, `src/hooks/`, or `src/stores/`

### Output format
For each issue found: show the **before**, the **after**, and a one-line explanation of why.
