# ADR-021: Memory Graph Renderer — R3F/three.js "galaxy" as the default, Cytoscape as the fallback

Status: Accepted · Date: 2026-08-15 · Deciders: Founder + implementation agent

## Context

12 §8.2 requires a memory relation graph in the Observatory: nodes styled by the memory's own
attributes, edges by relation kind, capped at 500 nodes server-side. The first implementation
(T48) used **cytoscape + fcose** — a 2D force graph. It is correct and readable, but it renders the
memory as a flat diagram: the scope hierarchy that the domain actually has (company core → project
→ agent, 12 §2) is invisible, and a force layout re-shuffles positions on every load, so the same
memory never sits in the same place twice.

The Founder asked for the codebase-memory-mcp style: a 3D "galaxy" where the company's knowledge
reads as a structure you can fly through, with a slow wave motion and new memories appearing as
stars being born.

Constraints that shaped this:

- `apps/web` is React 19 + Vite (ADR-005). No renderer of its own — this is purely additive.
- The data model and API are **untouched**: the scene consumes the existing
  `GET /companies/:id/memories/graph` payload (ADR-003/ADR-007 unaffected).
- 500 nodes at 60fps is the stated acceptance bar.
- The visualization is a *presentation* layer: it must never be able to break the Observatory.

## Decision

**The 3D galaxy (react-three-fiber + three.js) is the default renderer for the memory graph; the
existing 2D cytoscape graph stays as the fallback when WebGL is unavailable.**

Stack: `three` · `@react-three/fiber` · `@react-three/drei` (OrbitControls, Html) ·
`@react-three/postprocessing` + `postprocessing` (Bloom).

Consequences of the design, and why each way:

1. **Instanced rendering.** All nodes are one `InstancedMesh` and all edges one `LineSegments`.
   500 separate meshes would be 500 draw calls; instancing is what makes the 60fps bar reachable.
   Colour rides the instance colour buffer, size the per-instance matrix.

2. **Deterministic placement, not a force layout.** A node's position is derived from its **id**
   (FNV-1a hash → shell + spiral arm + height). The same memory is always in the same place, and
   adding one memory never moves the others. A force layout would re-scatter the galaxy on every
   refresh, which destroys the spatial memory the visual is supposed to give.

3. **Scope is the layout.** `company` = dense bright core, `project` = spiral arms, `agent` =
   outer orbit. This is the one thing the 2D graph could not express, and it is the domain's own
   hierarchy (12 §2), not decoration.

4. **The wave is per-node, not per-camera.** Each node gets a small sine offset on Y whose phase
   comes from its id, and the whole cloud spins at 0.02 rad/s. Animating the camera instead would
   fight OrbitControls; animating positions with a shared phase would look like a single pulsing
   blob rather than a wave.

5. **New memories pop.** `memory.created` already invalidates `[companyId, "memories"]` via
   RealtimeDispatcher (24 §5: stores are the only socket consumers), so the scene detects new ids by
   diffing successive query results — no second socket listener, no backend change. A new node eases
   0→1 with a brief overshoot, and Bloom's low luminance threshold makes it flare as it appears.

6. **Labels are budgeted.** Only the nearest ~14 nodes plus hover/selection get a DOM label
   (`drei/Html`). 500 simultaneous DOM labels would cost more than the entire 3D scene.

7. **WebGL failure degrades, never breaks.** `webglAvailable()` is checked before mounting; without
   it the panel renders the 2D graph exactly as before. Same `memory-graph` test id either way.

## Alternatives considered

- **Keep cytoscape only.** Cheapest, but cannot express the scope hierarchy and re-shuffles on
  every load. Rejected against the Founder's explicit request.
- **Replace cytoscape entirely.** Would leave environments without WebGL (remote desktops, some CI
  images, old drivers) with no graph at all. Rejected: the Observatory must work everywhere.
- **Server-computed positions.** Preferred in the original brief and still the better long-term
  answer for per-project arms, but it means a payload change — out of scope here (see below).

## Known limitation

The graph payload carries `scope` but not `scopeRef`, so **arms are derived from the node id, not
from the project**. Two memories of different projects can therefore share an arm. Making each
project its own arm requires adding `scopeRef` to `MemoryGraphResponse` — a backend change that
this scope explicitly excluded. Recorded here so the next person does not read the arms as
project boundaries.

## Consequences

- `apps/web` gains ~5 runtime dependencies and a larger vendor chunk (three is ~600 KB gzipped).
  Acceptable for a desktop-first Founder console; the chunk is lazy only insofar as the route is.
- The memory Observatory now has a visual identity that scales with the company's knowledge instead
  of degrading into a hairball as node count grows.
- Above the 500-node server cap the panel keeps the existing warning (12 §8.2/§8.4) — the scene does
  not invent clustering of its own.
