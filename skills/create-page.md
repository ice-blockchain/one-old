---
description: >
  Use PROACTIVELY whenever the user asks to create, add, or build a page, route, screen, or view.
  Triggers: "create a page", "add a route", "new screen for", "build the [name] page",
  "I need a /[path] route", "scaffold the [name] view".
---

> ⚛️ react-best-practices — create-page skill

## Steps

1. Create `src/pages/[Name]Page.tsx` — thin wrapper only:

```tsx
import { [FeatureComponent] } from '@/features/[feature]';

export function [Name]Page() {
  return (
    <main className="container mx-auto px-4 py-8">
      <[FeatureComponent] />
    </main>
  );
}
```

2. Register in the router with lazy loading:
```tsx
// src/lib/router.tsx
const [Name]Page = React.lazy(() =>
  import('@/pages/[Name]Page').then((m) => ({ default: m.[Name]Page }))
);

// inside routes:
{
  path: '/[path]',
  element: (
    <Suspense fallback={<PageSkeleton />}>
      <[Name]Page />
    </Suspense>
  ),
}
```

3. If the route is protected, wrap with the auth guard:
```tsx
element: <AuthGuard><Suspense fallback={<PageSkeleton />}><[Name]Page /></Suspense></AuthGuard>
```

## Checklist
- [ ] Page is lazy-loaded (`React.lazy`)
- [ ] Wrapped in `<Suspense>` with skeleton fallback
- [ ] Zero business logic in the page file
- [ ] Route registered in the router
- [ ] Protected with `AuthGuard` if it requires auth
