# ACOS — Kod İnceleme Raporu

> **UYGULAMA DURUMU (2026-08-15, commit `fa89840` sonrası)**
>
> | Bulgu | Durum | Not |
> |---|---|---|
> | **B2** prepare bağlantısı | ✅ uygulandı | `app.ts` sarmalayıcısına `prepare` köprüsü eklendi |
> | **B5** gözlem kırpma | ✅ uygulandı | Alan-farkındalıklı bütçe (son adım 24k, önceki 12k char), yük alanları ayrı bölümde, kırpma açıkça bildiriliyor, pencere 5→8. **Canlı doğrulama:** aynı ajan 38–39. adımda `fs.edit NO_MATCH` alırken, düzeltme canlıya çıkınca 40. adımda **başarılı düzenleme** yaptı |
> | **B3** timeout ayrıştırma | ✅ uygulandı | Tool dispatch ayrı proxy (45 dk, retry 1) + gateway `in_flight` yan etkili araçlarda fail-closed |
> | **Y7** temperature/refusal | ✅ uygulandı | `acceptsTemperature()` filtresi + yeni `refused` LlmError |
> | **B4** hayalet araçlar | ◑ kısmi | Katalogdan ve seed grant'ından çıkarıldı (adım+jeton yakımı durdu). `memory.search`/`task.query` dispatch'i **açık iş** |
> | **B1** router pricing | ⚠️ **rapordaki premis yanlıştı** | `model_providers.pricing` sütunu **yok** (grep + migration journal ile doğrulandı). Ayrıca doc 26 §3.1 **model-bazlı** fiyat istiyor, router ise sağlayıcı-bazlı anahtarlıyordu — yani düzeltme yalnız "wiring" değil, port şeklinin dokümana getirilmesi. Şema değişikliği olmayan yol seçildi: `packages/llm/src/pricing-defaults.ts` + model-farkındalı lookup. Bulgunun **sonucu** (her LLM çağrısı 0¢, `recordCost` hiç çağrılmıyor, INV-19 ölü) doğrulandı ve daha da kötü çıktı: `cost_entries` satırı hiç yazılmıyor |
> | **Y1** request_help/record_decision | ⏳ açık | Doğrulandı: `executeActionActivity` switch'inde case yok |
> | Y2–Y6, O1–O15 | ⏳ açık | Faz 3–4 |
>
> **Rapor kalitesi notu:** B1 dışındaki tüm bulgular kaynak okunarak birebir doğrulandı; B5 canlı davranışla da kanıtlandı. B1'in teşhisi doğru, dayandığı şema varsayımı yanlıştı — bulguyu uygularken doğrulama zinciri bunu yakaladı.

**Tarih:** 2026-08-15
**Kapsam:** Tüm repo (589 dosya, ~64k satır TS) — `main` @ `e7a28ed` + çalışma ağacındaki `fs.edit` değişikliği
**Okuyucu:** Bu raporu okuyup düzeltmeleri yazacak proje agent'ı
**Otorite:** `_DECISIONS.md` → `35-CLAUDE-CODE-HANDOFF.md` §12 (INV-1…21) → ADR

---

## 0. Yönetici özeti

Mimariye uyum **çok yüksek**. T01–T50 gerçekten uygulanmış, katman sınırları üç bağımsız ağla zorlanıyor, S8 konteyner sertleştirmesi eksiksiz, olay/outbox modeli doğru. `pnpm typecheck` ve tüm birim test paketleri **yeşil** (exit 0).

Ama sistem **canlı modda sessizce çalışmıyor**. Beş kusur var ki her biri tek başına "kod derleniyor, testler geçiyor, ajan hiçbir işi bitiremiyor" tablosunu üretiyor. Bunlar tip hatası değil — **wiring (bağlama) hataları** ve o yüzden hiçbir test yakalamıyor:

| # | Kusur | Sonuç |
|---|---|---|
| **B1** | `ModelRouter` `pricing` olmadan kuruluyor | Her LLM çağrısı **0 kuruş**. Bütçe guard'ı, şirket devre kesici, maliyet panosu tamamen ölü → **INV-19 ihlali** |
| **B2** | `prepare()` gerçek sunucuda hiç çağrılmıyor | İlk dokunuşta workspace kurulumu 10 sn'lik `fs.read` timeout'una sıkışıyor → ilk kodlama aracı çağrısı hep başarısız |
| **B3** | Temporal 120 sn vs `terminal.run` 1830 sn | Uzun komutlar **3 kez eşzamanlı** çalışıyor, sonra adım ölüyor |
| **B4** | 5 araç kayıtlı + ajana tanıtılıyor ama dispatch'i yok | `web.fetch`, `web.search`, `db.inspect`, `task.query`, `memory.search` her zaman hata veriyor (2'si seed'de grant'lı) |
| **B5** | Gözlem 200 karaktere kırpılıyor, sadece son 5 adım | Ajan okuduğu dosyayı **göremiyor** → son iki commit'in yamaladığı okuma-döngüsünün kök nedeni |

Öncelik sırası: **B1 → B2 → B3 → B5 → B4**. B1 ve B5 tek başına "ajan şirketi" fikrinin çalışıp çalışmadığını belirliyor.

---

## 1. BLOKER bulgular

### B1 — Tüm LLM maliyeti sıfır; bütçe guard'ı ve devre kesici ölü (INV-19)

**Kanıt zinciri:**

- [workers/agent-worker/src/main.ts:91](workers/agent-worker/src/main.ts#L91) — canlı router: `new ModelRouter({ providers, logCall: () => {} })` — **`pricing` verilmiyor**
- [workers/agent-worker/src/main.ts:56](workers/agent-worker/src/main.ts#L56) — scripted router: aynı şekilde eksik
- [packages/llm/src/router.ts:88](packages/llm/src/router.ts#L88) ve [:159](packages/llm/src/router.ts#L159) — `this.options.pricing?.get(...) ?? null`
- [packages/llm/src/types.ts:136](packages/llm/src/types.ts#L136) — `if (!pricing) return 0;`
- Repoda `model_providers.pricing` sütununu okuyup bir `Map`'e dolduran **hiçbir kod yok** (grep: yalnız tanım ve tüketim var, üretim yok)

**Zincirleme sonuç:**

1. `llmCalls.costCents` her zaman 0 → [agent-task.ts:632](workers/agent-worker/src/activities/agent-task.ts#L632)
2. `persistStepActivity` maliyeti hiç kaydetmiyor — `if (result.inserted && input.costCents > 0)` koşulu asla sağlanmıyor → [agent-task.ts:1068](workers/agent-worker/src/activities/agent-task.ts#L1068)
3. `tasks.spentCents` LLM harcamasıyla hiç artmıyor
4. Workflow guard (a) hiç tetiklenmiyor: `remainingCents` sabit kalıyor → [agent-task.workflow.ts:285-297](workers/agent-worker/src/workflows/agent-task.workflow.ts#L285-L297)
5. `CostService` şirket devre kesicisi hiç ateşlenmiyor → [packages/db/src/costs.ts:302](packages/db/src/costs.ts#L302)
6. Executive report / maliyet panosu LLM kalemini 0 gösteriyor

**INV-19 diyor ki:** *"Runaway guards are always on. Budget… checked every step; company daily-spend circuit breaker active."* Şu an bütçe boyutu tamamen kapalı. Tek gerçek maliyet `terminal.run`'ın süre tahmini.

**Düzeltme:**
1. `packages/db` içine `loadProviderPricing(db): Promise<Map<string, ProviderPricing>>` ekle — `model_providers` satırlarından `pricing` JSONB'yi okusun.
2. `buildLiveRouter` ve `buildScriptedRouter` içinde `new ModelRouter({ providers, pricing, logCall })` olarak geç.
3. `seed.ts` → `ensureLiveModelRouting` provider satırını **pricing ile** yazsın. Güncel Anthropic liste fiyatları (USD/1M token → `*PerMTokCents`):
   - `claude-opus-5`: giriş 500¢, çıkış 2500¢
   - `claude-sonnet-5`: giriş 300¢, çıkış 1500¢ (2026-08-31'e kadar tanıtım 200¢/1000¢)
   - `claude-haiku-4-5`: giriş 100¢, çıkış 500¢
   - Önbellek okuma ≈ giriş × 0.1 → `cachedInputPerMTokCents`
4. **Regresyon testi:** entegrasyon testinde bir adım koştur, `llm_calls.cost_cents > 0` ve `tasks.spent_cents > 0` doğrula. Bu test olmadan hata geri gelir.

> **Not:** `logCall: () => {}` de prod'da router çağrı günlüğünü çöpe atıyor. Gözlemlenebilirlik (25) için pino'ya bağla.

---

### B2 — `prepare()` gerçek sunucuda asla çağrılmıyor → ilk dokunuş kesin timeout

[apps/server/src/app.ts:326-333](apps/server/src/app.ts#L326-L333) gateway'e geç-bağlanan port'u veriyor:

```ts
dispatch: {
  dispatch: (invocation) => { ... return app.toolDispatchPort.dispatch(invocation); },
},
```

Bu nesne **yalnız `dispatch`** taşıyor. `ToolDispatchPort.prepare` opsiyonel olduğu için TS şikâyet etmiyor. Gateway ise [gateway.ts:529](apps/server/src/modules/tools/gateway.ts#L529) `if (this.dispatchPort.prepare)` diye kontrol ediyor → `undefined` → **atlanıyor**.

`prepare` tam olarak şunun için var ([gateway.ts:104-111](apps/server/src/modules/tools/gateway.ts#L104-L111)): bare repo klonu + imaj çekme + konteyner oluşturmayı **aracın çalışma penceresinin dışında**, kendi 10 dakikalık `PREPARE_TIMEOUT_MS` bütçesinde yapmak. Atlandığı için tüm kurulum `dispatch()` içinde, yani `def.timeoutMs` altında oluyor:

- `fs.read` → **10 sn** içinde repo klonla + imaj çek + konteyner ayağa kaldır
- `fs.write` / `fs.edit` → 15 sn
- `git.diff` → 30 sn

Bir görevin ilk araç çağrısı `fs.read` ise (tipik davranış) **kesin başarısız**. `dispatch.ts:206-216` yorumu bu tasarımı doğru anlatıyor ama bağlantı kopuk.

**Düzeltme:** `app.ts`'deki sarmalayıcıya `prepare`'i de ekle:

```ts
dispatch: {
  prepare: (req) => app.toolDispatchPort?.prepare?.(req) ?? Promise.resolve(),
  dispatch: (invocation) => { ... },
},
```

**Regresyon testi:** `tool-gateway.int.test.ts`'e sahte port ile "prepare çağrıldı mı" assert'i ekle.

---

### B3 — Aktivite timeout'u araç timeout'undan kısa → aynı komut 3 kez eşzamanlı çalışıyor

- [agent-task.workflow.ts:32-35](workers/agent-worker/src/workflows/agent-task.workflow.ts#L32-L35): tüm aktiviteler `startToCloseTimeout: "120s"`, `retry: { maximumAttempts: 3 }`
- [packages/tools/src/definitions.ts:156](packages/tools/src/definitions.ts#L156): `terminal.run` `timeoutMs: 1_830_000` (30,5 dk), şema `timeoutSec` üst sınırı 1800
- [gateway.ts:125](apps/server/src/modules/tools/gateway.ts#L125): `PREPARE_TIMEOUT_MS = 600_000` (10 dk)

`executeActionActivity` gateway'e HTTP çağrısı yapıyor. 120 sn'de Temporal aktiviteyi iptal edip **yeniden deniyor**. Yeni deneme aynı `idempotencyKey: tool:${stepId}` ile geliyor ([agent-task.ts:732](workers/agent-worker/src/activities/agent-task.ts#L732)) — ama gateway'in idempotency mantığı ([gateway.ts:259](apps/server/src/modules/tools/gateway.ts#L259)):

```
// fresh | in_flight → proceed (in_flight: the crashed first attempt
// never recorded a result; this attempt takes over the key)
```

Birinci deneme hâlâ konteynerde koşarken ikinci deneme **devam ediyor ve komutu tekrar çalıştırıyor**. `npm install`, migration, test suite → 3 paralel kopya, sonra 3. denemede adım ölüyor. Aynı sorun `prepare`'in 10 dk bütçesini de anlamsız kılıyor (120 sn'lik tavanın altında).

**Düzeltme (üçü birlikte):**
1. Aktivite proxy'lerini ayır: kısa DB aktiviteleri için 120 sn; `executeActionActivity` için `startToCloseTimeout` ≥ `PREPARE_TIMEOUT_MS + max(tool.timeoutMs)` (≈ 45 dk) + `heartbeatTimeout` ekle ve dispatch sırasında heartbeat at.
2. Yan etkisi olan araçlar (`sideEffectFree: false`) için `retry: { maximumAttempts: 1 }` — tekrar denemek zaten güvenli değil.
3. Gateway'de `in_flight` davranışını yan etkiye göre ayır: `sideEffectFree === false` ise `in_flight` → devam etme, `IN_FLIGHT_DUPLICATE` dönüp fail-closed ol. Salt-okunur araçlarda mevcut davranış kalsın.

---

### B4 — 5 araç kayıtlı ve ajana tanıtılıyor ama dispatch'i yok

[dispatch.ts:306](apps/server/src/modules/tools/dispatch.ts#L306) ve [dispatch.ts:582](apps/server/src/modules/tools/dispatch.ts#L582):

```ts
throw new DispatchError(`${tool.name} dispatch lands with a later task (T42/T43/T45)`);
```

Ama `PROGRESS.md`'de T42, T43, T45 **tamamlandı** işaretli. Etkilenen araçlar: `db.inspect`, `web.fetch`, `web.search`, `task.query`, `memory.search`.

Ağırlaştırıcı iki nokta:

1. [agent-task.ts:558](workers/agent-worker/src/activities/agent-task.ts#L558) — sistem prompt'u bu 5 aracı **isim isim ajana tanıtıyor**. Ajan çağırıyor, gateway yetkilendiriyor, `tool_invocations` satırı açılıyor, dispatch patlıyor. Her deneme bir adım + bir LLM çağrısı yakıyor (50 adım bütçesinden).
2. [seed.ts:319](apps/server/src/seed.ts#L319) — `SEED_GRANT_TOOLS` içinde `task.query` ve `memory.search` **grant'lı**. Yani izin var, uygulama yok.

`memory.search`'ün olmaması özellikle can yakıcı: T45 hafıza geri getirme working set'e otomatik giriyor ama ajan **hedefli** arama yapamıyor.

**Düzeltme (öncelik sırasıyla):**
1. `memory.search` → `MemoryRetrievalService` zaten var, doğrudan bağla.
2. `task.query` → `TasksService` üzerinden şirket-kapsamlı sorgu.
3. `web.fetch` / `web.search` → egress proxy üzerinden; çıktı `provenance: "web"` ile dönmeli (S5 fence'i buna bağlı).
4. `db.inspect` → B7'deki güvenlik düzeltmesi yapılmadan **bağlama**.
5. Bağlanmayanları hem `MVP_TOOLS`'tan hem [agent-task.ts:558](workers/agent-worker/src/activities/agent-task.ts#L558) katalog satırından hem de seed grant'ından **çıkar**. Var olmayan aracı tanıtmak, hiç tanıtmamaktan kötüdür.

---

### B5 — Ajan gözlemleri 200 karaktere kırpılıyor → ajan fiilen kör

[agent-task.ts:526](workers/agent-worker/src/activities/agent-task.ts#L526):

```ts
const compact = JSON.stringify(s.observation ?? {}).slice(0, 200);
```

Bu satır, working set'e giren **her** adım gözlemini 200 karaktere indiriyor. [agent-task.ts:355](workers/agent-worker/src/activities/agent-task.ts#L355) ise yalnız **son 5 adımı** çekiyor.

Somut sonuç: ajan `fs.read` ile 700 satırlık dosyayı okuyor; bir sonraki working set'te gördüğü şey ~200 karakterlik bir JSON parçası — çoğu `{"ok":true,"tool":"fs.read","decision":"allow","status":"succeeded","exitCode":0,"output":{"kind":"file","content":"` başlığıyla dolu. **Dosya içeriği hiç ulaşmıyor.**

Bu, son iki commit'in semptom düzeyinde yamaladığı davranışın kök nedeni:
- `e7a28ed` — "8+ ardışık salt-okuma araç çağrısında fs.write/commit zorlaması (TASK-21 vakası: 50/50 adım keşif)"
- Ajan okuyor, göremiyor, tekrar okuyor, tekrar göremiyor → 50 adım keşifte eriyor. Guard doğru teşhis koymuş ama yanlış yerden müdahale ediyor: ajanı yazmaya **zorluyor**, oysa ajan yazacak bilgiye hiç sahip olmadı. Bu haliyle guard, kör bir ajanı üretim yapmaya zorluyor — `fs.write` ile 700 satırlık dosyayı yeniden yazma felaketinin (`fs.edit`'in doğuş sebebi, `definitions.ts:92-99`) muhtemel tetikleyicisi de bu.

**Düzeltme:**
1. Kırpmayı araç ve alan farkındalıklı yap. Öneri: gözlem başına ~8–12k karakter tavanı, `output.content` / `output.diff` / `output.stdoutTail` alanlarına ayrıcalık. Toplam working set bütçesini `08 §8`'in `char/4` token sezgisiyle yönet (halihazırda yorumu var, uygulaması yok).
2. `recentSteps` limitini 5'ten yükselt (8–10) **veya** son araç çıktısını ayrı bir "# Son araç çıktısı (tam)" bölümü olarak prompt'a ekle.
3. Kırpma yapıldığında bunu ajana **açıkça söyle**: `…[TRUNCATED: 14,203 more chars — re-read with range]`. Sessiz kırpma, ajanın eksik veriyle tam veri sanıp karar vermesine yol açıyor.
4. Bu düzeltmeden sonra `readStreak >= 8` guard'ını yeniden kalibre et — kök neden gidince eşik muhtemelen çok agresif kalacak.

---

## 2. YÜKSEK öncelikli bulgular

### Y1 — `request_help` ve `record_decision` bağlanmamış (INV-16 boşluğu)

[packages/llm/src/agent-action.ts:73](packages/llm/src/agent-action.ts#L73) ve [:93](packages/llm/src/agent-action.ts#L93) bu iki aksiyonu tanımlıyor, [agent-task.ts:564,567](workers/agent-worker/src/activities/agent-task.ts#L564-L567) prompt kataloğunda ajana tanıtıyor — ama `executeActionActivity` `switch`'inde **case yok**, `default`'a düşüyor ([agent-task.ts:1015](workers/agent-worker/src/activities/agent-task.ts#L1015)):

```ts
return { ok: false, error: `action ${action.type} not yet wired (T33+)` };
```

INV-16 aynen şöyle: *"Failures route to guards → **`request_help`** → escalation chain → (only if policy demands) Founder."* Yardım isteme yolunun kendisi kapalı. `record_decision` de kapalı olduğu halde `contemplationStreak` sayacında sayılıyor ([agent-task.workflow.ts:434-437](workers/agent-worker/src/workflows/agent-task.workflow.ts#L434-L437)) — ajan reddedilen bir aksiyonu tekrarlayıp plan-döngüsü guard'ını tetikliyor.

**Düzeltme:** `request_help` → `MessageService` ile `help_request` mesajı + `agent.help.requested` olayı + hedef `audience`'a göre alıcı çözümü. `record_decision` → `artifacts` tablosuna karar kaydı (ADR benzeri) + olay. İkisi de zaten var olan servislerle 30–50 satır.

### Y2 — `db.inspect` "salt okunur" değil (S3/R0 sınıflandırma hatası)

[definitions.ts:278](packages/tools/src/definitions.ts#L278):

```ts
.refine((q) => /^\s*(select|with|show|explain)\b/i.test(q), ...)
```

PostgreSQL'de bu yetmiyor:
- `WITH x AS (INSERT INTO t VALUES (1) RETURNING *) SELECT * FROM x` — **veri değiştiren CTE**, `WITH` ile başlıyor, testi geçiyor.
- `EXPLAIN ANALYZE DELETE FROM users` — `EXPLAIN ANALYZE` ifadeyi **gerçekten çalıştırır**.

Araç `risk: "R0"`, `sideEffectFree: true` ile işaretli; yani otonomi matrisi onu en düşük denetimle geçiriyor. Şu an dispatch'i yok (B4) — **bu düzeltme yapılmadan bağlanmamalı**.

**Düzeltme:** Regex savunması yeterli değil. Dispatch tarafında: ayrı bir salt-okunur DB rolü + `SET TRANSACTION READ ONLY` + `statement_timeout` + `EXPLAIN ANALYZE` reddi. Regex'i ikinci savunma hattı olarak `explain analyze` ve `\binsert|update|delete|merge\b` engelleyecek şekilde sıkılaştır.

### Y3 — `fs.write` / `fs.edit` büyük dosyalarda shell argüman sınırına çarpıyor

[dispatch.ts:392](apps/server/src/modules/tools/dispatch.ts#L392) ve [dispatch.ts:445-448](apps/server/src/modules/tools/dispatch.ts#L445-L448):

```ts
`printf '%s' ${shq(encodedNew)} | base64 -d > ${shq(path)}`
```

Base64 tüm içerik **tek shell argümanı** olarak gidiyor. Linux'ta `MAX_ARG_STRLEN` = 128 KB (32 sayfa). Base64 %33 şişirdiği için pratik tavan ≈ **96 KB kaynak dosya**. Ama şemalar `content: z.string().max(2_000_000)` ve `oldText/newText: max(200_000)` vaat ediyor.

`fs.edit` daha kırılgan: **tüm dosyayı** geri yazıyor, yani 100 KB'lık bir dosyada 3 satır değiştirmek bile patlıyor. Hata mesajı da `E2BIG` olarak `result.stderr`'den geliyor — ajan için anlaşılmaz.

**Düzeltme:** Argüman yerine **stdin** kullan. `SandboxHttp.exec` `stdin` alanını destekliyor mu kontrol et; desteklemiyorsa sandbox-manager exec API'sine ekle:

```ts
{ command: ["/bin/sh","-lc",`base64 -d > ${shq(path)}`], stdin: encodedNew }
```

Ayrıca şema tavanlarını gerçek limite indir ya da parçalı yazma uygula. `fs.read` tarafında da `head -c` ile alınan içerik `content.length` (UTF-16 birim) ile `maxBytes` (bayt) karşılaştırılıyor — çok baytlı karakterlerde yanlış; `Buffer.byteLength` kullan ([dispatch.ts:369](apps/server/src/modules/tools/dispatch.ts#L369)).

### Y4 — Grant kısıtları güvenilir şekilde uygulanmıyor

[gateway.ts:734](apps/server/src/modules/tools/gateway.ts#L734):

```ts
if (!c.pathPrefixes.some((prefix) => p.startsWith(prefix)))
```

- Normalizasyon yok: `src/../../etc/passwd` `startsWith("src/")` testini **geçer**. Şu an `safeRelPath` ([dispatch.ts:128](apps/server/src/modules/tools/dispatch.ts#L128)) `..` segmentini yakalıyor, yani sömürülebilir değil — ama savunma yanlış katmanda ve `safeRelPath` çağrılmayan bir yol eklenirse (`git.diff` `paths`, `git.commit` `paths` çağırıyor; yeni bir araç unutabilir) delik açılır.
- Sınır kontrolü yok: `src` öneki `srcret/` dizinine izin verir.

[gateway.ts:747](apps/server/src/modules/tools/gateway.ts#L747):

```ts
if (!new RegExp(pattern).test(input.branch))
```

- Regex **DB'den** geliyor ve **çapasız**: `branchPattern: "main"` deseni `not-main-really` dalını da geçirir.
- Kullanıcı/ajan kontrollü regex → **ReDoS**. Kötü bir desen gateway thread'ini kilitler.

[gateway.ts:753-757](apps/server/src/modules/tools/gateway.ts#L753-L757): `new URL(input.url)` `evaluateConstraints` içinde, `try/catch` **dışında** — bozuk URL yakalanmamış istisna → 500, `deny` değil (fail-closed ihlali).

**Düzeltme:** Yolları `path.posix.normalize` sonrası karşılaştır ve öneki `/` ile sonlandır. Regex yerine glob (`micromatch`) kullan ya da deseni `^…$` ile çapala + `re2` gibi lineer motor kullan. `new URL`'i `try/catch`'e al, hata → `{ ok: false, detail: "invalid_url", escalate: false }`.

### Y5 — Görev başına iki workspace, aynı volume, keyfi seçim

[packages/db/src/workspaces.ts:198-210](packages/db/src/workspaces.ts#L198-L210): canlı workspace araması `(taskId, isolationLevel)` ile anahtarlanıyor. Ama `volumeName = worktreeVolumeName(task.number, task.id)` — **izolasyon seviyesi içermiyor**.

Sonuç: `fs.read` (`analysis`) → 1. workspace; `fs.write` (`coding`) → 2. workspace. İkisi **aynı Docker volume'ünü** `/work`'e mount ediyor, `provisionWorktree` aynı volume adıyla ikinci kez çağrılıyor.

Yan etkiler:
- [dispatch.ts:236-241](apps/server/src/modules/tools/dispatch.ts#L236-L241) `git.merge` `where taskId` ile sorguluyor, `[workspaceRow]` **keyfi** birini alıyor.
- [agent-task.ts:184-195](workers/agent-worker/src/activities/agent-task.ts#L184-L195) `checkpointBranch` aynı şekilde `.limit(1)`.
- `analysis` seviyesi `network: "none"` ([isolation.ts:40](packages/tools/src/isolation.ts#L40)) — o konteynerde `terminal.run` çalışırsa `npm install` sessizce ölür.
- `analysis` mount'u `readonly: false` veriliyor ([dispatch.ts:156](apps/server/src/modules/tools/dispatch.ts#L156)) — [isolation.ts:22](packages/tools/src/isolation.ts#L22) yorumu "analysis; ro source" diyor. Doküman-kod çelişkisi.

**Düzeltme:** Görev başına **tek** workspace kur; seviyeyi görevin gerektirdiği **en yüksek** seviyeye yükselt (analysis < coding < testing) ve gerekirse konteyneri yeniden yarat. Alternatif: `volumeName`'e seviyeyi kat (ama o zaman worktree çoğalır — tercih edilmez). `git.merge`/`checkpointBranch` sorgularına deterministik sıralama ekle.

### Y6 — Maliyet transaction dışında; bütçe yarışı var

[gateway.ts:653-662](apps/server/src/modules/tools/gateway.ts#L653-L662): `costs.recordCost` invocation güncelleme transaction'ının **dışında**. Süreç arada ölürse çağrı `succeeded` görünür ama maliyet defterde yoktur.

Ayrıca bütçe kontrolü ([gateway.ts:790](apps/server/src/modules/tools/gateway.ts#L790)) rezervasyonsuz: N paralel çağrı aynı `remainingCents`'i okur, hepsi geçer, toplam bütçeyi aşar. `tightestBudget` `MAX_SAFE_INTEGER` fallback'i de bütçe satırı yoksa **sınırsız** demek.

**Düzeltme:** Maliyet yazımını invocation güncellemesiyle aynı tx'e al. Bütçe için ya `SELECT … FOR UPDATE` ile satır kilitle ya da tahmini maliyeti dispatch öncesi rezerve edip sonra düzelt.

### Y7 — Varsayılan model eski; thinking/effort hiç bağlanmamış; model yükseltmesi 400 verir

[seed.ts:113-114](apps/server/src/seed.ts#L113-L114):

```ts
const LIVE_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5";
const FAST_MODEL = process.env.ANTHROPIC_FAST_MODEL ?? "claude-haiku-4-5-20251001";
```

`claude-sonnet-4-5` legacy (hâlâ aktif, emekli değil) ama güncel nesil değil. Uzun ufuklu ajan döngüsü + kod incelemesi tam olarak yeni nesil modellerin en çok fark attığı iş. Güncel kimlikler: `claude-opus-5` (500¢/2500¢), `claude-sonnet-5` (300¢/1500¢), `claude-haiku-4-5` (100¢/500¢).

İki ek sorun:

1. **`thinking` / `effort` hiç geçilmiyor.** [ai-sdk.ts:52](packages/llm/src/adapters/ai-sdk.ts#L52) yalnız `temperature` geçiyor. 50 adımlık ajan döngüsünde adaptive thinking + `effort` en büyük kalite kaldıracı ve hiç kullanılmıyor.
2. **Model yükseltmesi çalışma zamanında 400 verir.** [ai-sdk.ts:52](packages/llm/src/adapters/ai-sdk.ts#L52) `temperature` tanımlıysa gönderiyor. Sonnet 5 / Opus 5 / Opus 4.7+ **varsayılan dışı `temperature`'ı 400 ile reddediyor**. `agent_model_bindings.params` veya `model_profiles.params` içinde temperature taşıyan herhangi bir kurulum, model satırı DB'den değiştirilir değiştirilmez patlar — ve bu yol tamamen veri-güdümlü olduğu için hiçbir test yakalamaz.

**Düzeltme:**
1. Adapter'a model-farkında parametre filtresi ekle: `temperature`/`top_p`/`top_k` yalnız bunları kabul eden modellere gitsin; aksi halde sessizce düşür (ve uyar).
2. `LlmRequest`'e `thinking?: {type:"adaptive"}` ve `effort?: "low"|"medium"|"high"|"xhigh"|"max"` ekle, `RoutingContext.params`'tan besle. Ajan döngüsü için `effort: "xhigh"` başlangıç noktası.
3. Varsayılanı `claude-sonnet-5` (maliyet/kalite dengesi) veya `claude-opus-5` (en zor ajan işi) yap; `ANTHROPIC_MODEL` override'ı kalsın.
4. `stop_reason: "refusal"` işleme yok — Opus 5 / Sonnet 5 sınıflandırıcıları HTTP 200 + `refusal` dönebiliyor. Adapter'da bunu ayrı bir sonuç olarak ele al, yoksa boş `content` parse hatası olarak görünür ve 2 tamir denemesi boşa gider.

---

## 3. ORTA öncelikli bulgular

| # | Konum | Bulgu | Öneri |
|---|---|---|---|
| O1 | [dispatch.ts:470-490](apps/server/src/modules/tools/dispatch.ts#L470-L490) | `fs.search` açıklaması "ripgrep" diyor, gerçekte `grep`. `glob` parametresi şemada var, dispatch'te **hiç kullanılmıyor** — sessizce yok sayılıyor | `rg` kullan (workspace imajına ekle) + `glob`'u `--glob`'a bağla; olmazsa şemadan çıkar |
| O2 | [tenant.ts:57-59](packages/db/src/tenant.ts#L57-L59) | Tenancy guard regex tabanlı: `WHERE`'den sonra **herhangi bir yerde** `company_id` geçmesi yeterli. İki tenant tablosunu birleştiren, yalnız birini süzen sorgu geçer | Güvenlik ağı olarak kabul edilebilir; ama INV-4'ün Phase 3 RLS'ini öne çek. En azından `TenancyViolationError` sayacını metrikleştir |
| O3 | [dispatch.ts:287,292](apps/server/src/modules/tools/dispatch.ts#L287-L292) | `git.merge` sonrası `workspaces.transition(...).catch(() => {})` ve `taskState.transition(...).catch(() => {})` — gerçek hatalar sessizce yutuluyor | Beklenen hata kodunu (idempotent replay) ayırt et, diğerlerini logla/yay |
| O4 | [agent-task.ts:204,213](workers/agent-worker/src/activities/agent-task.ts#L204-L213) | `checkpointBranch` idempotency anahtarı `Date.now() >> 13` (≈8,2 sn kova). Retry 8 sn sonra gelirse **anahtar değişir** → mükerrer commit + force push | `uuidv5("checkpoint", sessionId)` gibi deterministik anahtar kullan |
| O5 | [agent-task.ts:381-388](workers/agent-worker/src/activities/agent-task.ts#L381-L388) | Her adımda şirketin **tüm** ajanları belleğe çekiliyor (`ownerNames`) | Yalnız `kin` satırlarındaki `ownerAgentId`'ler için `inArray` sorgusu |
| O6 | [relay.ts:125-131](apps/server/src/modules/events/relay.ts#L125-L131) | Yayın seri + satır başına bir `UPDATE`. 500'lük batch = 1000 gidiş-dönüş. Ayrıca publish-sonrası-mark: 2 dk'lık NATS dedupe penceresinden uzun bir çökme mükerrer teslim üretir | `UPDATE … WHERE id = ANY($1)` ile toplu işaretle; kritik tüketicileri idempotent tut (çoğu zaten öyle) |
| O7 | [agent-task.ts:1065-1080](workers/agent-worker/src/activities/agent-task.ts#L1065-L1080) | `recordCost` `persistStep` tx'inin **dışında** (`.then` içinde). B1 düzeltilince bu yarış gerçek olur | Aynı tx'e taşı |
| O8 | [service.ts:26](apps/server/src/modules/auth/service.ts#L26) | `SESSION_COOKIE_OPTIONS` içinde `secure` yok | Prod'da `secure: true` (env'e bağlı) |
| O9 | [app.ts:161-182](apps/server/src/app.ts#L161-L182) | `AUTH_AUTOLOGIN` kimlik doğrulamasız GET'te Founder oturumu basıyor. Tek kullanıcı modu için bilinçli karar ama sunucu ağa açılırsa tam yetki devri | `.env.example`'a ve README'ye **kalın uyarı**; `AUTH_AUTOLOGIN` + `0.0.0.0` bind kombinasyonunda boot'ta uyar |
| O10 | [isolation.ts:104-129](packages/tools/src/isolation.ts#L104-L129) | `hardenedHostConfig` `User` alanı belirtmiyor. `acos/workspace-node` imajı `USER node` ayarlıyor ama başka imaj kullanılırsa root'ta çalışır | `User: "1000:1000"` ekle (imajdan bağımsız garanti) |
| O11 | [squid.conf:6](infrastructure/docker/egress-proxy/squid.conf#L6) | `acl workspaces src 172.30.0.0/16` sabit; `WORKSPACE_NETWORK` env ile değiştirilebilir ([isolation.ts:64](packages/tools/src/isolation.ts#L64)) → alt ağ tutmazsa **tüm egress sessizce reddedilir** | Subnet'i entrypoint'te env'den üret |
| O12 | [definitions.ts:415](packages/tools/src/definitions.ts#L415) | Yorum "The 13 MVP tools" diyor, `fs.edit` ile 14 oldu | Yorumu güncelle (registry testi sayıyı kilitliyorsa onu da) |
| O13 | [gateway.ts:276-279](apps/server/src/modules/tools/gateway.ts#L276-L279) | `subjectFilters[1]` hiç kullanılmıyor (ölü kod); `agent.positionId` null ise `eq(..., null)` üretiliyor | Diziyi kaldır, doğrudan `or(...)` içinde kur |
| O14 | [agent-task.workflow.ts:516](workers/agent-worker/src/workflows/agent-task.workflow.ts#L516) | `guard_stopped` sonucu oturumu `"completed"` olarak kapatıyor | `guard_stopped` → `"failed"` ya da yeni bir durum |
| O15 | [gateway.ts:557-579](apps/server/src/modules/tools/gateway.ts#L557-L579) | Dispatch hatasında `tool_invocations` güncelleniyor ama **`tool.invocation.failed` olayı yayılmıyor** — zaman çizelgesinde başarısızlık görünmüyor | Katalogda karşılığı varsa olayı yay; yoksa `completed` olayına `status` alanı ekle |

---

## 4. Doğru yapılmış — dokunma

Bu bölüm, düzeltme yapacak agent'ın yanlışlıkla bozmaması için:

- **S8 konteyner sertleştirmesi eksiksiz** ([isolation.ts:104-129](packages/tools/src/isolation.ts#L104-L129)): `CapDrop: ["ALL"]`, `no-new-privileges`, `ReadonlyRootfs`, `/tmp` tmpfs `noexec,nosuid` + boyut sınırı, pids/cpu/mem tavanları, host mount yok, `analysis` için `network: none`. Şablon kalite.
- **S1 tek Docker sahibi**: yalnız `services/sandbox-manager` dockerode kullanıyor; internal API bearer ile korunuyor ([app.ts:32-51](services/sandbox-manager/src/app.ts#L32-L51)).
- **INV-14 reviewer bağımsızlığı üç yerde** zorlanıyor ([reviews.ts:130,210,311](packages/db/src/reviews.ts#L130)) — istek, atama ve karar anında.
- **WS topic yetkilendirmesi fail-closed** ([gateway.ts:404-419](apps/server/src/modules/realtime/gateway.ts#L404-L419)): terminal → workspace → project → company zinciri SQL'de çözülüyor, çözülemezse reddediliyor. Fanout yetkilendirmesi abone olma anında yapılmış — doğru tasarım.
- **Outbox (INV-11)**: aynı transaction'da append, şirket başına boşluksuz `seq` ([outbox.ts:56](packages/db/src/outbox.ts#L56)), commit'te `pg_notify`, advisory-lock lider seçimi, NATS `msgID` dedupe. Doğru.
- **Aktivite idempotensi**: `uuidv5(stepId)` türevli anahtarlar (`llm:`, `create-task:`, `approval`, `msg`, `tool:`) — replay güvenli.
- **S5 taint/fence sistemi** ([taint.ts](packages/tools/src/taint.ts)): deterministik, versiyonlu, güven sınırında LLM yok; fence escape nötrleştirmesi merkezi. Doğru tasarım.
- **Sınır zorlaması üç bağımsız ağ**: `eslint-plugin-boundaries` + `check-deps.ts` + TS project references.
- **CI beş aşamalı**: dependency-rule → lint/typecheck → unit → Testcontainers entegrasyon → scripted-LLM ile compose e2e.
- **Ölçüm durumu:** `pnpm typecheck` exit 0; tüm workspace birim test paketleri geçiyor.
- **`fs.edit` eklemesi doğru tasarlanmış** (çalışma ağacında): eşleştirme Node tarafında, shell escape yok, eşleşme yoksa/muğlaksa yazma yok. Yalnız Y3'teki argüman sınırı sorunu var.

---

## 5. Önerilen çalışma sırası

**Faz 1 — sistemi çalışır hale getir (bu olmadan diğerleri anlamsız)**
1. B1 — router pricing + seed pricing + regresyon testi
2. B2 — `prepare` bağlantısı + testi
3. B3 — aktivite timeout ayrıştırması + yan etkili araçlarda retry kapatma + `in_flight` fail-closed

**Faz 2 — ajanı yetkin hale getir**
4. B5 — gözlem kırpma politikası + adım penceresi + kırpma bildirimi
5. Y7 — model/thinking/effort + temperature filtresi + refusal işleme
6. B4 — `memory.search` ve `task.query` dispatch; bağlanmayanları katalogdan çıkar
7. Y1 — `request_help` + `record_decision`

**Faz 3 — güvenlik sertleştirme**
8. Y2 (`db.inspect` — bağlamadan önce), Y4 (grant kısıtları), Y3 (stdin yazma)
9. O8, O9, O10, O11

**Faz 4 — doğruluk ve performans**
10. Y5 (workspace tekilleştirme), Y6/O7 (maliyet tx), O3, O4, O5, O6
11. Kalan O maddeleri

**Her fazdan sonra:** `pnpm typecheck && pnpm test && pnpm test:int` ve `PROGRESS.md`'ye kayıt.

---

## 6. Notlar

- Bu rapordaki her bulgu doğrudan kaynak okunarak doğrulandı; satır numaraları `e7a28ed` + çalışma ağacı durumuna göredir.
- Mimari kararların hiçbiri sorgulanmadı — tüm öneriler mevcut `_DECISIONS.md` ve INV-1…21 çerçevesinin **içinde**. Şema değişikliği gerektiren tek yer yok; B1'in pricing verisi zaten var olan `model_providers.pricing` JSONB sütununa yazılıyor.
- `docs/architecture/docs/PROMPT2codeindexportadapter.md` ve `apps/web/handoff-emre.mjs` takipsiz dosyalar; inceleme kapsamı dışında bırakıldı.
