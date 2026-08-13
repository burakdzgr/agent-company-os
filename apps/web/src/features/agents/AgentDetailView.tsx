// Agent detail (24 §6.2): identity header, bindings, escalation chain,
// sessions table, lifecycle actions. Steps/Cost tabs land with T27+/T49.
import { useParams } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AgentAvatar, AgentStatusPill, Button, Card, DataTable } from "@acos/ui";
import { api, keys, queryClient } from "../../lib/api.js";

export function AgentDetailView() {
  const { companyId, agentId } = useParams({ from: "/c/$companyId/agents/$agentId" });
  const agent = useQuery({
    queryKey: keys.agent(companyId, agentId),
    queryFn: () => api.agents.get(companyId, agentId),
  });
  const bindings = useQuery({
    queryKey: keys.agentBindings(companyId, agentId),
    queryFn: () => api.agents.listBindings(companyId, agentId),
  });
  const sessions = useQuery({
    queryKey: keys.agentSessions(companyId, agentId),
    queryFn: () => api.agents.listSessions(companyId, agentId),
  });
  const chain = useQuery({
    queryKey: keys.agentChain(companyId, agentId),
    queryFn: () => api.org.chain(companyId, agentId),
  });

  const lifecycle = useMutation({
    mutationFn: (action: "pause" | "resume" | "offboard") =>
      api.agents.lifecycle(companyId, agentId, action),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: keys.agent(companyId, agentId) });
      await queryClient.invalidateQueries({ queryKey: keys.agents(companyId) });
      await queryClient.invalidateQueries({ queryKey: keys.orgEdges(companyId) });
    },
  });

  if (!agent.data) return <p className="text-sm text-ink-400">Yükleniyor…</p>;
  const a = agent.data;

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-center gap-4">
          <AgentAvatar name={a.name} imageUrl={a.avatarUrl} size={56} />
          <div>
            <h1 className="text-lg font-bold text-ink-900" data-testid="agent-name">
              {a.name}
            </h1>
            <p className="text-sm text-ink-400">
              {a.displayNumber} · {a.seniority} · otonomi L{a.autonomyLevel}
            </p>
          </div>
          <AgentStatusPill status={a.status} />
          <div className="ml-auto flex gap-2">
            {a.status === "active" && (
              <Button variant="secondary" onClick={() => lifecycle.mutate("pause")}>
                Duraklat
              </Button>
            )}
            {a.status === "paused" && (
              <Button variant="secondary" onClick={() => lifecycle.mutate("resume")}>
                Devam
              </Button>
            )}
            {a.status !== "offboarded" && (
              <Button variant="danger" onClick={() => lifecycle.mutate("offboard")}>
                İşten çıkar
              </Button>
            )}
          </div>
        </div>
        <p className="mt-3 text-sm text-ink-600">{a.persona}</p>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Model bağları (kimlik ⊥ model)">
          <DataTable
            rows={bindings.data ?? []}
            rowKey={(binding) => binding.id}
            empty="Özel bağ yok — şirket profilleri geçerli."
            columns={[
              { header: "Amaç", cell: (binding) => binding.purpose },
              { header: "Model", cell: (binding) => binding.model },
              { header: "Öncelik", cell: (binding) => String(binding.priority) },
            ]}
          />
        </Card>

        <Card title="Eskalasyon zinciri">
          <ol className="space-y-1 text-sm" data-testid="escalation-chain">
            {chain.data?.map((hop, index) => (
              <li key={index} className="text-ink-800">
                {index + 1}. {hop.kind === "founder" ? "Founder (sanal)" : hop.name}
              </li>
            ))}
          </ol>
        </Card>
      </div>

      <Card title="Oturumlar">
        <DataTable
          rows={sessions.data ?? []}
          rowKey={(session) => session.id}
          empty="Henüz oturum yok."
          columns={[
            { header: "İş akışı", cell: (session) => session.workflowId },
            { header: "Durum", cell: (session) => session.status },
            { header: "Adım", cell: (session) => String(session.stepsCount) },
            {
              header: "Başlangıç",
              cell: (session) => new Date(session.startedAt).toLocaleString(),
            },
          ]}
        />
      </Card>
    </div>
  );
}
