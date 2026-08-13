// Office view — /c/$companyId/office (23 §5–8 skeleton): Pixi scene fed by
// the presence snapshot + office.* instruction deltas (via officeStore), an
// agent card popover with the "Open in Agent Monitor" link, and the debug
// inspector surface (last applied causeEventId). No animation code here —
// the office lint rule bans it outside the Pixi bridge.
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Button, Card, StatusPill } from "@acos/ui";
import { api, keys } from "../../lib/api.js";
import { useOfficeStore } from "../../stores/office.js";
import { usePresence } from "../../stores/presence.js";
import { useRealtimeStatus } from "../../realtime/RealtimeDispatcher.js";
import { OfficeCanvas } from "./OfficeCanvas.js";

export function OfficeView() {
  const { companyId } = useParams({ from: "/c/$companyId" });
  const status = useRealtimeStatus();
  const snapshot = usePresence((s) => s.snapshot);
  const badges = usePresence((s) => s.badges);
  const engine = useOfficeStore((s) => s.engine);
  const setLayout = useOfficeStore((s) => s.setLayout);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);

  // floor plan (U04): read-only REST projection of the projector's layout
  const layoutQuery = useQuery({
    queryKey: [companyId, "office", "layout"],
    queryFn: () => api.office.layout(companyId),
  });
  useEffect(() => {
    if (layoutQuery.data) setLayout(layoutQuery.data);
  }, [layoutQuery.data, setLayout]);

  const agentsQuery = useQuery({
    queryKey: keys.agents(companyId),
    queryFn: () => api.agents.list(companyId),
  });
  const avatarUrls = useMemo(
    () => new Map((agentsQuery.data ?? []).map((agent) => [agent.id, agent.avatarUrl])),
    [agentsQuery.data],
  );

  const selected = selectedAgentId
    ? snapshot?.agents.find((a) => a.agentId === selectedAgentId)
    : null;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold text-ink-900">Ofis</h1>
        <StatusPill tone={status === "open" ? "ok" : "warn"}>ws: {status}</StatusPill>
        <span className="text-xs text-ink-400" data-testid="office-agent-count">
          {snapshot?.agents.length ?? 0} ajan ofiste
        </span>
        <div className="ml-auto">
          <Button variant="ghost" onClick={() => setInspectorOpen((v) => !v)}>
            {inspectorOpen ? "İnceleyiciyi gizle" : "Debug inceleyici"}
          </Button>
        </div>
      </div>

      <Card className="h-[540px] overflow-hidden bg-[#0f1420] p-0">
        <OfficeCanvas onSelectAgent={setSelectedAgentId} avatarUrls={avatarUrls} />
      </Card>

      {selected && (
        <Card className="p-4" data-testid="agent-card-popover">
          <div className="flex items-center gap-3">
            <div>
              <div className="font-medium text-ink-900">{selected.name}</div>
              <StatusPill tone={badges[selected.agentId] === "OFFLINE" ? "neutral" : "ok"}>
                {badges[selected.agentId] ?? selected.badge}
              </StatusPill>
            </div>
            <div className="ml-auto flex gap-2">
              <Link to="/c/$companyId/agents/$agentId" params={{ companyId, agentId: selected.agentId }}>
                <Button variant="secondary">Ajan Monitöründe aç</Button>
              </Link>
              <Button variant="ghost" onClick={() => setSelectedAgentId(null)}>
                Kapat
              </Button>
            </div>
          </div>
        </Card>
      )}

      {inspectorOpen && (
        <Card className="p-4 text-xs" data-testid="office-inspector">
          <div className="mb-2 font-medium text-ink-700">
            Her animasyonun nedensel olay id'si var — son uygulanan:{" "}
            <code data-testid="last-applied-event-id">{engine.lastAppliedEventId ?? "—"}</code>
          </div>
          <pre className="max-h-48 overflow-auto rounded bg-ink-50 p-2">
            {JSON.stringify(engine.debugRing.slice(-20), null, 2)}
          </pre>
        </Card>
      )}
    </div>
  );
}
