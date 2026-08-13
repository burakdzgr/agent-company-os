// Terminal grid (36 §4 — U05): the Command Center's center "Terminal" tab —
// a tiling grid of live agent terminals, one cell per open terminal_session.
// S/M/L sets the column count (S=2 big, M=4, L=6 dense). Closing a cell only
// detaches the view (the session keeps running server-side; reopen from the
// roster toggle). Output is the REAL sandbox PTY stream — ring replay first,
// then live frames over `terminal:<sessionId>` (T41); read-only here, the
// focus-terminal Founder directive lands in U06.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useParams } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { cn, presenceColor } from "@acos/ui";
import type { TerminalSessionDto } from "@acos/contracts";
import { api, queryClient } from "../../lib/api.js";
import { useTeamMemberSet } from "../../lib/teamFilter.js";
import { clearTopicCursor, getRealtimeClient } from "../../realtime/client.js";
import { usePresence } from "../../stores/presence.js";
import { useFocus } from "../../stores/focus.js";
import { DENSITY_COLS, useTerminalGrid, type TerminalDensity } from "../../stores/terminalGrid.js";

function base64ToUtf8(data: string): string {
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

interface TerminalFrame {
  seq: number;
  ts: number;
  stream: string;
  data: string;
}

const DENSITY_FONT: Record<TerminalDensity, number> = { S: 12, M: 10, L: 9 };
const DENSITY_MIN_H: Record<TerminalDensity, string> = {
  S: "minmax(260px,1fr)",
  M: "minmax(160px,1fr)",
  L: "minmax(120px,1fr)",
};

/** Compact read-only xterm cell body — refits on container resize. */
function GridXterm({ session, fontSize }: { session: TerminalSessionDto; fontSize: number }) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      convertEol: true,
      disableStdin: true, // read-only observability (24 §6.9)
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      fontSize,
      theme: { background: "#06080b" },
      cols: session.cols,
      rows: session.rows,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    // dockview panes resize without a window resize event
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(host);

    const client = getRealtimeClient();
    // fresh cell = no scrollback: take the FULL ring, not a cursor resume
    clearTopicCursor(`terminal:${session.id}`);
    const unsubscribe = client.subscribe(`terminal:${session.id}`, (frames, meta) => {
      if (meta.kind === "gap") {
        term.writeln(`\r\n\x1b[33m--- output truncated ---\x1b[0m`);
        return;
      }
      for (const raw of frames) {
        const frame = raw as TerminalFrame;
        if (typeof frame?.data !== "string") continue;
        term.write(base64ToUtf8(frame.data));
      }
      term.scrollToBottom();
    });

    return () => {
      unsubscribe();
      observer.disconnect();
      term.dispose();
    };
  }, [session.id, session.cols, session.rows, fontSize]);

  return <div ref={hostRef} data-testid="grid-xterm-host" className="h-full min-h-0 flex-1" />;
}

function DensityChip({ value }: { value: TerminalDensity }) {
  const density = useTerminalGrid((s) => s.density);
  const setDensity = useTerminalGrid((s) => s.setDensity);
  return (
    <button
      data-testid={`density-${value}`}
      onClick={() => setDensity(value)}
      className={cn(
        "rounded border px-1.5 text-[10px]",
        density === value
          ? "border-dept-engineering bg-dept-engineering font-semibold text-acos-bg0"
          : "border-acos-line bg-acos-bg3 text-acos-fg1 hover:text-acos-fg0",
      )}
    >
      {value}
    </button>
  );
}

/** ⤢ modal (36 §4 — U06): the terminal enlarged, live output + a prompt.
 *  The prompt is a Founder→agent directive through the EXISTING comms path
 *  (MessageService: Founder↔agent DM) — persisted, audited, emits
 *  agent.message.sent. It is NOT a write into the agent loop (N4). */
function FocusModal({ session, onClose }: { session: TerminalSessionDto; onClose: () => void }) {
  const { companyId } = useParams({ from: "/c/$companyId" });
  const badges = usePresence((s) => s.badges);
  const [draft, setDraft] = useState("");
  const [sentNote, setSentNote] = useState<string | null>(null);
  const badge = session.agentId ? (badges[session.agentId] ?? "IDLE") : "IDLE";

  const directive = useMutation({
    mutationFn: async (body: string) => {
      const channel = await api.comms.openDm(companyId, session.agentId!);
      return api.comms.send(companyId, channel.id, {
        body,
        ...(session.taskId ? { refs: [{ kind: "task", id: session.taskId }] } : {}),
      });
    },
    onSuccess: () => {
      setDraft("");
      setSentNote("Direktif gönderildi — Founder→ajan DM'i olarak kaydedildi (denetlenebilir).");
      void queryClient.invalidateQueries({ queryKey: [companyId, "channels"] });
    },
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
      role="dialog"
      aria-modal="true"
      aria-label="Terminal focus"
      data-testid="focus-terminal"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex h-full w-full max-w-6xl flex-col overflow-hidden rounded-lg border border-acos-line bg-acos-bg1">
        <div className="flex h-8 shrink-0 items-center gap-2 border-b border-acos-line bg-acos-bg2 px-3 text-[11px]">
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ background: presenceColor(badge.toLowerCase()) }}
          />
          <span className="font-semibold text-acos-fg0">{session.agentName ?? "—"}</span>
          {session.taskNumber !== null && (
            <span className="text-acos-fg2">TASK-{session.taskNumber}</span>
          )}
          <code className="truncate text-[10px] text-acos-fg2">{session.title}</code>
          <button
            data-testid="focus-close"
            onClick={onClose}
            className="ml-auto text-acos-fg2 hover:text-acos-fg0"
            aria-label="Kapat"
          >
            ✕
          </button>
        </div>
        <div className="min-h-0 flex-1 bg-[#06080b] p-1">
          <GridXterm session={session} fontSize={13} />
        </div>
        <form
          className="flex shrink-0 items-center gap-2 border-t border-acos-line bg-acos-bg2 px-3 py-2"
          onSubmit={(e) => {
            e.preventDefault();
            const body = draft.trim();
            if (body && session.agentId && !directive.isPending) directive.mutate(body);
          }}
        >
          <input
            data-testid="directive-input"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setSentNote(null);
            }}
            placeholder={
              session.agentId
                ? `${session.agentName ?? "ajan"}'a Founder direktifi… (DM olarak iletilir)`
                : "bu oturuma bağlı ajan yok"
            }
            disabled={!session.agentId || directive.isPending}
            className="min-w-0 flex-1 rounded-md border border-acos-line bg-acos-bg1 px-2.5 py-1.5 font-mono text-[12px] text-acos-fg0 placeholder:text-acos-fg2 focus:border-dept-engineering focus:outline-none"
          />
          <button
            type="submit"
            data-testid="directive-send"
            disabled={!session.agentId || draft.trim() === "" || directive.isPending}
            className="shrink-0 rounded-md px-3 py-1.5 text-[11px] font-semibold text-white disabled:opacity-40"
            style={{ background: "#a879ff" }}
          >
            {directive.isPending ? "Gönderiliyor…" : "Direktif Gönder"}
          </button>
        </form>
        {(sentNote ?? directive.error) && (
          <div
            className="shrink-0 border-t border-acos-line px-3 py-1 text-[10px]"
            style={{ color: directive.error ? "#ff6b8a" : "#3fd0a0" }}
            data-testid="directive-status"
          >
            {directive.error ? `Gönderilemedi: ${String(directive.error)}` : sentNote}
          </div>
        )}
      </div>
    </div>
  );
}

function CellFrame({
  session,
  children,
  onFocus,
}: {
  session: TerminalSessionDto;
  children: ReactNode;
  onFocus: () => void;
}) {
  const badges = usePresence((s) => s.badges);
  const closeAgent = useTerminalGrid((s) => s.closeAgent);
  const selectedAgentId = useFocus((s) => s.selectedAgentId);
  const setSelectedAgent = useFocus((s) => s.setSelectedAgent);
  const badge = session.agentId ? (badges[session.agentId] ?? "IDLE") : "IDLE";
  const focused = session.agentId !== null && session.agentId === selectedAgentId;

  return (
    <div
      data-testid="terminal-cell"
      className={cn(
        "flex min-h-0 flex-col overflow-hidden rounded-md border bg-[#06080b]",
        focused ? "border-dept-engineering" : "border-acos-line",
      )}
    >
      <div className="flex h-[22px] shrink-0 items-center gap-1.5 border-b border-acos-line bg-acos-bg2 px-1.5 text-[9.5px]">
        <span
          className="h-[5px] w-[5px] shrink-0 rounded-full"
          style={{ background: presenceColor(badge.toLowerCase()) }}
        />
        <button
          className="truncate font-semibold text-acos-fg0 hover:text-dept-engineering"
          onClick={() => session.agentId && setSelectedAgent(focused ? null : session.agentId)}
          title={session.title}
        >
          {session.agentName ?? session.title}
        </button>
        {session.taskNumber !== null && (
          <span className="shrink-0 text-acos-fg2">· TASK-{session.taskNumber}</span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-acos-fg2">
          <button
            data-testid="cell-focus"
            title="öne çıkar + Founder direktifi"
            onClick={onFocus}
            className="hover:text-acos-fg0"
          >
            ⤢
          </button>
          {session.agentId && (
            <button
              data-testid="cell-close"
              title="görünümü kapat (oturum sürer)"
              onClick={() => closeAgent(session.agentId!)}
              className="hover:text-acos-fg0"
            >
              ✕
            </button>
          )}
        </span>
      </div>
      {children}
    </div>
  );
}

export function TerminalGrid() {
  const { companyId } = useParams({ from: "/c/$companyId" });
  const density = useTerminalGrid((s) => s.density);
  const closedAgentIds = useTerminalGrid((s) => s.closedAgentIds);
  const openAll = useTerminalGrid((s) => s.openAll);
  const [focusedId, setFocusedId] = useState<string | null>(null);

  const sessions = useQuery({
    queryKey: [companyId, "terminals"],
    queryFn: () => api.terminals.list(companyId, { limit: 100 }),
    refetchInterval: 10_000,
  });

  const { team, members } = useTeamMemberSet(companyId);
  const active = (sessions.data?.items ?? []).filter(
    (s) =>
      s.status === "active" &&
      (members === null || (s.agentId !== null && members.has(s.agentId))),
  );
  const open = active.filter((s) => !s.agentId || !closedAgentIds.includes(s.agentId));
  const hiddenCount = active.length - open.length;
  const focused = focusedId ? (active.find((s) => s.id === focusedId) ?? null) : null;

  return (
    <div className="flex h-full min-h-0 flex-col bg-acos-bg1">
      <div className="flex h-6 shrink-0 items-center gap-1.5 border-b border-acos-line px-2 text-[9.5px] text-acos-fg2">
        <span>
          {open.length} açık terminal
          {hiddenCount > 0 && ` · ${hiddenCount} gizli`}
          {team && <span className="text-dept-engineering"> · filtre: {team.name}</span>}
        </span>
        {hiddenCount > 0 && (
          <button
            data-testid="terminal-open-all"
            onClick={openAll}
            className="text-dept-engineering hover:underline"
          >
            hepsini aç
          </button>
        )}
        <span className="ml-auto">yoğunluk:</span>
        <DensityChip value="S" />
        <DensityChip value="M" />
        <DensityChip value="L" />
      </div>
      {open.length === 0 ? (
        <div
          className="flex flex-1 items-center justify-center text-[11px] text-acos-fg2"
          data-testid="terminal-grid-empty"
        >
          {active.length === 0
            ? "Açık terminal oturumu yok — ajanlar çalışmaya başlayınca burada belirir."
            : "Tüm terminaller gizli — roster'dan ya da 'hepsini aç' ile geri aç."}
        </div>
      ) : (
        <div
          data-testid="terminal-grid"
          className="grid min-h-0 flex-1 gap-1 overflow-auto p-1"
          style={{
            gridTemplateColumns: `repeat(${DENSITY_COLS[density]}, minmax(0, 1fr))`,
            gridAutoRows: DENSITY_MIN_H[density],
          }}
        >
          {open.map((session) => (
            <CellFrame key={session.id} session={session} onFocus={() => setFocusedId(session.id)}>
              {/* while focused, the cell releases its topic subscription so the
                  modal's fresh subscribe gets the full ring replay (refcount) */}
              {focused?.id === session.id ? (
                <div className="flex flex-1 items-center justify-center text-[10px] text-acos-fg2">
                  öne çıkarıldı ⤢
                </div>
              ) : (
                <GridXterm session={session} fontSize={DENSITY_FONT[density]} />
              )}
            </CellFrame>
          ))}
        </div>
      )}
      {focused && <FocusModal session={focused} onClose={() => setFocusedId(null)} />}
    </div>
  );
}
