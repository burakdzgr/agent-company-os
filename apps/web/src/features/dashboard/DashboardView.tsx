// T48+UI: Unified dashboard — all key panels in one view
// Tasks + Memory + Agents + Projects in a responsive grid
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { api, keys } from "../../lib/api.js";

export function DashboardView() {
  const { companyId } = useParams({ from: "/c/$companyId" });
  
  const tasks = useQuery({
    queryKey: keys.tasks(companyId),
    queryFn: () => api.tasks.list(companyId),
  });
  
  const memories = useQuery({
    queryKey: keys.memories(companyId),
    queryFn: () => api.memory.list(companyId, {}),
  });
  
  const agents = useQuery({
    queryKey: keys.agents(companyId),
    queryFn: () => api.agents.list(companyId),
  });
  
  return (
    <div className="h-full overflow-auto bg-acos-bg0 p-4">
      <div className="mb-4">
        <h1 className="text-2xl font-bold text-acos-fg0">🏢 Komuta Merkezi</h1>
        <p className="text-sm text-acos-fg2">Tüm şirket durumu tek ekranda</p>
      </div>
      
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3">
        {/* Quick Links Panel */}
        <div className="col-span-1 rounded-lg border border-acos-line bg-acos-bg1 p-4 lg:col-span-2">
          <h2 className="mb-3 text-sm font-semibold text-acos-fg1">🏢 HIZLI ERİŞİM</h2>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            {[
              { to: `/c/${companyId}/office`, icon: "🏢", label: "Ofis" },
              { to: `/c/${companyId}/tasks`, icon: "▦", label: "Görevler" },
              { to: `/c/${companyId}/agents`, icon: "👤", label: "Ajanlar" },
              { to: `/c/${companyId}/memory`, icon: "🧠", label: "Hafıza" },
              { to: `/c/${companyId}/projects`, icon: "📁", label: "Projeler" },
              { to: `/c/${companyId}/communication`, icon: "💬", label: "İletişim" },
              { to: `/c/${companyId}/terminals`, icon: "⌨", label: "Terminaller" },
              { to: `/c/${companyId}/approvals`, icon: "✓", label: "Onaylar" },
            ].map((link) => (
              <Link
                key={link.to}
                to={link.to}
                className="flex flex-col items-center justify-center rounded-lg border border-acos-line bg-acos-bg2 p-4 transition hover:border-dept-engineering hover:bg-acos-bg3"
              >
                <span className="text-2xl">{link.icon}</span>
                <span className="mt-1 text-xs text-acos-fg1">{link.label}</span>
              </Link>
            ))}
          </div>
        </div>
        
        {/* Active Agents Panel */}
        <div className="rounded-lg border border-acos-line bg-acos-bg1 p-4">
          <h2 className="mb-3 text-sm font-semibold text-acos-fg1">AJANLAR</h2>
          <div className="space-y-2">
            {agents.data?.slice(0, 10).map((agent) => (
              <div key={agent.id} className="flex items-center justify-between text-xs">
                <span className="text-acos-fg0">{agent.name}</span>
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] ${
                    agent.status === "active"
                      ? "bg-green-500/20 text-green-400"
                      : "bg-acos-bg3 text-acos-fg2"
                  }`}
                >
                  {agent.status}
                </span>
              </div>
            )) ?? <p className="text-xs text-acos-fg2">Yükleniyor...</p>}
          </div>
        </div>
        
        {/* Tasks Panel */}
        <div className="col-span-1 rounded-lg border border-acos-line bg-acos-bg1 p-4 lg:col-span-2">
          <h2 className="mb-3 text-sm font-semibold text-acos-fg1">GÖREVLER</h2>
          <div className="grid grid-cols-4 gap-2 text-xs">
            {["IN_PROGRESS", "REVIEW", "WAITING", "BLOCKED"].map((status) => {
              const count = tasks.data?.filter((t) => t.status === status).length ?? 0;
              return (
                <div key={status} className="rounded border border-acos-line bg-acos-bg2 p-2">
                  <div className="text-[10px] text-acos-fg2">{status}</div>
                  <div className="text-lg font-bold text-acos-fg0">{count}</div>
                </div>
              );
            })}
          </div>
          <div className="mt-3 max-h-48 space-y-1 overflow-auto">
            {tasks.data
              ?.filter((t) => !["DONE", "CANCELLED", "FAILED"].includes(t.status))
              .slice(0, 8)
              .map((task) => (
                <div key={task.id} className="rounded bg-acos-bg2 p-2 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-acos-fg0">{task.title}</span>
                    <span className="text-[10px] text-acos-fg2">{task.status}</span>
                  </div>
                </div>
              )) ?? <p className="text-xs text-acos-fg2">Yükleniyor...</p>}
          </div>
        </div>
        
        {/* Memory Panel */}
        <div className="rounded-lg border border-acos-line bg-acos-bg1 p-4">
          <h2 className="mb-3 text-sm font-semibold text-acos-fg1">HAFIZA</h2>
          <div className="space-y-2 text-xs">
            <div className="flex justify-between">
              <span className="text-acos-fg2">Toplam</span>
              <span className="font-bold text-acos-fg0">{memories.data?.length ?? 0}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-acos-fg2">Aktif</span>
              <span className="font-bold text-acos-fg0">
                {memories.data?.filter((m) => m.status === "active").length ?? 0}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-acos-fg2">Proje</span>
              <span className="font-bold text-acos-fg0">
                {memories.data?.filter((m) => m.scope === "project").length ?? 0}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-acos-fg2">Şirket</span>
              <span className="font-bold text-acos-fg0">
                {memories.data?.filter((m) => m.scope === "company").length ?? 0}
              </span>
            </div>
          </div>
          <div className="mt-3 max-h-32 space-y-1 overflow-auto">
            {memories.data?.slice(0, 5).map((mem) => (
              <div key={mem.id} className="text-[10px] text-acos-fg1">
                {mem.title}
              </div>
            )) ?? <p className="text-xs text-acos-fg2">Yükleniyor...</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
