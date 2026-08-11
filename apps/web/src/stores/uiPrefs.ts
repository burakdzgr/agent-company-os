// uiPrefsStore (24 §4): persisted UI preferences — realtime/ephemeral plane.
import { create } from "zustand";
import { persist } from "zustand/middleware";

interface UiPrefsState {
  navCollapsed: boolean;
  toggleNav: () => void;
}

export const useUiPrefs = create<UiPrefsState>()(
  persist(
    (set) => ({
      navCollapsed: false,
      toggleNav: () => set((s) => ({ navCollapsed: !s.navCollapsed })),
    }),
    { name: "acos-ui-prefs" },
  ),
);
