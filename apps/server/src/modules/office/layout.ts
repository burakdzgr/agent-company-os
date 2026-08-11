// Default auto-layout (23 §2): computed server-side when a company has no
// saved layout. Deterministic — zones are seeded by org-unit UUID order, so
// the same org data always yields the same floor plan. Departments become
// rooms tiled left-to-right sized by headcount; members get one desk each
// (+25% spare, min 1); one central meeting area.
import type { OfficeLayout, OfficeZone, OfficeDesk } from "@acos/contracts";

export interface OrgUnitInput {
  id: string;
  name: string;
  kind: string;
  parentId: string | null;
}

export interface AgentInput {
  id: string;
  name: string;
  status: string;
  orgUnitId: string;
}

const GRID = { cellSize: 32, cols: 80, rows: 50 };
const ROOM_TOP = 2;
const ROOM_HEIGHT = 22;
const ROOM_GAP = 2;
const DESK_STEP = 2;

/** Walks a unit up to its department (or itself when already top-level). */
function departmentOf(unitId: string, unitsById: Map<string, OrgUnitInput>): OrgUnitInput | null {
  let current = unitsById.get(unitId) ?? null;
  for (let hops = 0; current && hops < 20; hops++) {
    if (current.kind === "department" || current.parentId === null) return current;
    current = unitsById.get(current.parentId) ?? null;
  }
  return current;
}

export function computeAutoLayout(units: OrgUnitInput[], agents: AgentInput[]): OfficeLayout {
  const unitsById = new Map(units.map((u) => [u.id, u]));
  const active = agents.filter((a) => a.status === "active" || a.status === "draft");

  // department bucket per agent (deterministic: departments sorted by uuid)
  const byDepartment = new Map<string, AgentInput[]>();
  for (const agent of active) {
    const department = departmentOf(agent.orgUnitId, unitsById);
    const key = department?.id ?? "unassigned";
    const bucket = byDepartment.get(key) ?? [];
    bucket.push(agent);
    byDepartment.set(key, bucket);
  }
  const departmentIds = [...byDepartment.keys()].sort();

  const zones: OfficeZone[] = [];
  let cursorX = 2;
  for (const departmentId of departmentIds) {
    const members = byDepartment
      .get(departmentId)!
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id));
    const deskCount = Math.max(members.length + Math.max(1, Math.ceil(members.length * 0.25)), 2);
    const desksPerRow = Math.max(2, Math.ceil(Math.sqrt(deskCount)));
    const width = desksPerRow * DESK_STEP + 3;

    const desks: OfficeDesk[] = [];
    for (let i = 0; i < deskCount; i++) {
      const row = Math.floor(i / desksPerRow);
      const col = i % desksPerRow;
      desks.push({
        id: `d_${departmentId.slice(-6)}_${i}`,
        cell: { x: cursorX + 2 + col * DESK_STEP, y: ROOM_TOP + 2 + row * DESK_STEP },
        agentId: members[i]?.id ?? null, // home desks persist in layout (23 §2)
      });
    }

    const unit = unitsById.get(departmentId);
    zones.push({
      id: `z_${departmentId.slice(-6)}`,
      kind: "department",
      ...(unit && { orgUnitId: unit.id }),
      rect: { x: cursorX, y: ROOM_TOP, w: width, h: ROOM_HEIGHT },
      label: unit?.name ?? "Unassigned",
      desks,
    });
    cursorX += width + ROOM_GAP;
  }

  zones.push({
    id: "z_meet_central",
    kind: "meeting",
    rect: { x: 2, y: ROOM_TOP + ROOM_HEIGHT + 2, w: 12, h: 8 },
    label: "Meeting Area",
    spots: 6,
  });

  return { version: 1, grid: GRID, zones, walls: [] };
}

/** First free desk in the agent's department zone, else anywhere (23 §2). */
export function assignHomeDesk(
  layout: OfficeLayout,
  agentId: string,
  agentUnitId: string | null,
  unitsById: Map<string, OrgUnitInput>,
): OfficeDesk | null {
  const department = agentUnitId ? departmentOf(agentUnitId, unitsById) : null;
  const zoneOrder = [...layout.zones].sort((a, b) => {
    const aHome = department && a.orgUnitId === department.id ? 0 : 1;
    const bHome = department && b.orgUnitId === department.id ? 0 : 1;
    return aHome - bHome || a.id.localeCompare(b.id);
  });
  for (const zone of zoneOrder) {
    for (const desk of zone.desks ?? []) {
      if (desk.agentId === agentId) return desk; // already assigned
      if (desk.agentId == null) {
        desk.agentId = agentId;
        return desk;
      }
    }
  }
  return null;
}

export function freeDesk(layout: OfficeLayout, agentId: string): void {
  for (const zone of layout.zones) {
    for (const desk of zone.desks ?? []) {
      if (desk.agentId === agentId) desk.agentId = null;
    }
  }
}

export function deskOf(layout: OfficeLayout, agentId: string): OfficeDesk | null {
  for (const zone of layout.zones) {
    for (const desk of zone.desks ?? []) {
      if (desk.agentId === agentId) return desk;
    }
  }
  return null;
}

/** Straight L-shaped grid path (x first, then y) — deterministic, ≤200 cells. */
export function gridPath(from: { x: number; y: number }, to: { x: number; y: number }) {
  const path: Array<{ x: number; y: number }> = [];
  const stepX = to.x > from.x ? 1 : -1;
  for (let x = from.x; x !== to.x; x += stepX) path.push({ x: x + stepX, y: from.y });
  const stepY = to.y > from.y ? 1 : -1;
  for (let y = from.y; y !== to.y; y += stepY) path.push({ x: to.x, y: y + stepY });
  if (path.length === 0) path.push({ ...to });
  return path.slice(0, 200);
}
