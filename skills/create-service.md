---
description: >
  Use PROACTIVELY whenever the user asks to add an API call, create a service, fetch data from
  an endpoint, connect to a backend, or wire up HTTP requests.
  Triggers: "add an API call", "create a service for", "fetch [resource] from the API",
  "connect to the [name] endpoint", "call the API to", "I need to GET/POST/PUT/DELETE".
---

> ⚛️ react-best-practices — create-service skill

## Steps

### 1. Add the service function to the right file
- Existing domain → `src/services/[domain].ts` or `src/features/[name]/services/[name].ts`
- New domain → create a new file

```ts
import { api } from '@/services/api';
import { ResourceType } from '../types';

// GET — typed return, no any
export async function getResource(id: string): Promise<ResourceType> {
  const { data } = await api.get<ResourceType>(`/resources/${id}`);
  return data;
}

// POST — validate input with zod before calling
export async function createResource(payload: CreateResourceInput): Promise<ResourceType> {
  const { data } = await api.post<ResourceType>('/resources', payload);
  return data;
}
```

### 2. Add a React Query hook in the feature hooks folder

```ts
// read
export function useResource(id: string) {
  return useQuery({
    queryKey: ['resources', id],
    queryFn: () => getResource(id),
    staleTime: 30_000,
  });
}

// write
export function useCreateResource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: createResource,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['resources'] }),
  });
}
```

## Rules
- Service functions are plain async — never hooks
- Always type the return value
- Never call `api` directly in a component
- Validate mutation payloads with Zod before calling the service
