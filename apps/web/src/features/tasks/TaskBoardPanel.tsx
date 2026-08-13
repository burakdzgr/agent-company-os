// Görevler panel (36 §6 — U08): real drag-drop kanban over the 16-state
// machine for the Command Center. Core columns always show; edge states
// appear only when occupied. A Founder drag calls the EXISTING transition
// API — the server re-authorizes and an illegal move bounces with the real
// 409 surfaced verbatim (N5); there is no optimistic move, so the card
// simply stays put. Live-updates ride the task.* WS invalidation. Agents
// still drive state via the machine; the board only reflects + allows
// authorized Founder overrides. Tree/DAG stay in the pop-out route view.
import { useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { TASK_NEXT_STATUSES, type Task } from "@acos/contracts";
import { AcosApiError } from "@acos/contracts/client";
import { cn } from "@acos/ui";
import { api, keys } from "../../lib/api.js";
import { useFocus } from "../../stores/focus.js";

type TaskStatus = Task["status"];

const CORE: TaskStatus[] = [
  "BACKLOG",
  "ASSIGNED",
  "IN_PROGRESS",
  "REVIEW",
  "CHANGES_REQUESTED",
  "QA",
  "APPROVAL",
  "DONE",
];
const COLUMN_ORDER: TaskStatus[] = [
  "DRAFT",
  "BACKLOG",
  "PLANNED",
  "ASSIGNED",
  "IN_PROGRESS",
  "WAITING",
  "BLOCKED",
  "REVIEW",
  "CHANGES_REQUESTED",
  "QA",
  "QA_FAILED",
  "APPROVAL",
  "REJECTED",
  "DONE",
  "FAILED",
  "CANCELLED",
];

const PRIORITY_COLOR: Record<Task["priority"], string> = {
  P0: "#ff4d4d",
  P1: "#ffcb47",
  P2: "#4c9aff",
  P3: "#5c6773",
};

const AVATAR_HUES = [212, 262, 152, 22, 332, 190, 82, 292];
function agentHue(name: string): number {
  return AVATAR_HUES[[...name].reduce((h, c) => h + c.charCodeAt(0), 0) % AVATAR_HUES.length]!;
}

function BoardCard({
  task,
  ownerName,
  dragging,
  onDragStart,
  onDragEnd,
}: {
  task: Task;
  ownerName: string | null;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  const selectedAgentId = useFocus((s) => s.selectedAgentId);
  const focused = task.ownerAgentId !== null && task.ownerAgentId === selectedAgentId;
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/task-id", task.id);
        e.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      data-testid={`board-card-${task.number}`}
      className={cn(
        "mb-1.5 cursor-grab rounded-md border border-acos-line bg-acos-bg2 px-2 py-1.5 text-[10.5px]",
        dragging && "opacity-40",
        focused && "ring-1 ring-dept-engineering",
      )}
      style={{ borderLeft: `3px solid ${PRIORITY_COLOR[task.priority]}` }}
    >
      <div className="flex items-center gap-1.5">
        <span className="font-mono text-[9px] tabular-nums text-acos-fg2">
          {task.displayNumber}
        </span>
        <span
          className="rounded-full px-1 text-[8px] font-semibold"
          style={{
            background: `${PRIORITY_COLOR[task.priority]}22`,
            color: PRIORITY_COLOR[task.priority],
          }}
        >
          {task.priority}
        </span>
        <span className="ml-auto text-[8px] uppercase text-acos-fg2">{task.kind}</span>
      </div>
      <p className="mt-0.5 line-clamp-2 font-medium text-acos-fg0">{task.title}</p>
      <div className="mt-1 flex items-center gap-1.5 text-[9px] text-acos-fg2">
        {ownerName ? (
          <>
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ background: `hsl(${agentHue(ownerName)} 55% 48%)` }}
            />
            {ownerName}
          </>
        ) : (
          <span>—</span>
        )}
      </div>
    </div>
  );
}

export function TaskBoardPanel() {
  const { companyId } = useParams({ from: "/c/$companyId" });
  const queryClient = useQueryClient();
  const [draggingTask, setDraggingTask] = useState<Task | null>(null);
  const [overColumn, setOverColumn] = useState<TaskStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const tasks = useQuery({
    queryKey: [companyId, "tasks", "board"],
    queryFn: () => api.tasks.list(companyId, {}),
  });
  const agents = useQuery({
    queryKey: keys.agents(companyId),
    queryFn: () => api.agents.list(companyId),
  });
  const agentName = new Map((agents.data ?? []).map((a) => [a.id, a.name]));

  const transition = useMutation({
    mutationFn: ({ task, to }: { task: Task; to: TaskStatus }) =>
      api.tasks.transition(companyId, task.id, { to, reason: "Founder board override" }),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: [companyId, "tasks"] });
    },
    onError: (err, vars) => {
      // N5: the card never moved (no optimism) — surface the REAL rejection
      const detail =
        err instanceof AcosApiError
          ? `${err.problem.code}: ${err.problem.detail ?? err.problem.title}`
          : String(err);
      setError(`${vars.task.displayNumber} → ${vars.to} reddedildi — ${detail}`);
      window.setTimeout(() => setError(null), 6000);
    },
  });

  const items = tasks.data ?? [];
  const byStatus = new Map<TaskStatus, Task[]>();
  for (const task of items) {
    const bucket = byStatus.get(task.status) ?? [];
    bucket.push(task);
    byStatus.set(task.status, bucket);
  }
  const columns = COLUMN_ORDER.filter(
    (status) => CORE.includes(status) || (byStatus.get(status)?.length ?? 0) > 0,
  );
  const legalTargets = draggingTask ? TASK_NEXT_STATUSES[draggingTask.status] : [];

  return (
    <div className="flex h-full min-h-0 flex-col bg-acos-bg1">
      <div className="flex h-6 shrink-0 items-center gap-2 border-b border-acos-line px-2 text-[9.5px] text-acos-fg2">
        <span>{items.length} görev</span>
        <span className="text-acos-fg2/60">
          sürükle = yetkili geçiş; illegal olan gerçek 409 ile geri döner
        </span>
        <Link
          to="/c/$companyId/tasks"
          params={{ companyId }}
          className="ml-auto text-dept-engineering hover:underline"
          data-testid="board-popout"
        >
          ⧉ Tree/DAG
        </Link>
      </div>
      {error && (
        <div
          className="shrink-0 border-b border-acos-line bg-[#2a1518] px-2 py-1 text-[10px]"
          style={{ color: "#ff6b8a" }}
          data-testid="board-transition-error"
        >
          {error}
        </div>
      )}
      <div className="flex min-h-0 flex-1 gap-1.5 overflow-x-auto p-1.5" data-testid="task-board">
        {columns.map((status) => {
          const legal = legalTargets.includes(status);
          const over = overColumn === status;
          return (
            <div
              key={status}
              data-testid={`board-column-${status}`}
              className={cn(
                "flex min-w-[130px] flex-1 flex-col rounded-md border bg-acos-bg0",
                over && legal
                  ? "border-dept-engineering"
                  : over
                    ? "border-[#ff4d4d]"
                    : "border-acos-line",
                draggingTask && legal && !over && "border-dept-engineering/40",
              )}
              onDragOver={(e) => {
                e.preventDefault();
                setOverColumn(status);
              }}
              onDragLeave={() => setOverColumn((c) => (c === status ? null : c))}
              onDrop={(e) => {
                e.preventDefault();
                setOverColumn(null);
                const id = e.dataTransfer.getData("text/task-id");
                const task = items.find((t) => t.id === id);
                if (task && task.status !== status) transition.mutate({ task, to: status });
              }}
            >
              <div className="flex items-center justify-between border-b border-acos-line px-2 py-1 text-[8.5px] uppercase tracking-wide text-acos-fg2">
                <span>{status}</span>
                <span className="font-mono tabular-nums">{byStatus.get(status)?.length ?? 0}</span>
              </div>
              <div className="min-h-[30px] flex-1 overflow-y-auto p-1">
                {(byStatus.get(status) ?? []).map((task) => (
                  <BoardCard
                    key={task.id}
                    task={task}
                    ownerName={task.ownerAgentId ? (agentName.get(task.ownerAgentId) ?? null) : null}
                    dragging={draggingTask?.id === task.id}
                    onDragStart={() => setDraggingTask(task)}
                    onDragEnd={() => {
                      setDraggingTask(null);
                      setOverColumn(null);
                    }}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
