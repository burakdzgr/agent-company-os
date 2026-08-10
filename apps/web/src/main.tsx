// Hello-world SPA stub (T05). TanStack Router layout, login/setup pages and
// the real shell land in T20.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";

const container = document.getElementById("root");
if (!container) throw new Error("missing #root");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
