// Organizasyon içe aktarma ayrıştırıcıları (SAF — React'sız, test edilebilir).
// İki tüketici var: OrgImportModal (tam org: units+positions+agents) ve
// PositionImportModal (yalnız pozisyon/rol listesi).

const SENIORITIES = new Set(["junior", "mid", "senior", "staff", "lead", "expert"]);
const UNIT_KINDS = new Set(["department", "team", "office", "division"]);
const ROLES = new Set(["executive", "manager", "lead", "member", "reviewer"]);

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

export const POSITION_TEMPLATE = `[
  { "title": "Backend Engineer", "defaultRole": "member" },
  { "title": "QA/Reviewer", "defaultRole": "reviewer" },
  { "title": "DevOps Lead", "defaultRole": "lead" }
]`;

export interface UnitSpec {
  name: string;
  slug: string;
  kind: "department" | "team" | "office" | "division";
  parent: string | null;
}
export interface PositionSpec {
  title: string;
  defaultRole: string;
}
export interface AgentSpec {
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
export interface ImportPlan {
  units: UnitSpec[];
  positions: PositionSpec[];
  agents: AgentSpec[];
}

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v.trim() : fallback;
}

/** Basit CSV ayrıştırıcı — çift tırnaklı alanları destekler. */
export function parseCsvRows(text: string): string[][] {
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

function parsePositionEntry(raw: unknown, problems: string[]): PositionSpec | null {
  const p = raw as Record<string, unknown>;
  const title = asString(p.title);
  if (!title) {
    problems.push("pozisyon: 'title' zorunlu");
    return null;
  }
  const role = asString(p.defaultRole, "member") || "member";
  if (!ROLES.has(role)) {
    problems.push(`pozisyon ${title}: defaultRole '${role}' geçersiz (executive|manager|lead|member|reviewer)`);
    return null;
  }
  return { title, defaultRole: role };
}

/**
 * Yalnız pozisyon/rol listesi: JSON dizisi [{title, defaultRole}] YA DA
 * satır-başına "Unvan, rol" (rol boşsa member; "title" başlık satırı atlanır).
 */
export function parsePositions(text: string): { positions: PositionSpec[]; problems: string[] } {
  const problems: string[] = [];
  const positions: PositionSpec[] = [];
  const trimmed = text.trim();
  if (trimmed === "") return { positions, problems: ["içerik boş"] };

  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    let doc: unknown;
    try {
      doc = JSON.parse(trimmed);
    } catch (err) {
      return { positions, problems: [`JSON ayrıştırılamadı: ${String(err)}`] };
    }
    const list = Array.isArray(doc)
      ? doc
      : Array.isArray((doc as Record<string, unknown>).positions)
        ? ((doc as Record<string, unknown>).positions as unknown[])
        : null;
    if (!list) return { positions, problems: ["JSON bir dizi ya da {\"positions\": […]} olmalı"] };
    for (const raw of list) {
      const spec = parsePositionEntry(raw, problems);
      if (spec) positions.push(spec);
    }
    return { positions, problems };
  }

  for (const row of parseCsvRows(trimmed)) {
    const title = (row[0] ?? "").trim();
    const role = (row[1] ?? "member").trim() || "member";
    if (title === "" || title.toLowerCase() === "title" || title.toLowerCase() === "unvan") continue;
    if (!ROLES.has(role)) {
      problems.push(`pozisyon ${title}: rol '${role}' geçersiz (executive|manager|lead|member|reviewer)`);
      continue;
    }
    positions.push({ title, defaultRole: role });
  }
  if (positions.length === 0 && problems.length === 0) problems.push("hiç pozisyon satırı bulunamadı");
  return { positions, problems };
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
      const spec = parsePositionEntry(raw, problems);
      if (spec) plan.positions.push(spec);
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
