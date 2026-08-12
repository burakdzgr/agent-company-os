// Tasks board (24 §6.3, T27): three tabs — Kanban (canonical state columns),
// Tree (kind hierarchy), DAG (Cytoscape dependency graph). Transitions offer
// the machine-legal targets; the SERVER enforces role permission and the UI
// surfaces its 409 verbatim (demo step 12: per-role permissions enforced).
import { useMemo, useState } from "react";
import { useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { TASK_NEXT_STATUSES, type Task } from "@acos/contracts";
import { AcosApiError } from "@acos/contracts/client";
import { Button, Card, Dialog, Field, Input, Select, StatusPill, Textarea, cn } from "@acos/ui";
import { api, keys } from "../../lib/api.js";
import { TaskDag } from "./TaskDag.js";

const COLUMNS: Array<{ label: string; statuses: string[] }> = [
  { label: "Draft", statuses: ["DRAFT"] },
  { label: "Backlog", statuses: ["BACKLOG"] },
  { label: "Planned", statuses: ["PLANNED"] },
  { label: "Assigned", statuses: ["ASSIGNED"] },
  { label: "In Progress", statuses: ["IN_PROGRESS", "WAITING", "BLOCKED"] },
  { label: "Review", statuses: ["REVIEW", "CHANGES_REQUESTED"] },
  { label: "QA", statuses: ["QA", "QA_FAILED"] },
  { label: "Approval", statuses: ["APPROVAL", "REJECTED"] },
  { label: "Done", statuses: ["DONE"] },
  { label: "Closed", statuses: ["FAILED", "CANCELLED"] },
];

const PRIORITY_TONE = { P0: "danger", P1: "warn", P2: "accent", P3: "neutral" } as const;

function TaskCard({ task, onSelect }: { task: Task; onSelect: (t: Task) => void }) {
  return (
    <button
      onClick={() => onSelect(task)}
      className="w-full rounded-md border border-ink-200 bg-white p-2 text-left text-xs shadow-sm hover:shadow"
      data-testid={`task-card-${task.number}`}
    >
      <div className="flex items-center gap-1.5">
        <span className="font-mono text-ink-400">{task.displayNumber}</span>
        <StatusPill tone={PRIORITY_TONE[task.priority]}>{task.priority}</StatusPill>
        <span className="ml-auto uppercase text-[10px] text-ink-300">{task.kind}</span>
      </div>
      <p className="mt-1 line-clamp-2 font-medium text-ink-800">{task.title}</p>
      <p className="mt-0.5 text-[10px] text-ink-400">{task.status}</p>
    </button>
  );
}

function TaskDetail({
  companyId,
  task,
  onClose,
}: {
  companyId: string;
  task: Task;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const agents = useQuery({ queryKey: keys.agents(companyId), queryFn: () => api.agents.list(companyId) });
  const [error, setError] = useState<string | null>(null);
  const [assignee, setAssignee] = useState("");

  const refresh = () => queryClient.invalidateQueries({ queryKey: [companyId, "tasks"] });

  const transition = useMutation({
    mutationFn: (to: string) => api.tasks.transition(companyId, task.id, { to }),
    onSuccess: () => {
      setError(null);
      void refresh();
      onClose();
    },
    onError: (err) =>
      setError(err instanceof AcosApiError ? `${err.problem.code}: ${err.problem.detail}` : String(err)),
  });
  const assign = useMutation({
    mutationFn: () => api.tasks.assign(companyId, task.id, { agentId: assignee }),
    onSuccess: () => {
      setError(null);
      void refresh();
      onClose();
    },
    onError: (err) =>
      setError(err instanceof AcosApiError ? `${err.problem.code}: ${err.problem.detail}` : String(err)),
  });

  const nextStatuses = TASK_NEXT_STATUSES[task.status] ?? [];

  return (
    <Dialog open onClose={onClose} title={`${task.displayNumber} · ${task.title}`}>
      <div className="space-y-3 text-sm">
        <p className="text-ink-600">{task.objective}</p>
        <div className="flex flex-wrap gap-2 text-xs text-ink-500">
          <StatusPill tone="accent">{task.status}</StatusPill>
          <span>kind: {task.kind}</span>
          <span>risk: {task.risk}</span>
          <span>depth: {task.delegationDepth}</span>
          {task.ownerAgentId && (
            <span>
              owner: {agents.data?.find((a) => a.id === task.ownerAgentId)?.name ?? task.ownerAgentId}
            </span>
          )}
        </div>

        {error && (
          <p className="rounded bg-danger/10 px-2 py-1 text-xs text-danger" data-testid="transition-error">
            {error}
          </p>
        )}

        <div className="flex flex-wrap gap-2" data-testid="transition-buttons">
          {nextStatuses.map((to) => (
            <Button
              key={to}
              variant="secondary"
              disabled={transition.isPending}
              onClick={() => transition.mutate(to)}
              data-testid={`transition-${to}`}
            >
              → {to}
            </Button>
          ))}
          {nextStatuses.length === 0 && <span className="text-xs text-ink-400">terminal state</span>}
        </div>

        {(task.status === "PLANNED" || task.status === "ASSIGNED") && (
          <div className="flex items-end gap-2 border-t border-ink-100 pt-3">
            <div className="flex-1">
              <Field label="Assign owner">
                <Select
                  value={assignee}
                  onChange={(e) => setAssignee(e.target.value)}
                  name="taskAssignee"
                >
                  <option value="">pick an agent…</option>
                  {agents.data
                    ?.filter((a) => a.status === "active")
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                </Select>
              </Field>
            </div>
            <Button disabled={!assignee || assign.isPending} onClick={() => assign.mutate()} data-testid="assign-button">
              Assign
            </Button>
          </div>
        )}

        <TaskReviews companyId={companyId} taskId={task.id} />
      </div>
    </Dialog>
  );
}

/** Reviews panel (T43; 24 §6 review UI slice): the PR entity rows + diff. */
function TaskReviews({ companyId, taskId }: { companyId: string; taskId: string }) {
  const [diffFor, setDiffFor] = useState<string | null>(null);
  const reviewsQuery = useQuery({
    queryKey: [companyId, "tasks", taskId, "reviews"],
    queryFn: () => api.reviews.listForTask(companyId, taskId),
  });
  const diff = useQuery({
    queryKey: [companyId, "reviews", diffFor, "diff"],
    queryFn: () => api.reviews.diff(companyId, diffFor!),
    enabled: diffFor !== null,
  });
  const items = reviewsQuery.data?.items ?? [];
  if (items.length === 0) return null;

  const TONE: Record<string, "ok" | "warn" | "accent" | "neutral"> = {
    approved: "ok",
    changes_requested: "warn",
    in_review: "accent",
    pending: "neutral",
    blocked: "warn",
  };
  return (
    <div className="border-t border-ink-100 pt-3" data-testid="task-reviews">
      <h4 className="mb-1 text-xs font-semibold uppercase text-ink-400">Reviews</h4>
      <div className="space-y-1">
        {items.map((r) => (
          <div key={r.id} className="rounded bg-ink-50 px-2 py-1.5 text-xs" data-testid="review-row">
            <div className="flex items-center gap-2">
              <StatusPill tone={TONE[r.status] ?? "neutral"}>{r.status}</StatusPill>
              <span className="font-medium">{r.kind}</span>
              <span className="text-ink-400">
                {r.authorName ?? "?"} → {r.reviewerName ?? "unassigned"}
              </span>
              {r.mergedCommit && (
                <code className="text-ink-400">merged @ {r.mergedCommit.slice(0, 8)}</code>
              )}
              <Button
                variant="ghost"
                className="ml-auto"
                onClick={() => setDiffFor(diffFor === r.id ? null : r.id)}
                data-testid="review-diff-toggle"
              >
                {diffFor === r.id ? "hide diff" : "diff"}
              </Button>
            </div>
            {r.verdictMd && <p className="mt-1 text-ink-500">{r.verdictMd}</p>}
            {diffFor === r.id && (
              <pre
                className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-ink-100 p-2 font-mono text-[11px]"
                data-testid="review-diff"
              >
                {diff.isLoading ? "loading diff…" : (diff.data?.diff ?? "(no diff)")}
              </pre>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function CreateTaskDialog({
  companyId,
  open,
  onClose,
  tasks,
}: {
  companyId: string;
  open: boolean;
  onClose: () => void;
  tasks: Task[];
}) {
  const queryClient = useQueryClient();
  const [kind, setKind] = useState("task");
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const [priority, setPriority] = useState("P2");
  const [parentId, setParentId] = useState("");
  const [error, setError] = useState<string | null>(null);

  const parentKind: Record<string, string | null> = {
    goal: null,
    initiative: "goal",
    epic: "initiative",
    task: "epic",
    subtask: "task",
  };
  const parentOptions = tasks.filter((t) => t.kind === parentKind[kind]);

  const create = useMutation({
    mutationFn: () =>
      api.tasks.create(companyId, {
        kind,
        title,
        objective,
        priority,
        ...(parentId && { parentId }),
      }),
    onSuccess: () => {
      setTitle("");
      setObjective("");
      setError(null);
      void queryClient.invalidateQueries({ queryKey: [companyId, "tasks"] });
      onClose();
    },
    onError: (err) =>
      setError(err instanceof AcosApiError ? `${err.problem.code}: ${err.problem.detail}` : String(err)),
  });

  if (!open) return null;
  return (
    <Dialog open onClose={onClose} title="New task">
      <div className="space-y-3">
        <div className="flex gap-2">
          <div className="w-36">
            <Field label="Kind">
              <Select value={kind} onChange={(e) => setKind(e.target.value)} name="taskKind">
                {["goal", "initiative", "epic", "task", "subtask"].map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="w-28">
            <Field label="Priority">
              <Select value={priority} onChange={(e) => setPriority(e.target.value)} name="taskPriority">
                {["P0", "P1", "P2", "P3"].map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </Select>
            </Field>
          </div>
          {parentKind[kind] !== null && (
            <div className="flex-1">
              <Field label={`Parent (${parentKind[kind]})`}>
                <Select value={parentId} onChange={(e) => setParentId(e.target.value)} name="taskParent">
                  <option value="">{kind === "task" ? "none (ad-hoc)" : "required…"}</option>
                  {parentOptions.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.displayNumber} {p.title}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          )}
        </div>
        <Field label="Title">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} name="taskTitle" />
        </Field>
        <Field label="Objective">
          <Textarea
            value={objective}
            onChange={(e) => setObjective(e.target.value)}
            name="taskObjective"
            rows={3}
          />
        </Field>
        {error && <p className="text-xs text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!title || !objective || create.isPending}
            onClick={() => create.mutate()}
            data-testid="create-task-submit"
          >
            Create
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function TreeTab({ tasks, onSelect }: { tasks: Task[]; onSelect: (t: Task) => void }) {
  const byParent = useMemo(() => {
    const map = new Map<string | null, Task[]>();
    for (const t of tasks) {
      const key = t.parentId && tasks.some((p) => p.id === t.parentId) ? t.parentId : null;
      map.set(key, [...(map.get(key) ?? []), t]);
    }
    return map;
  }, [tasks]);

  function renderLevel(parentId: string | null, depth: number) {
    return (byParent.get(parentId) ?? []).map((task) => (
      <div key={task.id} style={{ paddingLeft: depth * 20 }}>
        <button
          onClick={() => onSelect(task)}
          className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-ink-50"
        >
          <span className="font-mono text-xs text-ink-400">{task.displayNumber}</span>
          <span className="uppercase text-[10px] text-ink-300">{task.kind}</span>
          <span className="text-ink-800">{task.title}</span>
          <StatusPill tone={task.status === "DONE" ? "ok" : "neutral"}>{task.status}</StatusPill>
        </button>
        {renderLevel(task.id, depth + 1)}
      </div>
    ));
  }

  return <div data-testid="task-tree">{renderLevel(null, 0)}</div>;
}

export function TasksView() {
  const { companyId } = useParams({ from: "/c/$companyId" });
  const [tab, setTab] = useState<"kanban" | "tree" | "dag">("kanban");
  const [createOpen, setCreateOpen] = useState(false);
  const [selected, setSelected] = useState<Task | null>(null);

  const tasks = useQuery({
    queryKey: [companyId, "tasks", "list"],
    queryFn: () => api.tasks.list(companyId),
  });
  const rows = tasks.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold text-ink-900">Tasks</h1>
        <div className="flex rounded-md border border-ink-200 p-0.5">
          {(["kanban", "tree", "dag"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn(
                "rounded px-3 py-1 text-xs font-medium capitalize",
                tab === t ? "bg-accent-500/10 text-accent-600" : "text-ink-500 hover:bg-ink-50",
              )}
              data-testid={`tab-${t}`}
            >
              {t}
            </button>
          ))}
        </div>
        <Button className="ml-auto" onClick={() => setCreateOpen(true)} data-testid="new-task-button">
          New task
        </Button>
      </div>

      {rows.length === 0 && !tasks.isLoading ? (
        <p className="py-12 text-center text-sm text-ink-400">
          No tasks — give the CEO an objective.
        </p>
      ) : tab === "kanban" ? (
        <div className="flex gap-3 overflow-x-auto pb-2" data-testid="kanban-board">
          {COLUMNS.map((column) => {
            const cards = rows.filter((t) => column.statuses.includes(t.status));
            return (
              <div key={column.label} className="w-56 shrink-0" data-testid={`column-${column.label}`}>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">
                  {column.label} <span className="text-ink-300">{cards.length}</span>
                </p>
                <div className="space-y-2">
                  {cards.map((task) => (
                    <TaskCard key={task.id} task={task} onSelect={setSelected} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      ) : tab === "tree" ? (
        <Card className="p-3">
          <TreeTab tasks={rows} onSelect={setSelected} />
        </Card>
      ) : (
        <Card className="p-3">
          <TaskDag companyId={companyId} tasks={rows} onSelect={setSelected} />
        </Card>
      )}

      <CreateTaskDialog
        companyId={companyId}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        tasks={rows}
      />
      {selected && (
        <TaskDetail companyId={companyId} task={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}
