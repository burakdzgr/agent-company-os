// Memory Observatory — /c/$companyId/memory (T48; 12 §8, demo step 21): the
// list+search view over REAL memory rows, the relation graph, the provenance
// inspector (evidence → source events, versions, lineage), the contradiction
// review queue and the Founder edit/archive path. No simulated data anywhere.
import { useState } from "react";
import { useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, Field, Input, StatusPill, cn } from "@acos/ui";
import type { MemoryDto } from "@acos/contracts";
import { api } from "../../lib/api.js";
import { MemoryGraph } from "./MemoryGraph.js";

const STATUS_TONE: Record<string, "ok" | "warn" | "accent" | "neutral"> = {
  active: "ok",
  candidate: "accent",
  superseded: "neutral",
  archived: "neutral",
  rejected: "warn",
};

const TYPES = [
  "semantic",
  "episodic",
  "procedural",
  "decision",
  "failure",
  "experiment",
  "relationship",
  "artifact",
];

function Inspector({
  companyId,
  memoryId,
  isFounder,
  onClose,
}: {
  companyId: string;
  memoryId: string;
  isFounder: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const detail = useQuery({
    queryKey: [companyId, "memories", memoryId],
    queryFn: () => api.memories.detail(companyId, memoryId),
  });
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [importance, setImportance] = useState("");
  const [error, setError] = useState<string | null>(null);

  const patch = useMutation({
    mutationFn: (body: Parameters<typeof api.memories.founderPatch>[2]) =>
      api.memories.founderPatch(companyId, memoryId, body),
    onSuccess: () => {
      setEditing(false);
      void queryClient.invalidateQueries({ queryKey: [companyId, "memories"] });
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  });

  if (!detail.data) {
    return (
      <Card className="p-4 text-sm text-ink-400">
        <div data-testid="memory-inspector">Loading…</div>
      </Card>
    );
  }
  const { memory, evidence, relations, versions } = detail.data;
  return (
    <Card className="p-4">
      <div className="flex flex-col gap-3" data-testid="memory-inspector">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold" data-testid="inspector-title">
            {memory.title}
          </h3>
          <p className="text-xs text-ink-400">
            {memory.scope} · {memory.type} · importance {memory.importance.toFixed(2)} ·
            confidence {memory.confidence.toFixed(2)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StatusPill tone={STATUS_TONE[memory.status] ?? "neutral"}>{memory.status}</StatusPill>
          <Button variant="ghost" onClick={onClose}>
            ✕
          </Button>
        </div>
      </div>
      <p className="whitespace-pre-wrap text-sm">{memory.content}</p>

      <section data-testid="inspector-provenance">
        <h4 className="text-xs font-semibold uppercase text-ink-400">Why this exists</h4>
        <p className="text-xs">
          Source event: {memory.sourceEventId ?? "(none)"} · Creator:{" "}
          {memory.createdByAgentName ?? "system"}
        </p>
        <h4 className="mt-2 text-xs font-semibold uppercase text-ink-400">
          Evidence ({evidence.length})
        </h4>
        <ul className="text-xs">
          {evidence.map((item) => (
            <li key={item.id} data-testid="evidence-row">
              <span className="font-mono">{item.kind}</span> · w {item.weight.toFixed(2)} ·{" "}
              <span className="font-mono">{item.ref.slice(0, 24)}</span>
            </li>
          ))}
          {evidence.length === 0 && <li className="text-ink-400">(none)</li>}
        </ul>
      </section>

      <section>
        <h4 className="text-xs font-semibold uppercase text-ink-400">
          Related ({relations.length})
        </h4>
        <ul className="text-xs">
          {relations.map((relation) => (
            <li key={relation.relationId}>
              <span
                className={cn(
                  "font-semibold",
                  relation.kind === "contradicts" && "text-red-600",
                  relation.kind === "derived_from" && "text-purple-700",
                )}
              >
                {relation.direction === "out" ? relation.kind : `← ${relation.kind}`}
              </span>{" "}
              {relation.otherTitle}
            </li>
          ))}
          {relations.length === 0 && <li className="text-ink-400">(none)</li>}
        </ul>
      </section>

      <section data-testid="inspector-history">
        <h4 className="text-xs font-semibold uppercase text-ink-400">
          History ({versions.length})
        </h4>
        <ul className="text-xs">
          {versions.map((version) => (
            <li key={version.version}>
              v{version.version} · {version.status} · {version.changedBy}
              {version.changeReason ? ` · ${version.changeReason}` : ""}
            </li>
          ))}
        </ul>
      </section>

      {isFounder && !editing && (
        <Button
          variant="secondary"
          data-testid="memory-edit-open"
          onClick={() => {
            setTitle(memory.title);
            setImportance(String(memory.importance));
            setEditing(true);
          }}
        >
          Founder edit
        </Button>
      )}
      {isFounder && editing && (
        <div className="flex flex-col gap-2 border-t pt-2">
          <Field label="Title">
            <Input name="memoryTitle" value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label="Importance (0–1)">
            <Input
              name="memoryImportance"
              value={importance}
              onChange={(e) => setImportance(e.target.value)}
            />
          </Field>
          {error && <p className="text-xs text-red-600">{error}</p>}
          <div className="flex gap-2">
            <Button
              data-testid="memory-edit-save"
              onClick={() =>
                patch.mutate({
                  title,
                  importance: Number.isFinite(Number(importance))
                    ? Math.min(1, Math.max(0, Number(importance)))
                    : undefined,
                })
              }
            >
              Save
            </Button>
            <Button
              variant="secondary"
              data-testid="memory-archive"
              onClick={() => patch.mutate({ archive: true, note: "founder archive" })}
            >
              Archive
            </Button>
            <Button variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      </div>
    </Card>
  );
}

function ContradictionQueue({ companyId, isFounder }: { companyId: string; isFounder: boolean }) {
  const queryClient = useQueryClient();
  const queue = useQuery({
    queryKey: [companyId, "memories", "contradictions"],
    queryFn: () => api.memories.contradictions(companyId),
    refetchInterval: 15_000,
  });
  const resolve = useMutation({
    mutationFn: (input: { relationId: string; winnerMemoryId: string }) =>
      api.memories.resolveContradiction(companyId, input.relationId, {
        winnerMemoryId: input.winnerMemoryId,
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: [companyId, "memories"] }),
  });

  const items = queue.data?.items ?? [];
  if (items.length === 0) {
    return (
      <Card className="p-6 text-sm text-ink-400">
        <div data-testid="contradictions-empty" className="contents" />
        No unresolved contradictions.
      </Card>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {items.map((pair) => (
        <Card key={pair.relationId} className="p-4">
          <div data-testid="contradiction-pair">
          <p className="mb-2 text-xs font-semibold uppercase text-red-600">Contradiction</p>
          <div className="grid grid-cols-2 gap-3">
            {[pair.a, pair.b].map((side) => (
              <div key={side.id} className="rounded border p-2">
                <p className="text-sm font-medium">{side.title}</p>
                <p className="text-xs text-ink-600">{side.content}</p>
                <p className="mt-1 text-xs text-ink-400">
                  conf {side.confidence.toFixed(2)} · {side.scope}
                </p>
                {isFounder && (
                  <Button
                    className="mt-2"
                    variant="secondary"
                    data-testid={`keep-${side.id}`}
                    onClick={() =>
                      resolve.mutate({ relationId: pair.relationId, winnerMemoryId: side.id })
                    }
                  >
                    Keep this
                  </Button>
                )}
              </div>
            ))}
          </div>
          </div>
        </Card>
      ))}
    </div>
  );
}

export function MemoryView() {
  const { companyId } = useParams({ from: "/c/$companyId" });
  const [tab, setTab] = useState<"list" | "graph" | "queues">("list");
  const [typeFilter, setTypeFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const companiesQ = useQuery({ queryKey: ["companies"], queryFn: () => api.companies.list() });
  const isFounder = companiesQ.data?.find((c) => c.id === companyId)?.role === "founder";

  const list = useQuery({
    queryKey: [companyId, "memories", "list", typeFilter, statusFilter, query],
    queryFn: () =>
      api.memories.list(companyId, {
        ...(typeFilter && { type: typeFilter }),
        status: statusFilter,
        ...(query && { q: query }),
      }),
    refetchInterval: 10_000,
  });

  const badges = list.data ?? { contradictions: 0, lowConfidence: 0 };

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold">Memory Observatory</h2>
        <div className="flex gap-1">
          {(["list", "graph", "queues"] as const).map((key) => (
            <Button
              key={key}
              variant={tab === key ? "primary" : "ghost"}
              data-testid={`memory-tab-${key}`}
              onClick={() => setTab(key)}
            >
              {key.toUpperCase()}
              {key === "queues" && badges.contradictions > 0 && (
                <span
                  data-testid="contradiction-badge"
                  className="ml-1 rounded-full bg-red-600 px-1.5 text-xs text-white"
                >
                  {badges.contradictions}
                </span>
              )}
            </Button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <select
            className="rounded border px-2 py-1 text-sm"
            data-testid="memory-type-filter"
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
          >
            <option value="">all types</option>
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <select
            className="rounded border px-2 py-1 text-sm"
            data-testid="memory-status-filter"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            {["all", "active", "candidate", "superseded", "archived"].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <Input
            name="memorySearch"
            placeholder="search…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      <div className={cn("grid gap-4", selectedId ? "grid-cols-[1fr_420px]" : "grid-cols-1")}>
        <div>
          {tab === "list" && (
            <Card className="overflow-x-auto p-0">
              <table className="w-full text-sm" data-testid="memory-table">
                <thead>
                  <tr className="border-b bg-acos-bg2 text-left">
                    <th className="p-2 font-medium">Title</th>
                    <th className="p-2 font-medium">Type</th>
                    <th className="p-2 font-medium">Scope</th>
                    <th className="p-2 font-medium">Imp</th>
                    <th className="p-2 font-medium">Conf</th>
                    <th className="p-2 font-medium">Retrievals</th>
                    <th className="p-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {(list.data?.items ?? []).map((memory: MemoryDto) => (
                    <tr
                      key={memory.id}
                      data-testid="memory-row"
                      className={cn(
                        "cursor-pointer border-b last:border-b-0 hover:bg-acos-bg2",
                        selectedId === memory.id && "bg-blue-50",
                      )}
                      onClick={() => setSelectedId(memory.id)}
                    >
                      <td className="p-2">{memory.title}</td>
                      <td className="p-2">{memory.type}</td>
                      <td className="p-2">{memory.scope}</td>
                      <td className="p-2">{memory.importance.toFixed(2)}</td>
                      <td className="p-2">{memory.confidence.toFixed(2)}</td>
                      <td className="p-2">{memory.retrievalCount}</td>
                      <td className="p-2">
                        <StatusPill tone={STATUS_TONE[memory.status] ?? "neutral"}>
                          {memory.status}
                        </StatusPill>
                      </td>
                    </tr>
                  ))}
                  {list.data && list.data.items.length === 0 && (
                    <tr>
                      <td className="p-4 text-ink-400" colSpan={7} data-testid="memory-empty">
                        No memories match — the company learns as tasks complete.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </Card>
          )}
          {tab === "graph" && <MemoryGraph companyId={companyId} onSelect={setSelectedId} />}
          {tab === "queues" && <ContradictionQueue companyId={companyId} isFounder={isFounder} />}
        </div>
        {selectedId && (
          <Inspector
            companyId={companyId}
            memoryId={selectedId}
            isFounder={isFounder}
            onClose={() => setSelectedId(null)}
          />
        )}
      </div>
    </div>
  );
}
