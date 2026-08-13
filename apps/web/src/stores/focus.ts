// focusStore (36 §3): cross-panel agent focus. Selecting an agent anywhere
// (office avatar, roster, terminal) highlights it across every panel —
// consumers filter/highlight by selectedAgentId (wired per panel in U05–U09).
import { create } from "zustand";

interface FocusState {
  selectedAgentId: string | null;
  setSelectedAgent: (agentId: string | null) => void;
}

export const useFocus = create<FocusState>((set) => ({
  selectedAgentId: null,
  setSelectedAgent: (agentId) => set({ selectedAgentId: agentId }),
}));
