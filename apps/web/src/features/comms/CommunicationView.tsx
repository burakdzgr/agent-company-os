// Communication view (24 §6.8, T33): channel list → thread pane → Founder
// composer. Messages are domain facts — the pane renders exactly what the
// REST page returns; live updates ride agent.message.sent invalidation.
import { useMemo, useState } from "react";
import { useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, Input, StatusPill, cn } from "@acos/ui";
import type { Channel, Message } from "@acos/contracts";
import { api, keys } from "../../lib/api.js";

const KIND_TONE = {
  dm: "accent",
  team: "ok",
  department: "ok",
  task_thread: "neutral",
  review: "warn",
  escalation: "danger",
  project: "neutral",
} as const;

function channelLabel(channel: Channel, agentNames: Map<string, string>): string {
  if (channel.name) return channel.name;
  if (channel.kind === "dm" && channel.dmKey) {
    const names = channel.dmKey
      .split(":")
      .map((part) => (part === "founder" ? "Founder" : (agentNames.get(part) ?? part.slice(-6))));
    return names.join(" ↔ ");
  }
  if (channel.kind === "task_thread") return `Task thread ${channel.taskId?.slice(-6)}`;
  return `${channel.kind} ${channel.id.slice(-6)}`;
}

export function CommunicationView() {
  const { companyId } = useParams({ from: "/c/$companyId" });
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const channels = useQuery({
    queryKey: [companyId, "channels", "list"],
    queryFn: () => api.comms.listChannels(companyId),
  });
  const agents = useQuery({ queryKey: keys.agents(companyId), queryFn: () => api.agents.list(companyId) });
  const agentNames = useMemo(
    () => new Map((agents.data ?? []).map((a) => [a.id, a.name])),
    [agents.data],
  );

  const selected = channels.data?.find((c) => c.id === selectedId) ?? null;
  const messages = useQuery({
    queryKey: [companyId, "channels", "messages", selectedId],
    queryFn: () => api.comms.messages(companyId, selectedId!, { limit: 100 }),
    enabled: selectedId !== null,
  });

  const send = useMutation({
    mutationFn: () => api.comms.send(companyId, selectedId!, { body: draft }),
    onSuccess: () => {
      setDraft("");
      void queryClient.invalidateQueries({ queryKey: [companyId, "channels"] });
    },
  });

  return (
    <div className="flex h-[calc(100vh-9rem)] gap-4">
      <Card className="w-72 shrink-0 overflow-y-auto p-2">
        <p className="px-2 pb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">
          Channels
        </p>
        {(channels.data ?? []).map((channel) => (
          <button
            key={channel.id}
            onClick={() => setSelectedId(channel.id)}
            className={cn(
              "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-ink-50",
              selectedId === channel.id && "bg-accent-500/10",
            )}
            data-testid={`channel-${channel.id}`}
          >
            <StatusPill tone={KIND_TONE[channel.kind] ?? "neutral"}>{channel.kind}</StatusPill>
            <span className="truncate text-ink-800">{channelLabel(channel, agentNames)}</span>
          </button>
        ))}
        {(channels.data ?? []).length === 0 && (
          <p className="px-2 py-6 text-center text-xs text-ink-400">
            Channels appear as teams and tasks are created.
          </p>
        )}
      </Card>

      <Card className="flex min-w-0 flex-1 flex-col p-0">
        {selected ? (
          <>
            <header className="border-b border-ink-100 px-4 py-2 text-sm font-medium text-ink-800">
              {channelLabel(selected, agentNames)}
            </header>
            <div className="flex-1 space-y-2 overflow-y-auto p-4" data-testid="message-pane">
              {(messages.data ?? []).map((message: Message) => (
                <div key={message.id} className="text-sm">
                  <span className="font-medium text-ink-800">
                    {message.senderAgentId
                      ? (agentNames.get(message.senderAgentId) ?? "Agent")
                      : "Founder"}
                  </span>
                  <span className="ml-2 text-xs text-ink-400">
                    {new Date(message.createdAt).toLocaleTimeString()}
                  </span>
                  {message.kind !== "text" && (
                    <StatusPill tone={message.kind === "escalation" ? "danger" : "warn"}>
                      {message.kind}
                    </StatusPill>
                  )}
                  <p className="whitespace-pre-wrap text-ink-700">{message.body}</p>
                </div>
              ))}
              {(messages.data ?? []).length === 0 && (
                <p className="py-8 text-center text-sm text-ink-400">No messages yet.</p>
              )}
            </div>
            <footer className="flex gap-2 border-t border-ink-100 p-3">
              <Input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && draft.trim()) send.mutate();
                }}
                placeholder="Message as Founder…"
                name="messageDraft"
              />
              <Button
                disabled={!draft.trim() || send.isPending}
                onClick={() => send.mutate()}
                data-testid="send-message"
              >
                Send
              </Button>
            </footer>
          </>
        ) : (
          <p className="flex flex-1 items-center justify-center text-sm text-ink-400">
            Pick a channel.
          </p>
        )}
      </Card>
    </div>
  );
}
