// Command-center shell (24 §1): TopBar (CompanySwitcher, user), LeftNav
// (14 views — unimplemented ones disabled), Outlet, StatusBar placeholder.
import { Link, Outlet, useNavigate, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Button, Select, cn } from "@acos/ui";
import { api, keys } from "../lib/api.js";
import { useUiPrefs } from "../stores/uiPrefs.js";
import { useEventTicker } from "../stores/eventTicker.js";
import { RealtimeDispatcher, useRealtimeStatus } from "../realtime/RealtimeDispatcher.js";

const NAV_ITEMS: Array<{ label: string; path?: string }> = [
  { label: "OFFICE", path: "/c/$companyId/office" },
  { label: "TASKS", path: "/c/$companyId/tasks" },
  { label: "AGENTS", path: "/c/$companyId/agents" },
  { label: "PROJECTS", path: "/c/$companyId/projects" },
  { label: "MEMORY", path: "/c/$companyId/memory" },
  { label: "ORGANIZATION", path: "/c/$companyId/organization" },
  { label: "SKILLS", path: "/c/$companyId/skills" },
  { label: "COMMUNICATION", path: "/c/$companyId/communication" },
  { label: "TERMINALS", path: "/c/$companyId/terminals" },
  { label: "APPROVALS", path: "/c/$companyId/approvals" },
  { label: "EVENTS", path: "/c/$companyId/events" },
  { label: "REPORTS", path: "/c/$companyId/reports" },
  { label: "COSTS", path: "/c/$companyId/costs" },
  { label: "SETTINGS" },
];

export function AppShell() {
  const { companyId } = useParams({ from: "/c/$companyId" });
  const navigate = useNavigate();
  const { navCollapsed, toggleNav } = useUiPrefs();
  const companies = useQuery({ queryKey: keys.companies, queryFn: api.companies.list });
  const me = useQuery({ queryKey: keys.me, queryFn: api.auth.me });
  const wsStatus = useRealtimeStatus();
  const lastEvent = useEventTicker((s) => s.events[0]);

  async function logout() {
    await api.auth.logout();
    await navigate({ to: "/login" });
  }

  return (
    <div className="flex min-h-screen flex-col bg-ink-50">
      <header className="flex items-center gap-3 border-b border-ink-200 bg-white px-4 py-2">
        <button
          onClick={toggleNav}
          aria-label="Toggle navigation"
          className="rounded px-2 py-1 text-ink-400 hover:bg-ink-100"
        >
          ☰
        </button>
        <span className="font-bold text-ink-900">ACOS</span>
        <Select
          aria-label="Company"
          className="!w-56"
          value={companyId}
          onChange={(e) =>
            navigate({ to: "/c/$companyId", params: { companyId: e.target.value } })
          }
        >
          {companies.data?.map((company) => (
            <option key={company.id} value={company.id}>
              {company.name}
            </option>
          ))}
        </Select>
        <div className="ml-auto flex items-center gap-3 text-sm text-ink-600">
          <span data-testid="me-name">{me.data?.displayName}</span>
          <Button variant="ghost" onClick={logout}>
            Sign out
          </Button>
        </div>
      </header>

      <div className="flex flex-1">
        <nav
          className={cn(
            "shrink-0 border-r border-ink-200 bg-white py-3",
            navCollapsed ? "w-12" : "w-48",
          )}
        >
          <ul className="space-y-0.5">
            {NAV_ITEMS.map((item) => {
              const enabled = item.path !== undefined;
              return (
                <li key={item.label}>
                  {enabled ? (
                    <Link
                      to={item.path as "/c/$companyId/agents"}
                      params={{ companyId }}
                      className="block px-4 py-1.5 text-xs font-medium tracking-wide text-ink-600 hover:bg-ink-50 [&.active]:bg-accent-500/10 [&.active]:text-accent-600"
                    >
                      {navCollapsed ? item.label[0] : item.label}
                    </Link>
                  ) : (
                    <span
                      className="block cursor-not-allowed px-4 py-1.5 text-xs font-medium tracking-wide text-ink-200"
                      title="Lands with a later milestone"
                    >
                      {navCollapsed ? item.label[0] : item.label}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </nav>

        <main className="min-w-0 flex-1 p-6">
          <Outlet />
        </main>
      </div>

      <RealtimeDispatcher companyId={companyId} />
      <footer
        className="flex items-center gap-3 border-t border-ink-200 bg-white px-4 py-1 text-xs text-ink-400"
        data-testid="status-bar"
      >
        <span
          className={cn(
            "font-medium",
            wsStatus === "open" ? "text-ok" : wsStatus === "closed_auth" ? "text-danger" : "",
          )}
        >
          ws: {wsStatus}
        </span>
        {lastEvent && (
          <span className="truncate" data-testid="ticker-last">
            #{lastEvent.seq} {lastEvent.type}
          </span>
        )}
      </footer>
    </div>
  );
}
