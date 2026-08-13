// Web component-system resolution: explicit user choice, detected dependency,
// framework-compatible shadcn default, then framework-native fallback.

import * as path from 'path';

import { readJson } from '../fsjson';
import { obj, type Rec } from '../obj';
import { projectContextOriginalPrompt } from '../onboarding/project-context';
import {
  candidateWebRoots,
  packageDependencies,
  stringField,
} from './fs-probe';
import { laravelInertiaKind } from './web-roots';
import type {
  CapabilityProfileV1,
  ShadcnAdapterId,
  WebUiSystemV1,
} from './types';
import { readRegularFileOrThrow } from '../bounded-read';

interface UiLibraryDefinition {
  id: string;
  packages: readonly string[];
  prompt: RegExp;
  adapter?: ShadcnAdapterId;
}

const UI_LIBRARIES: readonly UiLibraryDefinition[] = [
  {
    id: 'framework-native',
    packages: [],
    prompt: /\b(?:no|without|do not use|don't use)\s+(?:a\s+)?(?:ui|component)\s+librar(?:y|ies)\b/i,
  },
  {
    id: 'shadcn-vue',
    packages: ['shadcn-vue', 'shadcn-nuxt'],
    prompt: /\bshadcn[- /]?vue\b/i,
    adapter: 'shadcn-vue',
  },
  {
    id: 'shadcn-svelte',
    packages: ['shadcn-svelte'],
    prompt: /\bshadcn[- /]?svelte\b/i,
    adapter: 'shadcn-svelte',
  },
  {
    id: 'shadcn',
    packages: ['shadcn'],
    prompt: /\bshadcn(?:\/ui)?\b/i,
    adapter: 'shadcn',
  },
  { id: 'mui', packages: ['@mui/material', '@material-ui/core'], prompt: /\b(?:mui|material[- ]ui)\b/i },
  { id: 'ant-design', packages: ['antd'], prompt: /\b(?:antd|ant design)\b/i },
  { id: 'chakra-ui', packages: ['@chakra-ui/react'], prompt: /\bchakra(?: ui)?\b/i },
  { id: 'mantine', packages: ['@mantine/core'], prompt: /\bmantine\b/i },
  { id: 'bootstrap', packages: ['bootstrap', 'react-bootstrap'], prompt: /\bbootstrap\b/i },
  { id: 'vuetify', packages: ['vuetify'], prompt: /\bvuetify\b/i },
  { id: 'primevue', packages: ['primevue'], prompt: /\bprimevue\b/i },
  { id: 'quasar', packages: ['quasar'], prompt: /\bquasar\b/i },
  { id: 'element-plus', packages: ['element-plus'], prompt: /\belement[- ]plus\b/i },
  { id: 'naive-ui', packages: ['naive-ui'], prompt: /\bnaive[- ]ui\b/i },
  { id: 'nuxt-ui', packages: ['@nuxt/ui'], prompt: /\bnuxt[- ]ui\b/i },
  { id: 'skeleton', packages: ['@skeletonlabs/skeleton'], prompt: /\bskeleton(?: ui)?\b/i },
  { id: 'flowbite', packages: ['flowbite', 'flowbite-react', 'flowbite-svelte'], prompt: /\bflowbite\b/i },
  { id: 'angular-material', packages: ['@angular/material'], prompt: /\bangular material\b/i },
  { id: 'primeng', packages: ['primeng'], prompt: /\bprimeng\b/i },
  { id: 'ng-zorro', packages: ['ng-zorro-antd'], prompt: /\b(?:ng[- ]zorro|zorro)\b/i },
  { id: 'daisyui', packages: ['daisyui'], prompt: /\bdaisyui\b/i },
  { id: 'headless-ui', packages: ['@headlessui/react', '@headlessui/vue'], prompt: /\bheadless[- ]ui\b/i },
  { id: 'radix-ui', packages: ['@radix-ui/react-dialog', 'radix-vue', 'reka-ui'], prompt: /\b(?:radix[- ]ui|radix|reka[- ]ui)\b/i },
  { id: 'ark-ui', packages: ['@ark-ui/react', '@ark-ui/vue', '@ark-ui/svelte'], prompt: /\bark[- ]ui\b/i },
  { id: 'base-ui', packages: ['@base-ui-components/react'], prompt: /\bbase[- ]ui\b/i },
  { id: 'react-aria', packages: ['react-aria-components'], prompt: /\breact[- ]aria\b/i },
  { id: 'heroui', packages: ['@heroui/react'], prompt: /\bhero[- ]ui\b/i },
  { id: 'primereact', packages: ['primereact'], prompt: /\bprimereact\b/i },
] as const;

export function uiLibraryFromPrompt(prompt: string): string | null {
  for (const definition of UI_LIBRARIES) {
    const match = definition.prompt.exec(prompt);
    if (!match) continue;
    const before = prompt.slice(Math.max(0, match.index - 48), match.index);
    if (/\b(?:avoid|without|not|no|don't|do not|instead of)\s+(?:(?:use|using)\s+)?$/i.test(before)) continue;
    return definition.id;
  }
  if (/\b(?:avoid|without|don't use|do not use|no)\s+shadcn(?:\/ui)?\b/i.test(prompt)) {
    return 'framework-native';
  }
  return null;
}

function explicitLibrary(state: Rec): UiLibraryDefinition | null {
  const configured = stringField(state, 'uiLibrary', '');
  if (configured) {
    const normalized = configured.toLowerCase();
    return UI_LIBRARIES.find((entry) => (
      entry.id === normalized
      || entry.packages.includes(normalized)
      || entry.prompt.test(configured)
    )) || { id: configured, packages: [], prompt: /$a/ };
  }
  const prompt = projectContextOriginalPrompt(state);
  const fromPrompt = uiLibraryFromPrompt(prompt);
  return fromPrompt ? UI_LIBRARIES.find((entry) => entry.id === fromPrompt) || null : null;
}

function componentsJsonAdapter(cwd: string): ShadcnAdapterId | null {
  for (const root of ['packages/ui', ...candidateWebRoots(cwd)]) {
    const file = path.join(cwd, root, 'components.json');
    let raw: Rec;
    try {
      raw = readJson<Rec>(file, {});
    } catch {
      continue;
    }
    if (Object.keys(raw).length === 0) continue;
    const schema = typeof raw.$schema === 'string' ? raw.$schema : '';
    if (/shadcn-vue/i.test(schema)) return 'shadcn-vue';
    if (/shadcn-svelte/i.test(schema)) return 'shadcn-svelte';
    if (/shadcn/i.test(schema)) return 'shadcn';
    try {
      const text = readRegularFileOrThrow(file);
      if (/shadcn-vue/i.test(text)) return 'shadcn-vue';
      if (/shadcn-svelte/i.test(text)) return 'shadcn-svelte';
    } catch {
      // A parseable components.json is enough evidence for the React CLI.
    }
    return 'shadcn';
  }
  return null;
}

function detectedLibrary(cwd: string): UiLibraryDefinition | null {
  const installed = new Set(
    candidateWebRoots(cwd).flatMap((root) => Object.keys(packageDependencies(cwd, root))),
  );
  const match = UI_LIBRARIES.find((entry) => entry.packages.some((name) => installed.has(name)));
  if (match) return match;
  const adapter = componentsJsonAdapter(cwd);
  return adapter
    ? UI_LIBRARIES.find((entry) => entry.adapter === adapter) || null
    : null;
}

function astroAdapter(cwd: string): ShadcnAdapterId | null {
  const deps = Object.assign(
    {},
    ...candidateWebRoots(cwd).map((root) => packageDependencies(cwd, root)),
  ) as Rec;
  if (deps.react || deps['@astrojs/react']) return 'shadcn';
  if (deps.vue || deps['@astrojs/vue']) return 'shadcn-vue';
  if (deps.svelte || deps['@astrojs/svelte']) return 'shadcn-svelte';
  return null;
}

function defaultAdapter(
  cwd: string,
  profile: Pick<CapabilityProfileV1, 'profileId' | 'router'>,
): ShadcnAdapterId | null {
  if (['vite-react', 'next-app', 'next-pages'].includes(profile.profileId)) return 'shadcn';
  if (['nuxt', 'vue'].includes(profile.profileId)) return 'shadcn-vue';
  if (['sveltekit', 'svelte'].includes(profile.profileId)) return 'shadcn-svelte';
  if (profile.profileId === 'astro') return astroAdapter(cwd);
  if (profile.profileId === 'server-rendered') {
    if (profile.router === 'inertia-react-router') return 'shadcn';
    if (profile.router === 'inertia-vue-router') return 'shadcn-vue';
  }
  return null;
}

function selectedSystem(
  definition: UiLibraryDefinition,
  source: 'explicit' | 'detected',
): WebUiSystemV1 {
  if (definition.id === 'framework-native') {
    return {
      family: 'framework-native',
      adapter: null,
      library: 'framework-native',
      source,
      sharedRoot: null,
    };
  }
  return definition.adapter
    ? {
        family: 'shadcn',
        adapter: definition.adapter,
        library: definition.id,
        source,
        sharedRoot: 'packages/ui',
      }
    : {
        family: 'external',
        adapter: null,
        library: definition.id,
        source,
        sharedRoot: 'packages/ui',
      };
}

function unsupportedAdapterSystem(definition: UiLibraryDefinition): WebUiSystemV1 {
  return {
    family: 'framework-native',
    adapter: null,
    library: definition.id,
    source: 'unsupported',
    sharedRoot: null,
  };
}

export function resolveWebUiSystem(
  cwd: string,
  stateInput: unknown,
  profile: Pick<CapabilityProfileV1, 'profileId' | 'router' | 'surfaces' | 'architectureTarget'>,
): WebUiSystemV1 | undefined {
  if (!profile.surfaces.includes('web-ui') || profile.architectureTarget === 'native-ui') return undefined;
  const state = obj(stateInput) || {};
  const explicit = explicitLibrary(state);
  if (explicit) {
    if (explicit.adapter && defaultAdapter(cwd, profile) !== explicit.adapter) {
      return unsupportedAdapterSystem(explicit);
    }
    return selectedSystem(explicit, 'explicit');
  }
  const detected = detectedLibrary(cwd);
  if (detected) {
    if (detected.adapter && defaultAdapter(cwd, profile) !== detected.adapter) {
      return unsupportedAdapterSystem(detected);
    }
    return selectedSystem(detected, 'detected');
  }
  const adapter = defaultAdapter(cwd, profile);
  if (adapter) {
    return {
      family: 'shadcn',
      adapter,
      library: adapter,
      source: 'default',
      sharedRoot: 'packages/ui',
    };
  }
  return {
    family: 'framework-native',
    adapter: null,
    library: 'framework-native',
    source: 'unsupported',
    sharedRoot: null,
  };
}

export function profileSupportsShadcnWorkspace(
  cwd: string,
  frontend: string,
  stateInput: unknown,
): boolean {
  if (['react-vite', 'nextjs', 'nuxt', 'vue', 'sveltekit', 'svelte'].includes(frontend)) return true;
  if (frontend === 'laravel-ui') {
    const configured = stringField(obj(stateInput) || {}, 'frontend', '');
    return ['react', 'react-vite', 'nextjs', 'vue', 'nuxt'].includes(configured)
      || ['react', 'vue'].includes(laravelInertiaKind(cwd, configured) || '');
  }
  if (frontend !== 'astro') return false;
  return Boolean(astroAdapter(cwd));
}
