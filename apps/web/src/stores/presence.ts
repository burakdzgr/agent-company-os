// presenceStore (24 §4): latest-wins presence/office state from the
// presence:<companyId> topic. Real content arrives with the office projector
// (T25/T26); the store already speaks snapshot-then-delta.
import { create } from "zustand";

export interface PresenceSnapshot {
  layoutVersion: number;
  agents: unknown[];
  interactions: unknown[];
}

interface PresenceState {
  snapshot: PresenceSnapshot | null;
  applySnapshot: (snapshot: PresenceSnapshot) => void;
  reset: () => void;
}

export const usePresence = create<PresenceState>()((set) => ({
  snapshot: null,
  applySnapshot: (snapshot) => set({ snapshot }),
  reset: () => set({ snapshot: null }),
}));
