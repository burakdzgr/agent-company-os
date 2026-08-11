// Pixi bridge (23 §5, §7): mounts the Pixi app, renders layers
// floor/zones/desks/avatars/effects/labels from the headless engine, and
// drives engine.tick from the Pixi ticker. This file is the ONLY place in the
// office module allowed to touch animation APIs (office lint rule — no fake
// motion; every visible change traces to a projector instruction). React
// renders overlays only; per-frame state never enters React.
import { useEffect, useRef, useState } from "react";
import { Application, Container, Graphics, Text } from "pixi.js";
import type { OfficeLayout } from "@acos/contracts";
import { useOfficeStore } from "../../stores/office.js";
import type { OfficeSceneEngine } from "./sceneState.js";

const BADGE_COLOR: Record<string, number> = {
  IDLE: 0x94a3b8,
  WORKING: 0x2fbf71,
  COMMUNICATING: 0x3b82f6,
  REVIEWING: 0x8b5cf6,
  ESCALATING: 0xe5484d,
  OFFLINE: 0x475569,
  THINKING: 0xe8a13c,
};

declare global {
  interface Window {
    __acosOffice?: {
      readonly lastAppliedEventId: string | null;
      readonly agentCount: number;
      readonly interactionCount: number;
      readonly snapshotCount: number;
      readonly debugRing: unknown[];
    };
  }
}

function installDebugHook(engine: OfficeSceneEngine, getSnapshotCount: () => number): void {
  window.__acosOffice = {
    get lastAppliedEventId() {
      return engine.lastAppliedEventId;
    },
    get agentCount() {
      return engine.avatars.size;
    },
    get interactionCount() {
      return engine.interactions.size;
    },
    get snapshotCount() {
      return getSnapshotCount();
    },
    get debugRing() {
      return [...engine.debugRing.slice(-20)];
    },
  };
}

function drawStaticLayers(zoneLayer: Container, layout: OfficeLayout, cell: number): void {
  zoneLayer.removeChildren();
  for (const zone of layout.zones) {
    const g = new Graphics();
    g.rect(zone.rect.x * cell, zone.rect.y * cell, zone.rect.w * cell, zone.rect.h * cell)
      .fill({ color: zone.kind === "meeting" ? 0x1c2431 : 0x1a2130 })
      .stroke({ color: 0x2d3a52, width: 2 });
    zoneLayer.addChild(g);
    const label = new Text({
      text: zone.label ?? zone.id,
      style: { fill: 0x8fa3c8, fontSize: 14, fontFamily: "sans-serif" },
    });
    label.position.set(zone.rect.x * cell + 6, zone.rect.y * cell + 4);
    zoneLayer.addChild(label);
    for (const desk of zone.desks ?? []) {
      const d = new Graphics();
      d.rect(desk.cell.x * cell - 10, desk.cell.y * cell - 6, 20, 12).fill({ color: 0x33415e });
      zoneLayer.addChild(d);
    }
  }
}

export function OfficeCanvas({ onSelectAgent }: { onSelectAgent?: (agentId: string) => void }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const engine = useOfficeStore((s) => s.engine);
  const snapshotCount = useOfficeStore((s) => s.snapshotCount);
  const [fallback, setFallback] = useState(false);
  const snapshotCountRef = useRef(snapshotCount);
  snapshotCountRef.current = snapshotCount;

  useEffect(() => {
    installDebugHook(engine, () => snapshotCountRef.current);
  }, [engine]);

  useEffect(() => {
    if (fallback || !hostRef.current) return;
    const host = hostRef.current;
    const app = new Application();
    let destroyed = false;
    let renderedLayoutVersion = -1;
    let renderedEngineVersion = -1;
    const avatarNodes = new Map<string, { root: Container; body: Graphics; label: Text }>();

    (async () => {
      try {
        await app.init({ background: 0x0f1420, resizeTo: host, antialias: true });
      } catch {
        if (!destroyed) setFallback(true); // §15 degraded mode: canvas → list
        return;
      }
      if (destroyed) {
        app.destroy(true);
        return;
      }
      host.appendChild(app.canvas);
      const camera = new Container();
      const zoneLayer = new Container();
      const avatarLayer = new Container();
      const effectLayer = new Container();
      camera.addChild(zoneLayer, avatarLayer, effectLayer);
      app.stage.addChild(camera);
      camera.scale.set(0.5);

      // pan (drag) + zoom (wheel), clamped — camera only, no avatar motion
      let dragging = false;
      let last = { x: 0, y: 0 };
      app.canvas.addEventListener("pointerdown", (e) => {
        dragging = true;
        last = { x: e.clientX, y: e.clientY };
      });
      window.addEventListener("pointerup", () => (dragging = false));
      app.canvas.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        camera.position.x += e.clientX - last.x;
        camera.position.y += e.clientY - last.y;
        last = { x: e.clientX, y: e.clientY };
      });
      app.canvas.addEventListener("wheel", (e) => {
        e.preventDefault();
        const next = Math.min(2, Math.max(0.25, camera.scale.x * (e.deltaY > 0 ? 0.9 : 1.1)));
        camera.scale.set(next);
      });

      const CELL = 32;
      app.ticker.add((ticker) => {
        engine.tick(ticker.deltaMS / 1000);
        if (engine.layout && engine.layoutVersion !== renderedLayoutVersion) {
          renderedLayoutVersion = engine.layoutVersion;
          drawStaticLayers(zoneLayer, engine.layout, CELL);
        }
        if (engine.version === renderedEngineVersion) return;
        renderedEngineVersion = engine.version;

        // avatars: create/update/remove Pixi nodes from engine state
        for (const [agentId, avatar] of engine.avatars) {
          let node = avatarNodes.get(agentId);
          if (!node) {
            const root = new Container();
            const body = new Graphics();
            const label = new Text({
              text: avatar.name,
              style: { fill: 0xdbe4f5, fontSize: 12, fontFamily: "sans-serif" },
            });
            label.anchor.set(0.5, 0);
            label.position.set(0, 14);
            root.addChild(body, label);
            root.eventMode = "static";
            root.cursor = "pointer";
            root.on("pointertap", () => onSelectAgent?.(agentId));
            avatarLayer.addChild(root);
            node = { root, body, label };
            avatarNodes.set(agentId, node);
          }
          node.body
            .clear()
            .circle(0, 0, 10)
            .fill({ color: BADGE_COLOR[avatar.badge] ?? 0x94a3b8 })
            .stroke({ color: 0x0f1420, width: 2 });
          node.label.text = avatar.name;
          node.root.position.set(avatar.pos.x * CELL, avatar.pos.y * CELL);
        }
        for (const [agentId, node] of avatarNodes) {
          if (!engine.avatars.has(agentId)) {
            node.root.destroy();
            avatarNodes.delete(agentId);
          }
        }

        // interaction bubbles
        effectLayer.removeChildren();
        for (const interaction of engine.interactions.values()) {
          const bubble = new Graphics();
          const color = interaction.kind === "escalation" ? 0xe5484d : 0x3b82f6;
          bubble
            .circle(interaction.atCell.x * CELL, interaction.atCell.y * CELL - 18, 6)
            .fill({ color });
          effectLayer.addChild(bubble);
        }
      });
    })();

    return () => {
      destroyed = true;
      try {
        app.destroy(true, { children: true });
      } catch {
        /* not initialized */
      }
      host.replaceChildren();
    };
  }, [engine, fallback, onSelectAgent]);

  if (fallback) {
    // degraded mode (23 §15): same store, list rendering
    return <FallbackList onSelectAgent={onSelectAgent} />;
  }
  return <div ref={hostRef} data-testid="office-canvas" className="h-[540px] w-full rounded-lg" />;
}

function FallbackList({
  onSelectAgent,
}: {
  onSelectAgent?: ((agentId: string) => void) | undefined;
}) {
  const engine = useOfficeStore((s) => s.engine);
  const snapshotCount = useOfficeStore((s) => s.snapshotCount);
  void snapshotCount; // re-render on snapshots
  return (
    <ul data-testid="office-fallback" className="space-y-1 text-sm">
      {[...engine.avatars.values()].map((a) => (
        <li key={a.agentId}>
          <button onClick={() => onSelectAgent?.(a.agentId)} className="underline">
            {a.name}
          </button>{" "}
          — {a.badge} @ ({Math.round(a.pos.x)},{Math.round(a.pos.y)})
        </li>
      ))}
    </ul>
  );
}
