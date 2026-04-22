---
description: >
  Use PROACTIVELY whenever the user asks to create, add, build, or scaffold a feature, module,
  domain, or slice of functionality. Triggers: "create a feature", "add a [name] feature",
  "build the [name] module", "scaffold [name] functionality", "I need [name] with CRUD",
  "add [name] with list and detail".
---

> ⚛️ react-best-practices — create-feature skill

## Order of creation (always in this order)

### 1. `src/features/[name]/types.ts` — types first, always
```ts
export interface FeatureItem {
  id: string;
  // all fields typed
}
```

### 2. `src/features/[name]/services/[name].ts`
```ts
import { api } from '@/services/api';
import { FeatureItem } from '../types';

export async function getItems(): Promise<FeatureItem[]> {
  const { data } = await api.get<FeatureItem[]>('/items');
  return data;
}
```

### 3. `src/features/[name]/hooks/use[Name].ts`
```ts
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getItems } from '../services/[name]';

export function use[Name]Items() {
  return useQuery({ queryKey: ['[name]'], queryFn: getItems, staleTime: 30_000 });
}
```

### 4. `src/features/[name]/stores/[name]Store.ts` — only if there is client-only state
```ts
import { create } from 'zustand';
interface [Name]Store { selectedId: string | null; setSelectedId: (id: string | null) => void; }
export const use[Name]Store = create<[Name]Store>((set) => ({ selectedId: null, setSelectedId: (id) => set({ selectedId: id }) }));
```

### 5. `src/features/[name]/components/` — minimum: List + Detail (+ Form if mutations exist)

### 6. `src/features/[name]/index.ts` — barrel export
```ts
export * from './components/[Name]List';
export * from './components/[Name]Detail';
export type { FeatureItem } from './types';
```

## Checklist
- [ ] `types.ts` written first
- [ ] Service functions are plain async (not hooks)
- [ ] `staleTime` set on every `useQuery`
- [ ] Zustand only for client-only state
- [ ] `index.ts` barrel created
- [ ] Feature does not import from other features
