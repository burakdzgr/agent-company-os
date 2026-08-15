# ACOS — Uygulama Agent'ı Çalışma Brifingi

**Sürüm:** 2026-08-15 · `7219857` sonrası
**Bu dosya:** Yetki sınırların + birleştirilmiş iş listen. `CLAUDE.md` ile birlikte oku; çelişki olursa `CLAUDE.md` ve `_DECISIONS.md` üstündür.
**Kaynaklar:** `CODE-REVIEW-2026-08-15.md` (runtime incelemesi) + `CODEREVIEWHAFIZA.md` (hafıza incelemesi) — bu brifing ikisinin **kesişimini ve doğrulanmış halini** taşır.

---

## §1 — YETKİ SINIRLARI (önce bunu oku)

### 1.1 Neyi yeniden vermeyeceksin

`CLAUDE.md` "Mimari kararları YENİDEN VERME" derken kastedilen kapalı liste:

- **Stack seçimi** — Postgres/Temporal/NATS/Fastify/Drizzle/React yerine başkası
- **Var olan tablo/sütun/event/state adını değiştirmek, kaldırmak, anlamını değiştirmek**
- **State machine geçişlerini** değiştirmek (07 §5 kanonik tablosu)
- **INV-1…21 invariant'larından** birini gevşetmek
- **ADR'lerde reddedilmiş** bir şeyi geri getirmek (Redis, Kafka, K8s, üçüncü parti ajan framework'ü)

### 1.2 Neyi YAPMAKLA YÜKÜMLÜSÜN

Aşağıdakiler mimari karar **değildir** — mimarinin **uygulanmasıdır**, ve engellenmiş değil beklenen iştir:

- **Dokümanda tarif edilmiş ama kodda olmayan bir şeyi yazmak.** Doküman spec'tir; kod ondan geridir. Aradaki farkı kapatmak "yeniden karar vermek" değil, **eksik uygulamayı tamamlamaktır.**
- **Toplamalı (additive) migration** — yeni tablo, yeni nullable/default'lu sütun, yeni index. Var olan hiçbir şeyi bozmuyorsa ve bir dokümana dayanıyorsa **izinlidir**.
- **Kod ile dokümanın çeliştiği yerde kodu dokümana getirmek.** Port şekli, imza, veri şekli dahil.
- **Wiring hatalarını düzeltmek** — bir arayüz tanımlı ama bağlanmamışsa bağla.

### 1.3 Çelişki çözüm sırası (`CLAUDE.md`'den)

```
_DECISIONS.md  →  ilgili domain dokümanı (NN-*.md)  →  ADR
```

**Kod bu listede yok.** Yani kod bir domain dokümanıyla çeliştiğinde **doküman kazanır**, her seferinde. Kodu dokümana uydurmak asla yetki aşımı değildir; tersi (dokümanı koda uydurmak) yetki aşımıdır.

Domain dokümanı bir ADR ile çelişirse **domain dokümanı kazanır** (sıra yukarıda). Bu, ADR-015'in port şeklini doküman 26 §3.1 uğruna genişletmenin **izinli olduğu** anlamına gelir — nitekim öyle yaptın ve doğruydu.

### 1.4 Karar ağacı — bir şey yapmadan önce

```
Yapmak istediğim şey…
│
├─ Bir domain dokümanında / _DECISIONS'ta tarif edilmiş mi?
│   ├─ EVET → YAP. Doküman bölümünü commit mesajında ve kod yorumunda cite et. Sorma.
│   └─ HAYIR ↓
│
├─ Var olan bir tablo/sütun/event/state'i yeniden adlandırıyor,
│  kaldırıyor veya anlamını değiştiriyor muyum?
│   ├─ EVET → DUR. Sor.
│   └─ HAYIR ↓
│
├─ Tamamen toplamalı mı (yeni dosya / yeni sütun / yeni index),
│  var olan davranışı bozmuyor mu?
│   ├─ EVET → YAP. Gerekçeyi yaz.
│   └─ HAYIR → DUR. Sor.
```

### 1.5 Tıkandığında protokol

Bir bulguyu uygularken premisi yanlış çıkarsa:

1. **Hedefi koru, adımları at.** İnceleme raporu bir **hipotezdir**; ulaşılmak istenen **sonuç** bağlayıcıdır, önerilen adımlar değil. "`pricing` sütununu oku" adımı geçersizse, "LLM maliyeti gerçek olsun, INV-19 dirilsin" hedefi hâlâ geçerlidir.
2. **Cevaba bağlı olmayan her şeyi bitir.** Sıfır teslimatla bekleme.
3. **Varsayımını yazılı beyan et, devam et.** Kararı sonra da geri alabiliriz; yapılmamış iş geri alınamaz.
4. **Yalnızca şu durumda dur:** herhangi bir varsayımla ilerlemek geri dönülemez zarar verecekse (veri kaybı, güvenlik açığı, invariant ihlali).

> **B1'de tam olarak doğru davrandın:** premisi doğruladın, yanlış olduğunu kanıtladın, şema gerektirmeyen yarıyı (Option B) tamamladın, kalan yarıyı işaretledin. Bu istenen davranıştır. Tek eksik: §1.2'deki yetkiyi kullanıp migration'ı da yazabilirdin. Aşağıda açıkça yetkilendiriliyor.

### 1.6 Bir inceleme bulgusunu uygulamadan önce

Her bulgu için **önce premisi doğrula**, sonra kod yaz:

- İddia edilen dosya/satır/sütun/fonksiyon **gerçekten var mı?** (`grep`, `Read`)
- İddia edilen doküman bölümü **gerçekten öyle mi diyor?**
- Bulgunun **sonucu** (semptom) gözlemlenebilir mi?

Premis yanlış + sonuç doğruysa → **hedefi uygula, önerilen yolu değiştir** ve raporda düzelt.
Premis ve sonuç ikisi de yanlışsa → bulguyu reddet, gerekçeyi yaz.

---

## §2 — ŞU AN AÇIKÇA YETKİLENDİRİLEN İŞ: Migration 0014

**Durum:** B1'in kod yarısı bitti (`pricing-defaults.ts` + `resolveProviderPricing` + `main.ts` wiring + `logLlmCall`). Maliyet artık akıyor. **Kalan yarı: çalışma-zamanı düzenlenebilirliği.**

**Yetki:** `packages/db/migrations/0014_model_provider_pricing.sql` yazmaya **yetkilisin**. Sormana gerek yok. Gerekçe:

Doküman `docs/architecture/docs/26-COST-MANAGEMENT.md` §3.1 bu sütunu **adıyla, tipiyle ve JSON şekliyle** tarif ediyor:

```jsonc
// model_providers.pricing (JSONB), platform-level, editable in Settings → Providers
{
  "models": {
    "claude-sonnet-4-5": { "in_per_mtok_cents": 300, "out_per_mtok_cents": 1500,
                           "cached_in_per_mtok_cents": 30 }
  },
  "updated_at": "2026-08-01", "source": "manual"
}
```

Aynı bölüm `packages/llm/pricing-defaults.ts`'i de seed defaults kaynağı olarak emrediyor — onu zaten yazdın (`src/` altında; yol normalizasyonu, sapma değil).

Yani sütun **spec'in parçası**; eksikliği bir sapma. Eklemek §1.2'nin birinci maddesi. Ayrıca tamamen toplamalı (§1.4 üçüncü dal): `not null default '{}'::jsonb` ile var olan hiçbir satır bozulmaz.

**Yapılacaklar:**

1. `packages/db/src/schema/identity.ts` → `modelProviders`'a `pricing: jsonb("pricing").notNull().default({})` ekle (dosyadaki diğer jsonb sütunlarıyla aynı kalıp).
2. `drizzle-kit generate` ile migration + meta snapshot + journal kaydını **üret** (elle yazma — `@acos/db` lint'i `drizzle-kit check` koşuyor, snapshot'sız sütun lint'i kırar).
3. `packages/db`'ye `loadProviderPricing(db): Promise<Map<string, ProviderPricingEntry>>` ekle: `model_providers` satırlarını okusun, `pricing` JSONB'yi doküman şeklinden (`in_per_mtok_cents` snake_case) `ProviderPricingTable` şekline (`inputPerMTokCents` camelCase) çevirsin. **Boş `{}` ise `pricingDefaultsFor(kind)`'a düş** — böylece sütun boşken bugünkü davranış aynen korunur.
4. `main.ts:123-140`'ta `pricingDefaultsFor(row.kind)` yerine `loadProviderPricing` sonucunu kullan, defaults fallback olarak kalsın.
5. `seed.ts` → `ensureLiveModelRouting` provider satırını `pricing` ile bassın (doküman şekliyle, `source: "seed"`).
6. **Test:** `packages/db` entegrasyon testinde sütuna doküman-şekilli JSON yaz, `loadProviderPricing`'in doğru `ProviderPricingTable` ürettiğini doğrula. `packages/llm/src/pricing.test.ts` zaten lookup'ı kapsıyor — onu tekrarlama.

**Yapmayacakların:** `model_providers`'ın var olan sütunlarına dokunma; `llm_calls`/`cost_entries` şekline dokunma; fiyatı `llm_calls.cost_cents`'e denormalize etme davranışını değiştirme (26 §3.1: *"historical entries never re-price"*).

---

## §3 — DURUM TABLOSU

Yapılmış işi tekrar isteme. Doğrulanmış durum:

| Bulgu | Durum | Kanıt |
|---|---|---|
| **B1** LLM maliyeti 0 → INV-19 ölü | ✅ kod tarafı bitti · ⏳ migration açık | `pricing-defaults.ts`, `resolveProviderPricing`, `main.ts:123-140`, `logLlmCall` |
| **B2** `prepare()` bağlı değil | ✅ | `app.ts` sarmalayıcısında prepare köprüsü |
| **B3** timeout/retry uyumsuzluğu | ✅ | ayrı dispatch proxy (45 dk, retry 1) + `in_flight` fail-closed |
| **B5** gözlem 200 char kırpma | ✅ canlı doğrulandı | alan-farkındalı bütçe, pencere 5→8; 40. adımda başarılı `fs.edit` |
| **Y7** temperature/refusal | ✅ | `acceptsTemperature()` + `refused` LlmError |
| **Y1** `request_help`/`record_decision` | ✅ | `agent-task.ts:1016,1044` + exhaustiveness guard |
| **B4** hayalet araçlar | ◑ katalog+grant temizlendi · ⏳ dispatch açık | katalog 9 araç; `SEED_GRANT_TOOLS` = `fs.*`,`git.*`,`terminal.run` |
| Y2–Y6, O1–O15 | ⏳ açık | — |
| Hafıza katmanı (aşağıda §5) | ⏳ açık | `trigger.ts` hâlâ 72 satır, terminal-only |

---

## §4 — AÇIK İŞ LİSTESİ

### Faz A — devre kesiciyi tam kapat

**A1. Migration 0014** → §2. *Bu, B1'in son parçası.*

**A2. Maliyet transaction bütünlüğü (Y6/O7).** İki yerde maliyet, ait olduğu transaction'ın dışında yazılıyor:
- `gateway.ts:653-662` — `costs.recordCost`, invocation güncelleme tx'inin dışında
- `agent-task.ts` `persistStepActivity` — `.then()` içinde, adım tx'inin dışında

B1 düzeldiği için bu yarış artık **gerçek**: süreç arada ölürse çağrı `succeeded` görünür, maliyet defterde olmaz → bütçe eksik sayar. İkisini de kendi tx'ine al.

**A3. Bütçe yarışı (Y6).** `gateway.ts:790` `tightestBudget` rezervasyonsuz: N paralel çağrı aynı `remainingCents`'i okur, hepsi geçer. `SELECT … FOR UPDATE` ile satır kilitle **veya** tahmini maliyeti dispatch öncesi rezerve edip sonra düzelt. Ayrıca bütçe satırı yoksa `MAX_SAFE_INTEGER` dönüyor — yani **sınırsız**; seed'in her şirkete bir günlük bütçe satırı bastığından emin ol.

**A4. Devre kesici uçtan uca kanıt.** Entegrasyon testi: küçük bir günlük bütçe kur, sahte pahalı LLM çağrılarıyla eşiği aş, şunları doğrula — `cost_entries` satırları yazıldı, `tasks.spent_cents` arttı, workflow guard (a) tetiklendi, `CostService` devre kesicisi ajanları duraklattı (`employment.paused_by_breaker`), bütçe yükseltilince otomatik devam etti. **Bu test yoksa B1 geri gelir ve kimse fark etmez.**

### Faz B — ajanı iş bitirir hale getir

**B1'. `memory.search` + `task.query` dispatch (B4 kalanı).** İkisi de mevcut servislerle bağlanır: `MemoryRetrievalService` ve `TasksService`. Bağladıktan sonra katalog satırına (`agent-task.ts:597`) ve `SEED_GRANT_TOOLS`'a geri ekle. **Bağlamadığın aracı katalogda gösterme.**

**B2'. `web.fetch` / `web.search`.** Egress proxy üzerinden; çıktı `provenance: "web"` dönmeli — S5 fence'i buna bağlı (`agent-task.ts` `renderStep`).

**B3'. `db.inspect` — bağlamadan önce güvenliği düzelt (Y2).** `definitions.ts:278` regex'i yetersiz:
- `WITH x AS (INSERT … RETURNING) SELECT * FROM x` → veri değiştiren CTE, `WITH` ile başlıyor, testi geçiyor
- `EXPLAIN ANALYZE DELETE …` → ifadeyi gerçekten çalıştırır

Araç `risk: "R0"`, `sideEffectFree: true` — yani en düşük denetimle geçiyor. Düzeltme regex'te değil dispatch'te: ayrı salt-okunur DB rolü + `SET TRANSACTION READ ONLY` + `statement_timeout`; regex ikinci hat olarak `explain analyze` ve `\b(insert|update|delete|merge)\b` engellesin.

**B4'. `fs.write`/`fs.edit` argüman sınırı (Y3).** `dispatch.ts` base64'ü tek shell argümanı olarak geçiriyor; Linux `MAX_ARG_STRLEN` 128 KB → pratik tavan **~96 KB kaynak dosya**. Şemalar 2 MB / 200 KB vaat ediyor. `fs.edit` tüm dosyayı geri yazdığı için 100 KB'lık dosyada 3 satır değişikliği bile patlıyor, hata da ham `E2BIG`. **Düzeltme:** argüman yerine **stdin** kullan (`sandbox-manager` exec API'sinde `stdin` yoksa ekle). Şema tavanlarını gerçek limite indir.

### Faz C — güvenlik ve doğruluk

**C1. Grant kısıtları (Y4).** `gateway.ts:734` `p.startsWith(prefix)` normalize edilmemiş (`src` öneki `srcret/`'i geçirir; `..` yalnız `safeRelPath` sayesinde yakalanıyor — yanlış katmanda savunma). `gateway.ts:747` `new RegExp(pattern)` DB'den geliyor, **çapasız** (`"main"` deseni `not-main-really`'yi geçirir) ve **ReDoS**'a açık. `gateway.ts:753` `new URL()` try/catch dışında → bozuk URL 500 verir, `deny` değil (fail-closed ihlali).

**C2. Çift workspace (Y5).** `workspaces.ts:198-210` `(taskId, isolationLevel)` ile anahtarlıyor ama `volumeName` seviye içermiyor → `analysis` + `coding` iki workspace, **aynı volume**. `git.merge` ve `checkpointBranch` `[workspaceRow]` ile keyfi birini alıyor. `analysis` `network: "none"` olduğu için o konteynerde `terminal.run` sessizce ölür. Görev başına tek workspace kur, seviyeyi gerekene yükselt.

**C3.** O8 (cookie `secure`), O9 (`AUTH_AUTOLOGIN` uyarısı), O10 (`User: "1000:1000"`), O11 (squid subnet'i env'den üret).

### Faz D — kalan O maddeleri

O1 (fs.search `glob` sessizce yok sayılıyor + grep/ripgrep tutarsızlığı), O3 (`.catch(()=>{})` yutmaları), O4 (`checkpointBranch` `Date.now()>>13` idempotency), O5 (her adımda tüm ajanların yüklenmesi), O6 (relay toplu işaretleme), O12–O15.

---

## §5 — HAFIZA ALTSİSTEMİ (ikinci incelemeden, doğrulandı)

Hafıza şeması, konsolidasyon pipeline'ı, retrieval skorlaması ve promotion **gerçekten kodlanmış ve iyi**. Panel boş çünkü **beslenmiyor**.

**M1. Hafıza yalnız terminal görevde oluşuyor.** `apps/server/src/modules/memory/trigger.ts` toplam 72 satır, yalnız `task.completed` / `task.failed` işliyor. Doküman 12 §5.0'daki diğer tetikleyiciler (N-anlamlı-olay, `escalation.resolved`, `experiment.completed`, reflection) **kodda yok** — yorumda "recorded MVP narrowing" olarak kayıtlı.

→ **Yap:** 12 §5.0'daki tetikleyicileri ekle. Bu §1.2'nin birinci maddesi — dokümanda var, kodda yok. Hafızayı "görev sonu toplu"dan "çalışırken sürekli"ye çeviren tek değişiklik budur.

**M2. Tetikleyici zinciri sanılandan uzun.** Bunu iki inceleme de tek başına görmemişti:

`complete_task` **`DONE` üretmiyor** — `agent-task.ts:990` görevi `REVIEW`'a taşıyor. Repoda `DONE`'a yazan yalnız üç yol var:
- `dispatch.ts:291` — `git.merge` (tüm sandbox yığınını gerektirir)
- `review/activities.ts:105` — inceleme/QA zinciri
- `approvals.ts:523` — onay motoru

Yani `task.completed` olayı için: görev bitmeli → **bağımsız reviewer** bulunmalı (INV-14) → inceleme workflow'u koşmalı → QA/merge tamamlanmalı. Kod görevlerinde bu zincir B2/B3'ün kırdığı workspace yığınından geçiyordu; onlar düzeldi, ama zincirin uçtan uca koştuğu **hiç kanıtlanmadı**.

→ **Yap:** Bir e2e senaryosu: görev → `complete_task` → REVIEW → reviewer onayı → QA → merge → `task.completed` → `memory-trigger` → konsolidasyon → `memory.created` → `/ws` → panel. Mevcut `11-learning-and-memory.spec.ts` görevi elle `FAILED`'e zorluyor; **doğal DONE yolunu** kapsayan bir test ekle.

**M3. Scripted modda hafıza sahte.** `packages/llm/src/testing/embeddings.ts:108` `cannedConsolidation` bilinen fixture yoksa `"Consolidated: <key>"` döndürüyor. Gerçek görevlerde `fixtureKey` olmadığı için görev bitse bile **çöp anı** oluşur.

→ **Yap:** Ya scripted modda "gerçek hafıza oluşmaz" diye net etiketle (panelde de göster), ya da görevin gerçek içeriğinden türetilmiş makul sentetik anı üret. Anlamlı hafıza için live-LLM şart — bunu ürün metninde dürüstçe söyle.

**M4. Episodik adım hafızası (öneri).** Konsolidasyonu beklemeden her anlamlı ajan adımında düşük-importance bir episodic satır yaz; konsolidasyon sonra toparlasın. Panel görev bitmeden "nefes alır". **Önce M1'i yap, M4'ü ondan sonra değerlendir** — INV-15 (scope izolasyonu) ve INV-11 (append-only) ihlal edilmemeli.

> **Not:** İkinci inceleme `PROGRESS.md`'nin T44/T45'i PENDING gösterdiğini söylüyor. **Bu repoda yanlış** — ikisi de `✅ Tamamlandı | 2026-08-12`. O inceleme daha eski bir GitHub klonunda yapılmış; oradaki satır numaralarına güvenme, hepsini yerel kodda doğrula.

---

## §6 — HER DEĞİŞİKLİKTE

1. **Önce premisi doğrula** (§1.6). Rapor hipotez, kod gerçek.
2. **INV-1…21'i kontrol et.** Özellikle: INV-3 (her araç Gateway'den), INV-4 (her repo metodu `CompanyContext`), INV-11 (event append-only), INV-13 (`TaskStateService` tek yazar), INV-14 (reviewer ≠ author), INV-19 (guard'lar hep açık).
3. **Yeşil bırak:** `pnpm typecheck && pnpm lint && pnpm test`. Şemaya dokunduysan `pnpm --filter @acos/db lint` (drizzle-kit check dahil) ve `pnpm test:int`.
4. **Regresyon testi yaz** — özellikle wiring hataları için. B1/B2 tipi kusurlar tip sistemine görünmez; onları yalnız davranış testi tutar. Zaten geçen bir testi tekrar yazma (ör. `router.test.ts` fiyatlamayı kapsıyor; eksik olan **wiring** testiydi).
5. **`PROGRESS.md`'ye işle** — tamamlanan madde + tarih + not.
6. **Commit mesajında bulgu kodunu ve doküman bölümünü cite et** (`fix(cost): A1 — model_providers.pricing sütunu (26 §3.1)`).
7. **Bir şeyi yapmadıysan söyle.** Kapsamı sessizce daraltma; ne bıraktığını ve nedenini açıkça yaz.

---

## §7 — SIRA

```
A1 (migration 0014)  →  A2, A3  →  A4 (devre kesici e2e kanıtı)
   →  B1' (memory.search, task.query)  →  M1 (canlı tetikleyiciler)  →  M2 (uçtan uca kanıt)
   →  B3', B4', C1, C2  →  B2'  →  C3  →  Faz D  →  M3, M4
```

**A4 ve M2 pazarlık dışı.** İkisi de "kod var" ile "sistem çalışıyor" arasındaki farkı kapatan kanıtlardır — bu projenin tüm bloker'ları tam olarak o boşlukta yaşadı.
