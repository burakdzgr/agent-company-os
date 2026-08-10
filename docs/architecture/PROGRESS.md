# PROGRESS

İlerleme kaydı — görevler 35-CLAUDE-CODE-HANDOFF.md §9 (T01–T50) sırasına göre işaretlenir.

| Görev | Durum | Tarih | Not |
|---|---|---|---|
| T01 Scaffold monorepo | ✅ Tamamlandı | 2026-08-11 | pnpm 9.15.9 (corepack) + Turborepo; 13 workspace (`@acos/*`) exports map + composite tsconfig (references = §4 bağımlılık matrisi) + trivial index + 1'er geçen Vitest testi; kök turbo.json 28 §6 task grafiği; tsconfig.base.json strict bayrakları; eslint.config.mjs flat + ADR-004 agent-framework yasağı (`no-restricted-imports`); .env.example 28 §7 anahtarları Mode-B localhost defaultları; infrastructure/docker/compose.yaml (postgres pgvector:pg16, nats 2.10 `-js`, temporal auto-setup namespace=acos, temporal-ui) — 4 servis healthy doğrulandı, `acos` namespace kayıtlı. `pnpm install && build && lint && typecheck && test` 13 workspace'te yeşil. Not: nats healthcheck için `nats:2.10-alpine` varyantı kullanıldı (scratch imajda shell yok); boundaries/check-deps/CI T02'de. |
| T02 Boundary enforcement | ✅ Tamamlandı | 2026-08-11 | Üç bağımsız net: (1) eslint-plugin-boundaries v7 (13 element tipi, 35 §4 matrisi `policies` olarak; ui→contracts yalnızca `dependency.kind=type`; app→app yapısal olarak deny) + `import/no-internal-modules` (deep-import yasağı; izinli subpath'ler ilgili görevlerde eklenecek) + `no-restricted-imports` agent-framework yasağı; specifier çözümü build gerektirmesin diye resolver-only `tsconfig.eslint.json` (kaynak dosyalara paths map). (2) `scripts/check-deps.ts`: manifest ⊆ matris, Redis istemcileri + agent framework kara listesi (ADR-004/006), 13 workspace varlık kontrolü. (3) TS project references — check-deps `references == izinli bağımlılıklar` eşitliğini yapısal doğruluyor. Kabul: `scripts/*.test.ts` fixture süitleri (16 test) — her nette kasıtlı ihlal error üretiyor, temiz manifest/import geçiyor; gerçek repo her iki netten temiz. Kök scriptler: `pnpm check-deps`, `pnpm test:repo` (T06'da CI aşamalarına bağlanacak). |
| T03 packages/config | ✅ Tamamlandı | 2026-08-11 | `loadConfig(processEnv)`: 27 §13'teki tüm anahtarlar Zod (v4) şemasıyla; zorunlular (DATABASE_URL, NATS_URL, TEMPORAL_ADDRESS, MASTER_KEY 32-byte base64, SESSION_SECRET, INTERNAL_API_TOKEN) eksikse TÜM sorunları adlandırıp listeleyen `ConfigError`; `loadConfigOrExit` yazdırıp exit 1 (IO enjekte edilebilir, testli). Boş string = unset (opsiyoneller); hiç LLM sağlayıcı yoksa `llm.offlineProfile=true` (A3). Sabitler: `TASK_QUEUES` (agent-tasks/execution/memory/intake), `NATS_SUBJECT_PREFIX="co."`, `DEFAULT_BUDGETS.companyDailyCents=5000`. 11 test yeşil. `.env.example` 27 §13 ile hizalandı (EGRESS_PROXY_URL=egress-proxy DNS, OTEL boş⇒no-op). |
| T04 Compose infra services | ✅ Tamamlandı | 2026-08-11 | Temel compose.yaml T01'de: postgres (pgvector:pg16, `${DATA_DIR:-./data}/postgres`, pg_isready), nats (2.10 `-js`, `-m 8222` + healthz), temporal (auto-setup 1.25.2, ayrı `temporal`/`temporal_visibility` DB'leri, namespace `acos`, cluster-health healthcheck), temporal-ui (2.31.2). Bu görevde `compose.dev.yaml` overlay'i eklendi (şimdilik boş; app servislerinin `develop.watch` konfigi T05'te). Kabul: `up -d postgres nats temporal temporal-ui` → 4/4 healthy (iki kez doğrulandı), overlay `config --quiet` geçiyor. |
| T05 App Dockerfiles + full compose | ✅ Tamamlandı | 2026-08-11 | Stub'lar: server (Fastify, /healthz, gerçek boot T15'te), sandbox-manager (Fastify, 3010), agent-worker/execution-worker (node:http /healthz 3020/3021, Temporal kaydı T31/T40'ta), web (React 19 + Vite hello-world, gerçek shell T20'de). `Dockerfile.node` (paylaşımlı, APP_FILTER/APP_MAIN arg'lı) + `Dockerfile.web` (build stage → nginx prod stage; nginx `/api`+`/ws` proxy + SPA fallback + /healthz). compose.yaml'a 5 app servisi eklendi (S1: docker sock yalnız sandbox-manager'da); compose.dev.yaml Mode A: `develop.watch` sync + tsx watch/vite dev, web dev'de `ACOS_API_PROXY_TARGET=http://server:3000`. Kabul: tam `docker compose up` → 9/9 healthy; web SPA + /api proxy'si doğrulandı; Mode B (`pnpm turbo dev`) 5 servis host'ta ayakta. Not: bu makinede 3000 portu başka bir uygulamada — host mapping `${SERVER_PORT:-3000}:3000` ile override edilebilir (test SERVER_PORT=3100 ile koşuldu); egress-proxy T08'de. |
| T06 CI pipeline | ⬜ | | |
| T07 Testcontainers harness | ⬜ | | |
| T08 Egress proxy + workspace network | ⬜ | | |
| T09 packages/domain core | ⬜ | | |
| T10 Domain state machines + policies | ⬜ | | |
| T11 Drizzle schema + migrations 0001–0003 | ⬜ | | |
| T12 Migrations 0004–0011 | ⬜ | | |
| T13 Repositories + tenancy + outbox | ⬜ | | |
| T14 packages/events catalog | ⬜ | | |
| T15 apps/server skeleton + contracts base | ⬜ | | |
| T16 Auth module | ⬜ | | |
| T17 Companies module + seed v1 | ⬜ | | |
| T18 Org module | ⬜ | | |
| T19 Agents module | ⬜ | | |
| T20 Web shell + org/agents UI | ⬜ | | |
| T21 Outbox relay + JetStream | ⬜ | | |
| T22 Event emission audit + timeline API | ⬜ | | |
| T23 /ws gateway | ⬜ | | |
| T24 Web realtime client + Events view | ⬜ | | |
| T25 Office Projector (server) | ⬜ | | |
| T26 PixiJS office skeleton + Agent Monitor | ⬜ | | |
| T27 Task engine service | ⬜ | | |
| T28 Delegation + budgets | ⬜ | | |
| T29 packages/llm ModelRouter + adapters | ⬜ | | |
| T30 Fake ModelRouter | ⬜ | | |
| T31 agent-worker scaffold | ⬜ | | |
| T32 agentTaskWorkflow core loop | ⬜ | | |
| T33 Signals, inbox, communication | ⬜ | | |
| T34 Guards + continueAsNew + cost accounting | ⬜ | | |
| T35 Approvals engine + Approval Center | ⬜ | | |
| T36 M3 gate: toolless delegation E2E | ⬜ | | |
| T37 services/sandbox-manager | ⬜ | | |
| T38 Git model + workspaces | ⬜ | | |
| T39 Tool Gateway | ⬜ | | |
| T40 workers/execution-worker | ⬜ | | |
| T41 Terminal streaming UI | ⬜ | | |
| T42 Projects + intake | ⬜ | | |
| T43 Review flow + injection defenses | ⬜ | | |
| T44 memoryConsolidationWorkflow | ⬜ | | |
| T45 Retrieval in Working-Set | ⬜ | | |
| T46 Promotion + contradiction handling | ⬜ | | |
| T47 Skills & careers | ⬜ | | |
| T48 Memory Observatory | ⬜ | | |
| T49 Executive report + cost dashboards | ⬜ | | |
| T50 Full MVP E2E + hardening gate | ⬜ | | |
