// RealtimeDispatcher (24 §5): one instance per active company, mounted by the
// /c/$companyId layout. Owns the events + presence subscriptions and routes
// frames into Zustand stores + TanStack Query invalidation. Stores are the
// only WS consumers — components read stores/queries, never the socket.
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  EventSchema,
  PresenceStateSchema,
  type Event,
  type RealtimeStatus,
} from "@acos/contracts";
import { getRealtimeClient } from "./client.js";
import { invalidationKeysFor } from "./invalidation.js";
import { useEventTicker } from "../stores/eventTicker.js";
import { usePresence } from "../stores/presence.js";
import { useOfficeStore } from "../stores/office.js";

export function useRealtimeStatus(): RealtimeStatus {
  const [status, setStatus] = useState<RealtimeStatus>(() => getRealtimeClient().getStatus());
  useEffect(() => getRealtimeClient().onStatus(setStatus), []);
  return status;
}

export function RealtimeDispatcher({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const pushEvents = useEventTicker((s) => s.push);
  const resetTicker = useEventTicker((s) => s.reset);
  const applySnapshot = usePresence((s) => s.applySnapshot);
  const setBadge = usePresence((s) => s.setBadge);
  const resetPresence = usePresence((s) => s.reset);
  const officeSnapshot = useOfficeStore((s) => s.applySnapshot);
  const officeEnqueue = useOfficeStore((s) => s.enqueue);
  const officeReset = useOfficeStore((s) => s.reset);

  useEffect(() => {
    const client = getRealtimeClient();
    resetTicker();
    resetPresence();
    officeReset();

    const unsubscribeEvents = client.subscribe(`events:${companyId}`, (batch) => {
      const parsed: Event[] = [];
      for (const raw of batch) {
        const result = EventSchema.safeParse(raw);
        if (result.success) parsed.push(result.data);
      }
      if (parsed.length === 0) return;
      pushEvents(parsed);
      const invalidated = new Set<string>();
      for (const event of parsed) {
        for (const key of invalidationKeysFor(companyId, event)) {
          const cacheKey = JSON.stringify(key);
          if (invalidated.has(cacheKey)) continue;
          invalidated.add(cacheKey);
          void queryClient.invalidateQueries({ queryKey: key as unknown[] });
        }
      }
    });

    const unsubscribePresence = client.subscribe(`presence:${companyId}`, (batch, meta) => {
      if (meta.kind === "snapshot" && batch[0]) {
        const parsed = PresenceStateSchema.safeParse(batch[0]);
        if (parsed.success) {
          applySnapshot(parsed.data);
          officeSnapshot(parsed.data);
        }
        return;
      }
      // deltas: office.* instructions → officeStore (invariant enforced there);
      // status changes also refresh the Agent Monitor badge map
      for (const instruction of batch) {
        officeEnqueue(instruction);
        const status = instruction as { type?: string; agentId?: string; badge?: string };
        if (status.type === "office.status.changed" && status.agentId && status.badge) {
          setBadge(status.agentId, status.badge as never);
        }
      }
    });

    return () => {
      unsubscribeEvents();
      unsubscribePresence();
    };
  }, [
    companyId,
    queryClient,
    pushEvents,
    resetTicker,
    applySnapshot,
    setBadge,
    resetPresence,
    officeSnapshot,
    officeEnqueue,
    officeReset,
  ]);

  return null;
}
