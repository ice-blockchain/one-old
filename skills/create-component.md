---
description: >
  Use PROACTIVELY whenever the user asks to create, add, build, make, scaffold, or generate
  a React component, UI element, card, modal, form, button, table, list, or any piece of UI.
  Triggers: "create a component", "add a X component", "make a form for", "build a modal",
  "I need a table", "scaffold a card", "new UI for".
---

> ⚛️ react-best-practices — create-component skill

## Steps

1. Determine placement:
   - Shared across app → `src/components/common/ComponentName.tsx`
   - Only used by one feature → `src/features/[feature]/components/ComponentName.tsx`

2. Create `ComponentName.tsx`:

```tsx
interface ComponentNameProps {
  // all props typed explicitly — no any
}

export function ComponentName({ prop1, prop2 }: ComponentNameProps) {
  // complex expressions extracted to variables above return
  return (
    <div className="...">
      {/* Tailwind only — no style={{}} */}
    </div>
  );
}
```

3. If it fetches data → create `hooks/useComponentName.ts` using `useQuery`. Keep the component presentational.

4. If it has a form:
```ts
const schema = z.object({ field: z.string().min(1) });
type FormData = z.infer<typeof schema>;
// then useForm<FormData>({ resolver: zodResolver(schema) })
```

5. Create `ComponentName.test.tsx` — test from the user's perspective, not implementation.

## Checklist
- [ ] Named export (not default)
- [ ] `ComponentNameProps` interface defined
- [ ] No `any`, no inline styles
- [ ] `isLoading` + `isError` + empty state handled
- [ ] Test file created
