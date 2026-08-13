// Costs view — /c/$companyId/costs (T49; 26 §9): spend from the REAL
// cost_entries ledger — period selector, dimension grouping, kind split,
// burn-rate projections per budget, ledger drill-down. No simulated numbers.
import { useState } from "react";
import { useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Button, Card, StatusPill, cn } from "@acos/ui";
import { api } from "../../lib/api.js";

const PERIODS: Array<{ label: string; days: number }> = [
  { label: "24h", days: 1 },
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
];
const GROUPS = ["kind", "agent", "project", "task"] as const;

const cents = (n: number) => `$${(n / 100).toFixed(2)}`;

export function CostsView() {
  const { companyId } = useParams({ from: "/c/$companyId" });
  const [days, setDays] = useState(7);
  const [groupBy, setGroupBy] = useState<(typeof GROUPS)[number]>("kind");

  const summary = useQuery({
    queryKey: [companyId, "costs", days, groupBy],
    queryFn: () =>
      api.costs.summary(companyId, {
        groupBy,
        from: new Date(Date.now() - days * 86_400_000).toISOString(),
        to: new Date().toISOString(),
      }),
    refetchInterval: 15_000,
  });
  const forecast = useQuery({
    queryKey: [companyId, "costs", "forecast"],
    queryFn: () => api.costs.forecast(companyId),
    refetchInterval: 60_000,
  });
  const entries = useQuery({
    queryKey: [companyId, "costs", "entries"],
    queryFn: () => api.costs.entries(companyId, { limit: 25 }),
    refetchInterval: 30_000,
  });

  const max = Math.max(1, ...(summary.data?.groups ?? []).map((g) => g.amountCents));

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold">Costs</h2>
        <div className="flex gap-1">
          {PERIODS.map((period) => (
            <Button
              key={period.label}
              variant={days === period.days ? "primary" : "ghost"}
              onClick={() => setDays(period.days)}
            >
              {period.label}
            </Button>
          ))}
        </div>
        <div className="ml-auto flex gap-1">
          {GROUPS.map((group) => (
            <Button
              key={group}
              variant={groupBy === group ? "secondary" : "ghost"}
              data-testid={`costs-group-${group}`}
              onClick={() => setGroupBy(group)}
            >
              by {group}
            </Button>
          ))}
        </div>
      </div>

      <Card className="p-4">
        <div data-testid="costs-total">
          <p className="text-xs uppercase text-ink-400">Total spend ({days === 1 ? "24h" : `${days}d`})</p>
          <p className="text-2xl font-semibold">{cents(summary.data?.totalCents ?? 0)}</p>
        </div>
        <div className="mt-3 flex flex-col gap-1">
          {(summary.data?.groups ?? []).map((group) => (
            <div key={group.key} className="flex items-center gap-2" data-testid="costs-bar">
              <span className="w-48 truncate text-xs">{group.name ?? group.key}</span>
              <div className="h-3 flex-1 rounded bg-acos-bg3">
                <div
                  className="h-3 rounded bg-blue-500"
                  style={{ width: `${Math.max(2, (group.amountCents / max) * 100)}%` }}
                />
              </div>
              <span className="w-20 text-right text-xs font-mono">{cents(group.amountCents)}</span>
            </div>
          ))}
          {summary.data && summary.data.groups.length === 0 && (
            <p className="text-sm text-ink-400" data-testid="costs-empty">
              No spend in this window yet.
            </p>
          )}
        </div>
      </Card>

      <Card className="p-4">
        <h3 className="mb-2 text-sm font-semibold">Burn-rate projections (26 §8)</h3>
        <div className="flex flex-col gap-2" data-testid="costs-forecast">
          {(forecast.data?.items ?? []).map((row) => (
            <div key={row.budgetId} className="flex items-center gap-3 text-sm">
              <span className="w-40">
                {row.scopeKind} · {row.period} ({row.kind})
              </span>
              <span className="font-mono">
                {cents(row.spentCents)} spent → {cents(row.projectedCents)} projected of{" "}
                {cents(row.limitCents)}
              </span>
              <StatusPill tone={row.breach ? "warn" : "ok"}>
                {row.breach ? "forecast breach" : "on track"}
              </StatusPill>
            </div>
          ))}
          {forecast.data && forecast.data.items.length === 0 && (
            <p className="text-sm text-ink-400">No active budgets.</p>
          )}
        </div>
      </Card>

      <Card className="overflow-x-auto p-0">
        <table className="w-full text-sm" data-testid="costs-ledger">
          <thead>
            <tr className="border-b bg-acos-bg2 text-left">
              <th className="p-2 font-medium">When</th>
              <th className="p-2 font-medium">Kind</th>
              <th className="p-2 font-medium">Ref</th>
              <th className="p-2 font-medium">Amount</th>
            </tr>
          </thead>
          <tbody>
            {(entries.data?.items ?? []).map((entry) => (
              <tr key={entry.id} className="border-b last:border-b-0">
                <td className={cn("p-2 font-mono text-xs")}>
                  {new Date(entry.occurredAt).toLocaleTimeString()}
                </td>
                <td className="p-2">{entry.kind}</td>
                <td className="p-2 font-mono text-xs">{entry.ref.slice(0, 40)}</td>
                <td className="p-2 font-mono">{cents(entry.amountCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
