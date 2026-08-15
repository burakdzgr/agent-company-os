# Code Review — agent-company-os Hafıza Altsistemi ve Runtime

Kapsam: `burakdzgr/agent-company-os` (main, clone edildi). Odak: "hafıza gerçek bir hafıza gibi
çalışmıyor, proje doğru çalışmıyor" şikâyeti. Bulgular kanıtlı (dosya:satır).

---

## TL;DR — asıl teşhis

Hafıza altsistemi **iyi tasarlanmış ve büyük ölçüde gerçekten kodlanmış** (şema, konsolidasyon
pipeline'ı, retrieval, promotion hepsi var). Panelin boş ("0 anı") olmasının ve hafızanın "canlı"
hissettirmemesinin sebebi model eksikliği değil, **üç somut kopukluk**:

1. **Hafıza yalnızca görev BİTİNCE oluşuyor** (terminal task trigger). "Çalışırken öğrenme" tetikleyicileri
   (N-olay, eskalasyon, deney, reflection) kodda yok — bilinçli MVP kısıtlaması.
2. **Hiçbir görev BİTMİYOR.** Ajanlar scripted modda 50 adım sınırına takılıp görevi **WAITING**'e park
   ediyor, **DONE** olmuyor → terminal event yok → konsolidasyon hiç tetiklenmiyor → 0 anı.
3. **Scripted modda hafıza zaten sahte.** LLM yokken extraction fixture'a bağlı; gerçek görevlerde
   `"Consolidated: none"` placeholder üretir. **Gerçek hafıza için live-LLM şart.**

Yani "model çalışmıyor" değil; **model besleme zinciri kopuk + demo scripted modda anlamlı veri üretmiyor.**

---

## ✅ DOĞRULAR (gerçekten iyi yapılmış)

**1. Hafıza şeması ve domain modeli spec'e sadık ve zengin.**
`packages/db/src/schema/memory.ts`, `packages/domain/src/entities/memory.ts`, migration
`0007_memory_knowledge.sql` + `0013_memory_retrievals.sql`. 8 tip, 3 scope, scope izolasyonu, evidence/
versions/relations/promotion tabloları — ADR-007 ve doc-12 ile birebir. Bu, birçok "AI memory" projesinden
daha olgun: vektör bir *index*, gerçek değil; ilişkisel satırlar source-of-truth.

**2. Konsolidasyon pipeline'ı (T44) gerçekten kodlanmış** — PROGRESS.md "PENDING" dese de.
`workers/agent-worker/src/workflows/memory/index.ts`: extract → importance (§5.2) → scope (§5.3) →
evidence (§5.7) → embed (§5.4) → similarity band (§5.5) → compare/merge/contradiction (§5.6) →
persist (§5.9) → promotion tetikleme. Deterministik aşamalar saf `@acos/domain` fonksiyonları, IO'lar
idempotent activity. NULL-embedding düşünce fallback'i (exact-title merge) düşünülmüş — iyi mühendislik.

**3. Retrieval / Working-Set (T45) ajan döngüsüne bağlı.**
`workers/agent-worker/src/activities/agent-task.ts:302,494` → `buildWorkingSetActivity` →
`retrieveForWorkingSet`. Skorlama `packages/db/src/memory-retrieval.ts` gerçekten kanonik formülü
kullanıyor (`scoreMemoryRetrieval`: cosine/importance/recencyDecay/confidence = 0.55/0.2/0.15/0.1),
per-scope bütçe ve retrieval-health flag'leri (§7.5) dahil. Yani "okumadan bulma" altyapısı hazır.

**4. Promotion / overlearning önleme var.** `packages/db/src/memory-promotion.ts` (600 satır):
distinct task/project sayımı, evidence eşiği, `derived_from` soyağacı. Konsolidasyon sonrası
`evaluatePromotionsActivity` tetikleniyor.

**5. Panel ve graf GERÇEK veriyle çalışıyor (mock değil).**
`apps/web/src/features/memory/MemoryGraph.tsx` + `MemoryView.tsx` TanStack `useQuery` + gerçek `api`;
`RealtimeDispatcher.tsx:43 case "memory.created"` ve `MemoryPanel.tsx` canlı fade-in var. Yani
görselleştirme boşluğu değil — **beslenecek veri yok.**

**6. Dağıtık sistem hijyeni sağlam.** Outbox → NATS → `memory-trigger` consumer → deterministik
workflow id ile dedupe (`apps/server/src/main.ts:173-205`, `trigger.ts`). uuidv5 idempotency key'leri,
budget/step_cap/loop guard'ları. Bu kısım ciddi yazılmış.

---

## ❌ YANLIŞLAR / neden "gerçek hafıza gibi" değil

**Y1. Hafıza yalnızca terminal görevde oluşuyor — canlı değil.**
`apps/server/src/modules/memory/trigger.ts`: yalnız `task.completed` / `task.failed` işleniyor. Yorum
açıkça diyor: *"Escalation/experiment/N-events triggers join with their owning tasks — recorded MVP
narrowing."* Yani doc-12 §5.0'daki "her 25 anlamlı olayda / eskalasyon çözülünce / deney bitince /
reflection'da" tetikleyicilerin **hiçbiri kodda yok.** Sonuç: ajan saatlerce çalışsa bile hafıza
oluşmaz; yalnız görev bitiminde toplu bir çıkarım olur. Senin "anlık, canlı akan hafıza" hissinin
eksik olmasının **doğrudan sebebi bu tasarım.**

**Y2. Görevler BİTMİYOR → konsolidasyon hiç çalışmıyor (panelin 0 olmasının asıl sebebi).**
`agent-task.workflow.ts:66` `STEP_HARD_CAP = 50`. Sınıra gelince `guardEscalateActivity` görevi
**WAITING**'e alıyor (`activities/agent-task.ts:1171`, "budget/step_cap/loop park the task"), DONE'a
DEĞİL. Son commit (`e7a28ed`) "okuma-döngüsü kırıcı: 8+ ardışık salt-okuma çağrısında fs.write/commit/
complete zorlaması — TASK-21: 50/50 adım keşif" — yani ajanlar scripted modda 50 adım boyunca sadece
dosya okuyup teslimat üretmeden takılıyordu. Ekrandaki board bunu doğruluyor: BİTTİ sütunu boş. Terminal
event yok → `memory-trigger` hiç ateşlenmiyor → 0 anı. Read-loop guard bir **yara bandı**, kök neden
scripted karar politikasının `complete_task`'a yakınsamaması.

**Y3. Scripted modda üretilen hafıza sahte/placeholder.**
`packages/llm/src/testing/embeddings.ts:108` `cannedConsolidation(fixtureKey)`: bilinen fixture yoksa
default dalı `"Consolidated: <key>"` / `"Deterministic canned extraction..."` döndürür. Gerçek CEO
görevlerinde `fixtureKey` olmadığı için bir görev bitse bile **çöp bir anı** oluşur, öğrenme değil.
Gerçek, anlamlı hafıza için **live-LLM modu zorunlu** (extraction + gerçek embedding). Bu, "kendi hafıza
modelimiz çalışmıyor" hissinin ikinci yarısı.

**Y4. PROGRESS.md gerçeği yansıtmıyor.** `docs/architecture/PROGRESS.md` T44/T45'i PENDING gösteriyor
ama ikisi de kodda uygulanmış. Source-of-truth kayması: ilerleme dokümanına güvenilemez, **kod esas
alınmalı.** (Ben ilk turda bu doküman yüzünden yanlış teşhis vermiştim; kod bunu düzeltti.)

**Y5. Trigger granülaritesi kaba → agent-scope kişisel teknik anıları neredeyse hiç oluşmuyor.**
"Ajan çalışırken öğrenir" premisi terminal-only tasarımla karşılanmıyor; agent lane çoğu zaman boş kalır,
dolayısıyla bir sonraki projede "portable technique" recall'ı da devreye giremez.

---

## 🔧 İYİLEŞTİRİLEBİLİR ALANLAR (öncelik sırası)

**İ1 (en yüksek kaldıraç). Görev tamamlanmasını gerçekten sağla.**
Scripted karar politikası demo görevlerinde deterministik olarak `complete_task`'a ulaşmalı; read-loop
guard'ı yara bandı olmaktan çıkarıp "keşif → teslimat → tamamlama" akışını garanti et. Bir görev BİTMEDEN
hiçbir hafıza akışı test edilemez. (Alternatif: hızlı doğrulama için live-LLM'e geç.)

**İ2. Eksik tetikleyicileri ekle → "canlı hafıza".**
`trigger.ts`'e N-anlamlı-olay (agent başına sayaç), `escalation.resolved`, `experiment.completed`,
reflection tetikleyicilerini ekle (doc-12 §5.0). Bu tek değişiklik hafızayı "görev sonu toplu"dan
"çalışırken sürekli"ye çevirir — senin asıl istediğin his.

**İ3. Çalışırken hafif "episodik adım hafızası".**
Konsolidasyonu beklemeden, her anlamlı ajan adımında ucuz bir episodic satır yaz (düşük importance,
sonra konsolidasyon toparlar). Panel böylece görev bitmeden "nefes alır". Gerçek "yaşayan ofis" hissinin
teknik karşılığı budur.

**İ4. Scripted modu dürüst yap.**
Ya "offline modda gerçek hafıza oluşmaz" diye net etiketle, ya da placeholder yerine görevin gerçek
içeriğinden türetilmiş sentetik ama makul anılar üret. En temizi: gerçek hafıza için kullanıcıyı
live-LLM'e yönlendir (küçük bir smoke run).

**İ5. PROGRESS.md ↔ kod uzlaştır.** T44/T45'i DONE işaretle; ilerleme dokümanını koddan üret (drift'i
önlemek için CI'da basit bir tutarlılık kontrolü).

**İ6. Canlı emit'i uçtan uca doğrula.** `memory.created` → outbox → NATS → `/ws` →
`RealtimeDispatcher` zinciri kodda var; bir görev bitirip panelin gerçekten canlı dolduğunu e2e ile
kanıtla (mevcut `11-learning-and-memory.spec.ts` görevi elle FAILED'e zorluyor — doğal DONE yolunu da
kapsayan bir test ekle).

---

## Kapanış

Bu bir "model yanlış" durumu değil; **iyi bir hafıza modeli, henüz düzgün beslenmiyor.** Kritik yol:
(1) görevleri gerçekten bitir → (2) canlı tetikleyicileri ekle → (3) gerçek hafıza için live-LLM.
Bunlar yapıldığında zaten var olan şema/pipeline/retrieval/promotion katmanı panelinizi gerçek,
büyüyen, kurumsallaşan bir hafızayla doldurur.
