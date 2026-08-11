// Agent grid (24 §6.2) — presence badges arrive with T24/T26; until then the
// lifecycle status pill stands in.
import { useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { AgentAvatar, AgentStatusPill, Button, Card, Select } from "@acos/ui";
import { api, keys } from "../../lib/api.js";
import { HireWizard } from "./HireWizard.js";

export function AgentsView() {
  const { companyId } = useParams({ from: "/c/$companyId" });
  const agents = useQuery({ queryKey: keys.agents(companyId), queryFn: () => api.agents.list(companyId) });
  const [statusFilter, setStatusFilter] = useState("");
  const [hireOpen, setHireOpen] = useState(false);

  const filtered = (agents.data ?? []).filter(
    (agent) => statusFilter === "" || agent.status === statusFilter,
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-lg font-bold text-ink-900">Agents</h1>
        <div className="flex items-center gap-2">
          <Select
            aria-label="Status filter"
            className="!w-40"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="">all statuses</option>
            <option value="active">active</option>
            <option value="paused">paused</option>
            <option value="draft">draft</option>
            <option value="offboarded">offboarded</option>
          </Select>
          <Button onClick={() => setHireOpen(true)} data-testid="hire-button">
            Hire agent
          </Button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <p className="py-12 text-center text-sm text-ink-400">
          No agents yet — hire from Organization.
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" data-testid="agent-grid">
          {filtered.map((agent) => (
            <Link
              key={agent.id}
              to="/c/$companyId/agents/$agentId"
              params={{ companyId, agentId: agent.id }}
            >
              <Card className="transition-shadow hover:shadow-md">
                <div className="flex items-center gap-3">
                  <AgentAvatar name={agent.name} imageUrl={agent.avatarUrl} />
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-ink-900">{agent.name}</p>
                    <p className="text-xs text-ink-400">
                      {agent.displayNumber} · {agent.seniority} · L{agent.autonomyLevel}
                    </p>
                  </div>
                  <span className="ml-auto">
                    <AgentStatusPill status={agent.status} />
                  </span>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}

      <HireWizard companyId={companyId} open={hireOpen} onClose={() => setHireOpen(false)} />
    </div>
  );
}
