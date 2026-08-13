// Organizasyon içe aktarma (Founder direktifi 2026-08-14): JSON (tam şema —
// birimler + pozisyonlar + ajanlar) veya CSV (yalnız ajan satırları) yapıştır/
// yükle → önizleme → sıralı kurulum. HİÇBİR yeni backend yüzeyi yok: her satır
// MEVCUT denetimli endpoint'lerden geçer (createUnit / createPosition / hire),
// yani tüm org kuralları (tek yönetici, döngüsüzlük, model bağı seed'i) sunucu
// tarafında aynen işler ve her adım event-audit'lidir. Kısmi hata satır satır
// raporlanır — import atomik değildir (bilinçli: mevcut API sözleşmesi).
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Agent, OrgUnit, Position } from "@acos/contracts";
import { Button, Dialog, Textarea } from "@acos/ui";
import { AcosApiError } from "@acos/contracts/client";
import { api, keys, queryClient } from "../../lib/api.js";

const SENIORITIES = new Set(["junior", "mid", "senior", "staff", "lead", "expert"]);
const UNIT_KINDS = new Set(["department", "team", "office", "division"]);

export const IMPORT_TEMPLATE = `{
  "units": [
    { "name": "Engineering", "slug": "engineering", "kind": "department", "parent": null },
    { "name": "Backend", "slug": "backend", "kind": "team", "parent": "engineering" }
  ],
  "positions": [
    { "title": "CEO", "defaultRole": "executive" },
    { "title": "Engineering Manager", "defaultRole": "manager" },
    { "title": "Backend Engineer", "defaultRole": "member" }
  ],
  "agents": [
    { "name": "Aylin Vural", "position": "CEO", "unit": "engineering", "manager": null,
      "seniority": "expert", "autonomyLevel": 3, "persona": "Vizyoner CEO — hedefleri görevlere böler." },
    { "name": "Kerem Yıldız", "position": "Engineering Manager", "unit": "engineering",
      "manager": "Aylin Vural", "seniority": "lead", "autonomyLevel": 2, "leadsUnit": true,
      "persona": "Pragmatik mühendislik yöneticisi.", "expertise": ["typescript", "postgres"] }
  ]
}`;

interface UnitSpec {
  name: string;
  slug: string;
  kind: "department" | "team" | "office" | "division";
  parent: string | null;
}
interface PositionSpec {
  title: string;
  defaultRole: string;
}
interface AgentSpec {
  name: string;
  position: string;
  unit: string;
  manager: string | null;
  seniority: string;
  autonomyLevel: number;
  persona: string;
  expertise: string[];
  leadsUnit: boolean;
  activate: boolean;
}
interface ImportPlan {
  units: UnitSpec[];
  positions: PositionSpec[];
  agents: AgentSpec[];
}

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v.trim() : fallback;
}

/** Basit CSV ayrıştırıcı — çift tırnaklı alanları destekler. */
function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') inQuotes = false;
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows;
}

/** JSON (tam şema) veya CSV (yalnız ajanlar; başlık satırı zorunlu) → plan. */
export function parseImport(text: string): { plan: ImportPlan; problems: string[] } {
  const problems: string[] = [];
  const plan: ImportPlan = { units: [], positions: [], agents: [] };
  const trimmed = text.trim();
  if (trimmed === "") return { plan, problems: ["içerik boş"] };

  if (trimmed.startsWith("{")) {
    let doc: Record<string, unknown>;
    try {
      doc = JSON.parse(trimmed) as Record<string, unknown>;
    } catch (err) {
      return { plan, problems: [`JSON ayrıştırılamadı: ${String(err)}`] };
    }
    for (const raw of Array.isArray(doc.units) ? doc.units : []) {
      const u = raw as Record<string, unknown>;
      const name = asString(u.name);
      const slug = asString(u.slug) || name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const kind = asString(u.kind, "department");
      if (!name) problems.push("birim: 'name' zorunlu");
      else if (!UNIT_KINDS.has(kind)) problems.push(`birim ${name}: kind '${kind}' geçersiz (department|team|office|division)`);
      else plan.units.push({ name, slug, kind: kind as UnitSpec["kind"], parent: asString(u.parent) || null });
    }
    for (const raw of Array.isArray(doc.positions) ? doc.positions : []) {
      const p = raw as Record<string, unknown>;
      const title = asString(p.title);
      if (!title) problems.push("pozisyon: 'title' zorunlu");
      else plan.positions.push({ title, defaultRole: asString(p.defaultRole, "member") || "member" });
    }
    for (const raw of Array.isArray(doc.agents) ? doc.agents : []) {
      const a = raw as Record<string, unknown>;
      const name = asString(a.name);
      if (!name) {
        problems.push("ajan: 'name' zorunlu");
        continue;
      }
      const seniority = asString(a.seniority, "mid") || "mid";
      if (!SENIORITIES.has(seniority)) {
        problems.push(`ajan ${name}: seniority '${seniority}' geçersiz (junior|mid|senior|staff|lead|expert)`);
        continue;
      }
      const autonomy = typeof a.autonomyLevel === "number" ? a.autonomyLevel : 2;
      plan.agents.push({
        name,
        position: asString(a.position),
        unit: asString(a.unit),
        manager: asString(a.manager) || null,
        seniority,
        autonomyLevel: Math.max(0, Math.min(5, Math.round(autonomy))),
        persona: asString(a.persona) || `${asString(a.position) || "Uzman"} — otonom ajan.`,
        expertise: Array.isArray(a.expertise) ? a.expertise.map((e) => asString(e)).filter(Boolean) : [],
        leadsUnit: a.leadsUnit === true,
        activate: a.activate !== false,
      });
    }
    if (plan.units.length + plan.positions.length + plan.agents.length === 0) {
      problems.push("JSON'da units/positions/agents bulunamadı");
    }
    return { plan, problems };
  }

  // CSV — yalnız ajan satırları; başlıklar: name,position,unit,manager,seniority,autonomyLevel,persona,expertise
  const rows = parseCsvRows(trimmed);
  if (rows.length < 2) return { plan, problems: ["CSV: başlık satırı + en az bir veri satırı gerekli"] };
  const headers = rows[0]!.map((h) => h.trim().toLowerCase());
  const idx = (k: string) => headers.indexOf(k);
  if (idx("name") === -1) return { plan, problems: ["CSV: 'name' sütunu zorunlu"] };
  for (const [n, row] of rows.slice(1).entries()) {
    const get = (k: string) => (idx(k) === -1 ? "" : (row[idx(k)] ?? "").trim());
    const name = get("name");
    if (!name) {
      problems.push(`CSV satır ${n + 2}: name boş`);
      continue;
    }
    const seniority = get("seniority") || "mid";
    if (!SENIORITIES.has(seniority)) {
      problems.push(`CSV ${name}: seniority '${seniority}' geçersiz`);
      continue;
    }
    plan.agents.push({
      name,
      position: get("position"),
      unit: get("unit"),
      manager: get("manager") || null,
      seniority,
      autonomyLevel: Math.max(0, Math.min(5, Number(get("autonomylevel") || "2") || 2)),
      persona: get("persona") || `${get("position") || "Uzman"} — otonom ajan.`,
      expertise: get("expertise") ? get("expertise").split(";").map((e) => e.trim()).filter(Boolean) : [],
      leadsUnit: get("leadsunit").toLowerCase() === "true",
      activate: get("activate").toLowerCase() !== "false",
    });
  }
  return { plan, problems };
}

type StepState = { label: string; state: "ok" | "error" | "pending"; detail?: string };

export function OrgImportModal({ companyId, onClose }: { companyId: string; onClose: () => void }) {
  const [text, setText] = useState("");
  const [steps, setSteps] = useState<StepState[]>([]);
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);

  const units = useQuery({ queryKey: keys.orgUnits(companyId), queryFn: () => api.org.listUnits(companyId) });
  const positions = useQuery({
    queryKey: keys.orgPositions(companyId),
    queryFn: () => api.org.listPositions(companyId),
  });
  const agents = useQuery({ queryKey: keys.agents(companyId), queryFn: () => api.agents.list(companyId) });

  const { plan, problems } = useMemo(() => parseImport(text), [text]);
  const parsed = plan.units.length + plan.positions.length + plan.agents.length > 0;

  async function runImport(): Promise<void> {
    setRunning(true);
    const log: StepState[] = [];
    const push = (s: StepState) => {
      log.push(s);
      setSteps([...log]);
    };
    const fail = (label: string, err: unknown) =>
      push({
        label,
        state: "error",
        detail: err instanceof AcosApiError ? (err.problem.detail ?? err.problem.code) : String(err),
      });

    // mevcut kayıtlar — eşleştirme referansları (slug/title/name, küçük harf)
    const unitBySlug = new Map<string, OrgUnit>(
      (units.data ?? []).map((u) => [u.slug.toLowerCase(), u]),
    );
    for (const u of units.data ?? []) unitBySlug.set(u.name.toLowerCase(), u);
    const positionByTitle = new Map<string, Position>(
      (positions.data ?? []).map((p) => [p.title.toLowerCase(), p]),
    );
    const agentByName = new Map<string, Agent>(
      (agents.data ?? [])
        .filter((a) => a.status !== "offboarded")
        .map((a) => [a.name.toLowerCase(), a]),
    );

    // 1) birimler — ebeveynler önce (dosya içi referans + mevcutlar)
    const pendingUnits = [...plan.units];
    let guard = pendingUnits.length + 1;
    while (pendingUnits.length > 0 && guard-- > 0) {
      for (let i = 0; i < pendingUnits.length; i++) {
        const spec = pendingUnits[i]!;
        if (unitBySlug.has(spec.slug.toLowerCase()) || unitBySlug.has(spec.name.toLowerCase())) {
          push({ label: `birim ${spec.name}`, state: "ok", detail: "zaten var — atlandı" });
          pendingUnits.splice(i, 1);
          i--;
          continue;
        }
        const parent = spec.parent ? unitBySlug.get(spec.parent.toLowerCase()) : null;
        if (spec.parent && !parent) continue; // ebeveyni sonraki turda kurulacak
        try {
          const created = await api.org.createUnit(companyId, {
            name: spec.name,
            slug: spec.slug,
            kind: spec.kind,
            parentId: parent?.id ?? null,
          });
          unitBySlug.set(created.slug.toLowerCase(), created);
          unitBySlug.set(created.name.toLowerCase(), created);
          push({ label: `birim ${spec.name}`, state: "ok" });
        } catch (err) {
          fail(`birim ${spec.name}`, err);
        }
        pendingUnits.splice(i, 1);
        i--;
      }
    }
    for (const spec of pendingUnits) {
      push({ label: `birim ${spec.name}`, state: "error", detail: `ebeveyn '${spec.parent}' bulunamadı` });
    }

    // 2) pozisyonlar
    for (const spec of plan.positions) {
      if (positionByTitle.has(spec.title.toLowerCase())) {
        push({ label: `pozisyon ${spec.title}`, state: "ok", detail: "zaten var — atlandı" });
        continue;
      }
      try {
        const created = await api.org.createPosition(companyId, {
          title: spec.title,
          seniorityTrack: ["junior", "mid", "senior", "staff", "lead", "expert"],
          defaultRole: spec.defaultRole,
        });
        positionByTitle.set(created.title.toLowerCase(), created);
        push({ label: `pozisyon ${spec.title}`, state: "ok" });
      } catch (err) {
        fail(`pozisyon ${spec.title}`, err);
      }
    }

    // 3) ajanlar — yöneticiler önce (dosya içi zincir; mevcut ajan da olabilir)
    const pendingAgents = [...plan.agents];
    guard = pendingAgents.length + 1;
    while (pendingAgents.length > 0 && guard-- > 0) {
      for (let i = 0; i < pendingAgents.length; i++) {
        const spec = pendingAgents[i]!;
        const manager = spec.manager ? agentByName.get(spec.manager.toLowerCase()) : null;
        if (spec.manager && !manager) {
          const managerInFile = pendingAgents.some(
            (a) => a.name.toLowerCase() === spec.manager!.toLowerCase(),
          );
          if (managerInFile) continue; // yöneticisi sonraki turda işe alınacak
        }
        pendingAgents.splice(i, 1);
        i--;
        if (agentByName.has(spec.name.toLowerCase())) {
          push({ label: `ajan ${spec.name}`, state: "ok", detail: "zaten var — atlandı" });
          continue;
        }
        const unit = unitBySlug.get(spec.unit.toLowerCase());
        const position = positionByTitle.get(spec.position.toLowerCase());
        if (!unit || !position) {
          push({
            label: `ajan ${spec.name}`,
            state: "error",
            detail: !unit ? `birim '${spec.unit}' yok` : `pozisyon '${spec.position}' yok`,
          });
          continue;
        }
        if (spec.manager && !manager) {
          push({ label: `ajan ${spec.name}`, state: "error", detail: `yönetici '${spec.manager}' bulunamadı` });
          continue;
        }
        try {
          const hired = await api.agents.hire(companyId, {
            name: spec.name,
            positionId: position.id,
            orgUnitId: unit.id,
            seniority: spec.seniority,
            autonomyLevel: spec.autonomyLevel,
            persona: spec.persona,
            managerAgentId: manager?.id ?? null,
            leadsUnit: spec.leadsUnit,
            activate: spec.activate,
            ...(spec.expertise.length > 0 && { expertise: spec.expertise }),
          });
          agentByName.set(hired.name.toLowerCase(), hired);
          push({ label: `ajan ${spec.name}`, state: "ok", detail: `${spec.position} · ${unit.name}` });
        } catch (err) {
          fail(`ajan ${spec.name}`, err);
        }
      }
    }

    await Promise.all([
      queryClient.invalidateQueries({ queryKey: keys.agents(companyId) }),
      queryClient.invalidateQueries({ queryKey: keys.orgUnits(companyId) }),
      queryClient.invalidateQueries({ queryKey: keys.orgPositions(companyId) }),
      queryClient.invalidateQueries({ queryKey: keys.orgEdges(companyId) }),
    ]);
    setRunning(false);
    setFinished(true);
  }

  const okCount = steps.filter((s) => s.state === "ok").length;
  const errCount = steps.filter((s) => s.state === "error").length;

  return (
    <Dialog open title="Organizasyonu içe aktar (JSON / CSV)" onClose={onClose}>
      <div className="space-y-3" data-testid="org-import-modal">
        {!finished && (
          <>
            <p className="text-xs text-ink-500">
              JSON tam şemayı destekler (birimler + pozisyonlar + ajanlar, yönetici zinciriyle);
              CSV yalnız ajan satırlarını (başlıklar:{" "}
              <code>name,position,unit,manager,seniority,autonomyLevel,persona,expertise</code>).
              Şablonu kopyalayıp web Claude&apos;a &quot;bana şu işi yapacak bir organizasyon kur&quot;
              diyerek doldurtabilirsiniz — çıktıyı buraya yapıştırın.
            </p>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                onClick={() => void navigator.clipboard.writeText(IMPORT_TEMPLATE)}
                data-testid="org-import-copy-template"
              >
                Şablonu kopyala
              </Button>
              <label className="inline-flex cursor-pointer items-center rounded-md bg-ink-100 px-3 py-1.5 text-sm text-ink-800 hover:bg-ink-200">
                Dosya yükle…
                <input
                  type="file"
                  accept=".json,.csv,application/json,text/csv"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    void file.text().then(setText);
                  }}
                />
              </label>
            </div>
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={12}
              placeholder='{"units": […], "positions": […], "agents": […]}  —  ya da CSV yapıştırın'
              className="font-mono text-xs"
              data-testid="org-import-text"
            />
            {text.trim() !== "" && (
              <div className="rounded border border-ink-200 bg-ink-50 px-3 py-2 text-xs" data-testid="org-import-preview">
                <p className="text-ink-800">
                  Önizleme: <strong>{plan.units.length}</strong> birim ·{" "}
                  <strong>{plan.positions.length}</strong> pozisyon ·{" "}
                  <strong>{plan.agents.length}</strong> ajan
                </p>
                {problems.length > 0 && (
                  <ul className="mt-1 list-disc pl-4 text-danger">
                    {problems.slice(0, 8).map((p, i) => (
                      <li key={i}>{p}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </>
        )}

        {steps.length > 0 && (
          <div className="max-h-56 space-y-0.5 overflow-y-auto rounded border border-ink-200 p-2 text-xs" data-testid="org-import-log">
            {steps.map((s, i) => (
              <p key={i} className={s.state === "error" ? "text-danger" : "text-ink-700"}>
                {s.state === "error" ? "✗" : "✓"} {s.label}
                {s.detail ? ` — ${s.detail}` : ""}
              </p>
            ))}
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          {finished && (
            <span className="mr-auto text-xs text-ink-600" data-testid="org-import-summary">
              Bitti: {okCount} başarılı, {errCount} hatalı
            </span>
          )}
          <Button variant="ghost" onClick={onClose}>
            {finished ? "Kapat" : "Vazgeç"}
          </Button>
          {!finished && (
            <Button
              disabled={!parsed || problems.length > 0 || running}
              onClick={() => void runImport()}
              data-testid="org-import-run"
            >
              {running ? "Kuruluyor…" : "İçe aktar"}
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
