// One RealtimeClient per browser tab (22 §9): cursors persist in
// sessionStorage (per-tab), auto-resume on reconnect.
import { RealtimeClient, type CursorStore } from "@acos/contracts";

const CURSOR_PREFIX = "acos.ws.cursor.";

const sessionCursorStore: CursorStore = {
  get(topic) {
    const raw = sessionStorage.getItem(CURSOR_PREFIX + topic);
    const seq = raw === null ? NaN : Number(raw);
    return Number.isSafeInteger(seq) && seq > 0 ? seq : null;
  },
  set(topic, seq) {
    sessionStorage.setItem(CURSOR_PREFIX + topic, String(seq));
  },
};

let client: RealtimeClient | null = null;

export function getRealtimeClient(): RealtimeClient {
  if (!client) {
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    client = new RealtimeClient({
      url: `${protocol}://${location.host}/ws`,
      cursorStore: sessionCursorStore,
    });
  }
  return client;
}
