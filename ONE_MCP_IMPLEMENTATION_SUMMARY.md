# One MCP și runtime safety — implementation handoff

Documentul acesta descrie schimbările implementate pe branch-ul
`feat/one-get-config-integration`, starea lor la 17 iulie 2026 și pașii necesari
pentru a relua lucrul fără a reface auditul întregului diff.

## Rezumat executiv

- Configurația Traffic One MCP este centralizată în `src/config/one-mcp.ts`.
- Catalogul remote folosește payload schema v2, plan-aware, validat strict pentru
  câmpurile cunoscute și tolerant la extensii aditive.
- `~/.traffic-one/one-mcp.json` este singurul cache persistent al catalogului
  remote; `one.json` nu mai conține tier-uri de modele.
- Performance folosește un acknowledgement canonic per host, iar schimbările
  semantice ale tier-urilor redeschid picker-ul fără `targetToken`.
- Fiecare run primește un `model-policy.json` imuabil; copiii și retry-urile nu
  recitesc starea globală mutabilă.
- Codex verifică modelul observat de hook înainte ca un copil să primească un
  claim sau să poată folosi un tool.
- Apelurile agentului către `traffic-one-mcp/get_config` și
  `traffic-one-mcp/report_codebase_metadata` sunt blocate pe toate hosturile;
  numai hook-ul intern poate comunica anonim cu endpoint-ul public.
- Parserul `apply_patch` este unic, multi-file și fail-closed.
- Linkurile onboarding separă dashboard-ul hosted, fallback-ul direct `/local`
  și redirect-ul loopback folosit numai pentru auto-open/registry.
- Milestone 1 este starea curentă: sync, registration și reporting public sunt
  build-disabled. Codul local/safety poate fi livrat fără activarea serviciului
  public.

## Snapshot de lucru

- Branch: `feat/one-get-config-integration`
- Bază: `bbe5738c` (`origin/master` la începutul lucrului)
- Versiune pachet: `2.9.265`
- Inventar înaintea acestui document: 209 căi (`164` modificate, `37` noi,
  `8` șterse)
- `src/` rămâne sursa de adevăr; `dist/` este generat și gitignored.
- Nu au fost create fișiere `.traffic-one/**` în repository-ul sursă.

## Decizii fixate

1. Sync-ul este hook-owned, nu agent-driven.
2. `pluginUse.enabled === true` este obligatoriu pentru orice request public.
3. Subagentul recunoscut nu face sync; duplicatele produse de clasificări
   greșite sunt tolerate prin generation CAS.
4. `auto` este validat și inclus în payload fingerprint, dar nu este legat de
   tier-urile subagenților și nu intră în applied fingerprint.
5. Nu există migrare pentru stările One MCP pre-release. Cache-ul v1 este
   ignorat, iar un target Performance exclusiv legacy produce un singur repick.
6. `one.json` rămâne pentru auth și `codeGraphProvider`; nu este catalog de
   modele.
7. `availableModels` rămâne numai la Cursor și reprezintă slug-urile executabile
   văzute în picker, nu o copie a catalogului MCP.
8. Un run activ nu este rebased când se schimbă planul sau catalogul.
9. Submit-ul Performance rămâne simplu:

   ```json
   {"step":"performance","value":"balanced"}
   ```

10. Codex folosește temporar numai:

    ```text
    highest  -> gpt-5.6-sol
    balanced -> gpt-5.6-terra
    cheapest -> gpt-5.6-terra
    ```

## Arhitectura flow-ului

```text
src/config/model-tiers.ts#HOST_MODELS
        │
        ├── bundled catalog folosit offline
        │
        └── npm run gen
              ├── dist/operator/one-mcp-model-configs.json
              └── dist/operator/one-mcp-publish-cas.sql
                            │
                            ▼
                  Supabase public.plugin_config
                            │
                            ▼
                 anonymous /public-mcp get_config
                            │
                            ▼
                  ~/.traffic-one/one-mcp.json
                            │
                    plan-aware projection
                            │
                            ▼
        preferences.json hosts.<host>.performance.target
                            │
                  Performance acknowledgement
                            │
                            ▼
          .traffic-one/runs/<runId>/model-policy.json
                            │
                            ▼
                 spawn / retry / child enforcement
```

## Configurația centrală

Fișier principal: `src/config/one-mcp.ts`.

Conține:

- endpoint-ul autentificat `/mcp` pentru API-key onboarding;
- endpoint-ul anonim `/public-mcp` pentru config și reporting;
- serverul `traffic-one-mcp` și tool-urile administrate;
- toate cele șapte `config_name`;
- schema, decoder și cache versions;
- timeout-uri, limite de payload/response și lock-uri;
- operator manifest paths și live release evidence contract;
- release switches pentru sync, registration și reporting.

Overrides:

- `TRAFFIC_ONE_MCP_KEY_ENDPOINT` — endpoint autentificat;
- `TRAFFIC_ONE_MCP_PUBLIC_ENDPOINT` — endpoint public;
- `TRAFFIC_ONE_ONE_MCP_ENDPOINT` — alias legacy temporar pentru endpoint public.

`DEFAULT_ENDPOINT` a fost eliminat din `src/config/auth.ts`; auth folosește
`authenticatedEndpoint()`.

Config names:

| Host | Config name |
| --- | --- |
| Claude | `traffic_one_claude_code_plugin_ai_model_configuration` |
| Cursor | `traffic_one_cursor_plugin_ai_model_configuration` |
| OpenCode | `traffic_one_opencode_plugin_ai_model_configuration` |
| Codex | `traffic_one_codex_plugin_ai_model_configuration` |
| Copilot | `traffic_one_copilot_plugin_ai_model_configuration` |
| Kilo | `traffic_one_kilo_plugin_ai_model_configuration` |
| Windsurf | `traffic_one_windsurf_plugin_ai_model_configuration` |

Starea curentă a release switches:

```ts
ONE_MCP_SYNC_ACTIVE = false;
ONE_MCP_REGISTRATION_ACTIVE = false;
REPORTING_ACTIVE = false;
```

Un environment override nu poate activa un switch compilat `false`; poate doar
dezactiva suplimentar o funcție activată de build.

## Payload schema v2

Surse:

- `src/shared/one-mcp/types.ts`
- `src/shared/one-mcp/get-config.ts`
- `src/shared/one-mcp/fingerprint.ts`
- `src/shared/one-mcp/bundled-catalog.ts`

Contract:

```ts
interface OneMcpModelConfigPayloadV2 {
  payloadSchemaVersion: 2;
  tiers: RemoteTierSet;
  plans?: Partial<Record<UserPlan, RemoteTierSet>>;
}

interface RemoteTierSet {
  high: string[];
  balanced: string[];
  low: string[];
  auto: string[];
}
```

Reguli importante:

- `high -> highest`, `balanced -> balanced`, `low -> cheapest`;
- un override de plan recunoscut trebuie să aibă toate cele patru rânduri;
- un plan absent folosește tier-urile de bază;
- planurile necunoscute și câmpurile aditive sunt ignorate;
- cheile proto sunt respinse la orice adâncime;
- rândurile trebuie să fie non-empty, fără duplicate și maximum 32 modele;
- același model poate apărea în tier-uri diferite;
- Windsurf permite spații ASCII interne; ceilalți folosesc IDs fără whitespace;
- ordinea modelelor este semnificativă;
- `payloadFingerprint` include base, planurile canonice și `auto`;
- `appliedFingerprint` este derivat per `{host, plan}` numai din cele trei
  tier-uri aplicate.

Payload-ul Claude generat în prezent este:

```json
{
  "payloadSchemaVersion": 2,
  "tiers": {
    "high": ["claude-opus-4-8", "claude-fable-5", "claude-opus-4-7", "opus"],
    "balanced": ["claude-sonnet-5", "claude-sonnet-4-6", "claude-opus-4-7", "sonnet"],
    "low": ["claude-haiku-4-5", "claude-sonnet-4-6", "haiku"],
    "auto": ["claude-sonnet-5", "claude-sonnet-4-6", "claude-opus-4-7", "sonnet"]
  }
}
```

## Transport și get_config

Fișiere principale:

- `src/shared/one-mcp/transport.ts`
- `src/shared/one-mcp/get-config.ts`
- `src/shared/one-mcp-sync.ts`

Transportul:

- trimite un `tools/call` anonim, fără bearer, cookie sau API key;
- setează `Content-Length` pe request;
- acceptă JSON și SSE chunked;
- selectează numai răspunsul JSON-RPC cu ID-ul cererii;
- citește incremental maximum 64 KiB;
- folosește response `Content-Length` numai ca early-size check pentru JSON;
- respinge status HTTP non-2xx, encoding, media type, UTF-8, JSON/SSE sau
  JSON-RPC invalid;
- are timeout implicit de 2 secunde.

Comportamentul sync-ului:

- `upToDate` păstrează cache-ul;
- `upToDate` fără cache v2 utilizabil repetă o singură dată cu version `0`;
- un full payload valid înlocuiește cache-ul, inclusiv la rollback server valid;
- `config_not_found` elimină configurația remote și revine la bundled;
- timeout/temp/schema invalidă păstrează ultimul cache valid, altfel bundled;
- networking-ul rulează în afara lock-ului;
- finalizarea folosește generation + identity CAS;
- niciun eșec remote nu blochează sesiunea sau onboarding-ul.

Parent SessionStart sincronizează numai hostul activ și numai când sunt adevărate
ambele condiții:

```text
build switch activ
pluginUse.enabled === true
```

## Contractele de stare

| Locație | Responsabilitate canonică |
| --- | --- |
| `~/.traffic-one/one-mcp.json` | Catalog remote versionat și diagnostic de sync |
| `~/.traffic-one/one.json` | Auth și `codeGraphProvider` |
| `~/.traffic-one/projects/<hash>/preferences.json` | Performance/team per host și Cursor `availableModels` |
| `.traffic-one/runs/<runId>/model-policy.json` | Snapshot imuabil pentru runul activ |
| `.traffic-one/runs/<runId>/agents.json` | Copiii verificați/reutilizabili ai runului |

### one-mcp.json

Implementare: `src/shared/one-mcp-cache.ts`.

- cache envelope schema v2, mode `0600`;
- câte o intrare per host;
- payload canonic, endpoint/configName, decoder și metadata server;
- `syncGeneration`, `lastSync` și `lastWarningKey`;
- fingerprints sunt derivate la citire, nu persistate redundant;
- lock bounded, re-read sub lock, temp write + rename și CAS;
- host siblings și câmpurile aditive sunt păstrate;
- future schema/decoder/payload nu sunt rescrise de un client vechi;
- cache-ul pre-release schema v1 este ignorat, nu migrat.

`lastSync` conține numai date bounded:

```ts
{
  attemptedAt,
  outcome,
  source,
  requestedVersion,
  observedVersion,
  reason?
}
```

Nu conține payload brut sau textul erorii remote.

### one.json

Implementare: `src/shared/one-settings.ts`.

- rămâne schema v3;
- conține auth și `codeGraphProvider`;
- mirror-ul legacy `hosts.*.tiers` este eliminat la următoarea scriere;
- writerul păstrează chei aditive necunoscute și scrie atomic.

Vechiul subsistem `model-status` a fost eliminat împreună cu configul, clientul,
refresh runnerul și testele lui.

### preferences.json și Performance

Implementări principale:

- `src/shared/state/local-prefs.ts`
- `src/shared/onboarding/local-prefs.ts`
- `src/shared/onboarding-server/flow.ts`

Starea per host păstrează:

- `performance`;
- `team`;
- `availableModels` numai pentru Cursor.

`configuredFor` și namespace-ul legacy `oneMcp` sunt eliminate fără backfill.
Acknowledgement-ul canonic este:

```json
{
  "plan": "pro",
  "appliedFingerprint": "<sha256>",
  "configVersion": 2
}
```

Repick:

- plan diferit — repick;
- model sau ordine schimbată în high/balanced/low — repick;
- schimbare doar în `auto` — fără repick;
- metadata/version-only — fără repick, `configVersion` avansează silențios;
- target exclusiv legacy — un singur repick;
- celelalte hosturi nu sunt invalidate.

`availableModels` Cursor este un lease cu TTL de 7 zile, legat de plan și
applied fingerprint. Conține slug-urile exacte oferite de Task picker și este
folosit pentru family-to-executable mapping; nu este catalog MCP.

## Snapshot imuabil per run

Fișier principal: `src/shared/run-model-policy.ts`.

Parentul creează atomic, create-once:

```text
.traffic-one/runs/<runId>/model-policy.json
```

Snapshotul conține host, plan, source, config version, fingerprints, Performance,
team overrides, cele trei tier-uri, modelul preferat și modelele acceptabile per
rol, plus Cursor picker slugs când este relevant.

Invariante:

- are mode `0600`, lock bounded și `policyId` derivat din conținut;
- un fișier valid existent câștigă întotdeauna;
- un fișier existent corupt nu este reconstruit din stare globală mutabilă;
- copiii, retry-urile, fallback-urile și exhaustion folosesc numai snapshotul;
- update-urile de plan/catalog mid-run afectează numai runul următor;
- un copil nu poate crea, repara sau rebase-ui snapshotul;
- Low/main-agent mode nu creează policy de subagenți.

## Codex model enforcement și agents.json

Fișiere principale:

- `src/shared/state/codex-model-observation.ts`
- `src/modules/agent-model/codex-child-model.ts`
- `src/modules/agent-model/handler.ts`
- `src/modules/agent-model/record-agent.ts`
- `src/shared/state/run-agent.ts`

Instrucțiunile de spawn Codex folosesc:

```json
{
  "task_name": "senior_architect",
  "message": "...",
  "fork_turns": "none",
  "model": "gpt-5.6-sol"
}
```

`fork_context` și afirmațiile că modelul nu poate fi transmis către Codex sunt
interzise prin teste statice.

Lifecycle:

1. Parent PostToolUse poate păstra intenția pentru diagnostic, dar nu creează
   claim Codex.
2. `SubagentStart` capturează child, parent, modelul real și policy ID.
3. Child PreToolUse completează/verifică rolul și este punctul blocant.
4. Stările sunt monotone: `pending-role -> verified | mismatch | conflict`.
5. Numai un copil `verified` primește claim și intrare reutilizabilă în
   `agents.json`.

Matching-ul Codex este exact față de modelele acceptabile ale rolului din
snapshot. Model/policy/identity lipsă sau conflictuală fail-closed. O corecție
autoritativă de rol poate reverifica aceeași observație, dar un conflict terminal
nu poate fi vindecat de un eveniment întârziat.

Limitare cunoscută: `SubagentStart` nu poate bloca hostul, deci un copil greșit
poate exista sau emite text până la primul tool. Nu poate primi claim, nu intră
în registry și nu poate folosi un tool.

## Universal MCP tool deny și registration

Fișiere principale:

- `src/shared/one-mcp-agent-tools.ts`
- `src/modules/one-mcp-tool-gate/`
- `src/gen/sources/hooks.ts`
- `src/gen/emit/manifests.ts`
- `src/shared/codex-mcp.ts`
- host wrappers OpenCode/Kilo/Windsurf.

Perechea exactă `{traffic-one-mcp, get_config|report_codebase_metadata}` este
blocată indiferent de auth sau pluginUse. Nume apropiate și alte servere rămân
neafectate. Hook-owned HTTP nu trece prin acest gate.

| Host | Înregistrare publică proiectată |
| --- | --- |
| Claude | omisă |
| Cursor | omisă |
| Windsurf | omisă |
| OpenCode | disabled + permission deny |
| Kilo | disabled + permission deny |
| Codex | disabled + ambele `disabled_tools` |
| Copilot | descriptor separat cu `tools: []` |

În Milestone 1, registration switch este `false`, deci nici aceste înregistrări
inerte nu sunt emise/aplicate. Entry-level fallbacks și wrapper-ele păstrează
deny-ul exact înainte de runtime spawn/parsing.

## Onboarding URL contract

Fișiere principale:

- `src/config/dashboard.ts`
- `src/shared/onboarding-server/ensure.ts`
- `src/shared/onboarding-server/wizard-links.ts`
- `src/runners/onboarding-wait/index.ts`
- `src/modules/onboarding-gate/handler.ts`

`EnsureResult` expune:

```ts
{
  dashboardUrl,
  localWizardUrl,
  redirectUrl
}
```

- dashboard-ul hosted este primary;
- fallback-ul afișat este exact `http://127.0.0.1:<port>/local?t=...`;
- root `/?t=...` este folosit numai pentru redirect/auto-open/registry;
- toate banner-ele și recovery paths afișează hosted + direct local;
- markerul este `wizard-links-shown-v2:<tokenHash>` și se scrie numai după ce
  ambele linkuri au fost incluse în output;
- un marker hosted-only vechi nu poate suprima fallback-ul;
- nu se mai promite că un hosted 404 face fallback automat.

## Parserul canonic apply_patch

Fișiere principale:

- `src/shared/apply-patch.ts`
- `src/core/types.ts`
- toate adaptoarele hosturilor;
- `src/modules/plan-guard/plan-write.ts`;
- `src/modules/plan-guard/plan-runteam.ts`;
- `src/modules/session/workspace-boundary-guard.ts`.

Acceptă formele atestate `input`, `patch`, `patchText`, `patch_text`, `diff`,
freeform și `output.args.patch`. Produce operații Add/Update/Delete/Move cu
`addedContent` și, unde există fișier rezultat, `resultContent`.

- Update/Move sunt reconstruite în memorie față de fișierul curent;
- un virtual filesystem păstrează ordinea operațiilor din patch;
- semantic checks folosesc `resultContent`;
- static checks folosesc numai `addedContent`;
- fiecare source/destination dintr-un patch multi-file este verificat;
- o singură încălcare blochează atomic întregul apel;
- un patch non-empty neparsabil sau nereconstruibil este respins fail-closed;
- Delete rămâne path-only.

Parserul implementează gramatica Codex `*** Begin Patch`, nu unified diff
arbitrar. Update/Move pe fișiere unreadable/binary sunt intenționat fail-closed.

## Reporting și auth

- `/mcp` cu API key rămâne numai pentru onboarding/auth validation.
- `get_config` și reporterul folosesc anonim `/public-mcp`.
- 401/403 public nu invalidează `one.json.auth`.
- reporterul păstrează deduplicarea `one-uid` și trimite numai metadata
  structurală permisă.
- nu a fost introdus flow-ul agent-driven `.one-mcp-id`.
- reporting este build-disabled în Milestone 1.

## Operator manifest, SQL și release evidence

Fișiere sursă:

- `src/gen/sources/one-mcp-operator.ts`
- `src/gen/emit/one-mcp-operator.ts`
- `src/gen/index.ts`

`npm run gen` produce:

- `dist/operator/one-mcp-model-configs.json`;
- `dist/operator/one-mcp-publish-cas.sql`.

Manifestul este derivat exclusiv din `HOST_MODELS`; overrides sparse sunt
expandate, iar `auto` este generat ca mirror al `balanced`.

SQL-ul trebuie rulat în proiectul Supabase care servește `/public-mcp`, asupra
tabelului `public.plugin_config`. Înainte de rulare, fiecare `null::integer`
trebuie înlocuit cu versiunea live observată pentru acel `config_name`.

SQL-ul:

- cere toate cele șapte rânduri și `served_publicly = true`;
- verifică fiecare versiune prin CAS;
- actualizează payload, `version + 1` și `updated_at`;
- rollback-uiește orice update parțial;
- verifică payload-ul și versiunea după update;
- nu modifică `served_publicly`.

Activarea oricărui public switch este blocată dacă:

- endpoint-ul compilat este încă domeniul direct Supabase;
- lipsește un live release snapshot proaspăt, maximum 15 minute;
- cele șapte payload-uri/versiuni/fingerprints nu coincid cu manifestul;
- lipsesc probele JSON, SSE și `upToDate` pentru fiecare config;
- lipsește hosted onboarding smoke;
- lipsesc observațiile live Codex Sol și Terra.

## Observații live din 17 iulie 2026

Un apel anonim real:

```text
get_config(
  config_name = traffic_one_claude_code_plugin_ai_model_configuration,
  version = 0
)
```

a răspuns HTTP 200 în aproximativ 1 secundă, dar rândul live Claude era încă:

- config version `1`;
- fără `payloadSchemaVersion`;
- cu modele cross-host precum `composer-2.5` și `gpt-5.5`.

Consecință: endpoint-ul este accesibil, dar payload-ul este respins corect ca
`invalid-full-config` de decoderul nou. Niciun rând production nu a fost
actualizat în cadrul acestui branch.

Testul Claude local a folosit un artifact instalat mai vechi din cache, deși
avea tot versiunea `2.9.265`. Artifactul avea schema v1 și public switches active;
build-ul curent are schema v2 și switches false. Un request din acel artifact a
înregistrat `transport-failed`, probabil timeout-ul strict de 2 secunde; cauza
remote exactă nu a fost persistată.

Înaintea următorului test real pe host este necesar un version bump/cachebuster,
reinstall și restart. Un simplu chat nou poate reutiliza bytes vechi cu același
semver.

Fișierul local pre-release `~/.traffic-one/one-mcp.json` schema v1 poate rămâne
pe disk cât timp sync-ul este oprit; codul nou îl ignoră și nu îl folosește ca
sursă runtime.

## Teste și verificare

Rulate înainte de commit:

```text
npm run typecheck       PASS
npm test                PASS — 1783/1783
npm run gen             PASS — 398 fișiere generate
npm run build           PASS
npm run golden:update   PASS — 393 intrări
npm run plugin:check    PASS — gen sincron, 349 build files byte-identical
npm run smoke           PASS — 24 module, 25 shims, toate 7 wrapper-ele fail-closed
git diff --check        PASS
```

`golden:update`, `plugin:check` și testele cu servere locale trebuie rulate în
afara unui sandbox care interzice sockets IPC/listeners; un `listen EPERM` în
acel sandbox nu reprezintă un defect logic.

Acoperirea nouă include:

- schema v2, plans, IDs, proto/depth, fingerprints și metadata;
- JSON/SSE chunked, UTF-8 split, 64 KiB, timeout și JSON-RPC invalid;
- cache mode 0600, locks, CAS, stale response, rollback și schema v1/future;
- once-per-session, opt-in, subagent și host-scoped sync;
- Performance plan/model/reorder/auto-only/metadata-only;
- run policy create-once, concurență, tamper și mutable-state drift;
- Codex event permutations, mismatch/conflict/correction și registry monotonic;
- universal tool deny pe șapte hosturi și near-collisions;
- toate formele apply_patch și multi-file workspace escapes;
- linkurile hosted/local și marker migration;
- operator manifest, CAS SQL și release evidence gate;
- reporting anonim și auth preservation.

## Blockere înainte de Milestone 2

1. Actualizarea celor șapte rânduri `public.plugin_config` cu schema v2.
2. Verificarea distinctă a payload-ului fiecărui host și incrementarea
   versiunilor prin SQL CAS.
3. Domeniu HTTPS custom cu WAF/rate-limit în locul URL-ului Supabase direct.
4. Hosted onboarding smoke.
5. Probe JSON/SSE/`upToDate` pentru toate config names.
6. Live Codex smoke care observă exact Sol și Terra în hook.
7. Generarea live release snapshot-ului în fereastra de 15 minute.
8. Activarea intenționată a celor trei build switches.
9. Version bump/cachebuster și reinstall pe toate hosturile testate.

Fixurile plugin-side nu trebuie ținute în loc de acești pași operatori; pot fi
livrate cu public switches false.

## Checklist de reluare

1. Citește acest document și `README.md`, secțiunea Public One MCP.
2. Verifică branch-ul și worktree-ul:

   ```text
   git status --short
   git log -1 --oneline
   ```

3. Editează catalogul numai în `src/config/model-tiers.ts#HOST_MODELS`.
4. Rulează `npm run gen` și inspectează cele două fișiere din `dist/operator/`.
5. Citește versiunile live din `public.plugin_config`.
6. Completează `expected_version` în SQL-ul CAS și rulează-l numai după review.
7. Repetă probele publice și compară fingerprints cu manifestul.
8. Configurează endpoint-ul WAF compilat și creează live release evidence.
9. Activează numai switch-ul necesar pentru testul curent; păstrează celelalte
   oprite până le sunt verificate suprafețele.
10. Fă version bump/cachebuster, regenerează și reinstalează pluginul pe host.
11. Verifică un parent session, un subagent corect și un mismatch intenționat.
12. Rulează întregul command chain înainte de următorul commit:

    ```text
    npm run typecheck
    npm test
    npm run gen
    npm run build
    npm run golden:update
    npm run plugin:check
    npm run smoke
    ```

## Fișiere de intrare recomandate

Pentru reluare rapidă, începe cu:

- `src/config/one-mcp.ts`
- `src/config/model-tiers.ts`
- `src/shared/one-mcp/`
- `src/shared/one-mcp-cache.ts`
- `src/shared/one-mcp-sync.ts`
- `src/shared/current-model-tiers.ts`
- `src/shared/run-model-policy.ts`
- `src/shared/state/codex-model-observation.ts`
- `src/modules/session/one-mcp-sync.ts`
- `src/modules/agent-model/codex-child-model.ts`
- `src/modules/one-mcp-tool-gate/`
- `src/shared/apply-patch.ts`
- `src/shared/onboarding-server/wizard-links.ts`
- `src/gen/sources/one-mcp-operator.ts`
- `README.md`

Acest document descrie intenționat atât implementarea, cât și ce nu este încă
activat. Nu interpreta existența codului de sync/registration/reporting ca dovadă
că serviciul public este gata de release.
