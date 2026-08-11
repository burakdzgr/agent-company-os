// WS event → Query invalidation map (24 §4.2). Family-based rules over the
// implemented modules; unknown families invalidate nothing (their views land
// with later tasks and bring their rules along).
import type { Event } from "@acos/contracts";
import { keys } from "../lib/api.js";

type QueryKey = readonly unknown[];

export function invalidationKeysFor(cid: string, event: Event): QueryKey[] {
  const agentId = event.subject.agentId;
  const type = event.type;

  if (type.startsWith("agent.")) {
    const invalidated: QueryKey[] = [keys.agents(cid)];
    if (agentId) invalidated.push(keys.agent(cid, agentId));
    if (type === "agent.hired" || type === "agent.offboarded") invalidated.push(keys.orgEdges(cid));
    if (type === "agent.model.binding.changed" && agentId)
      invalidated.push(keys.agentBindings(cid, agentId));
    if (type.startsWith("agent.session") && agentId)
      invalidated.push(keys.agentSessions(cid, agentId));
    return invalidated;
  }
  if (
    type.startsWith("org.") ||
    type === "department.created" ||
    type === "team.created" ||
    type === "position.created" ||
    type === "position.updated"
  ) {
    return [keys.orgUnits(cid), keys.orgPositions(cid), keys.orgEdges(cid)];
  }
  if (type.startsWith("company.")) {
    return [[cid, "settings"], keys.companies];
  }
  return [];
}
