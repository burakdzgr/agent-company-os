// Pixi bridge (23 §5, §7; 36 §7 — U04): mounts the Pixi app, renders the
// derived floorplan (walls/corridor/rooms/props from floorplan.ts) plus the
// avatar/effect layers from the headless engine, and drives engine.tick from
// the Pixi ticker. This file is the ONLY place in the office module allowed
// to touch animation APIs (office lint rule — no fake motion; every visible
// change traces to a projector instruction). Avatars stay circles until U15
// swaps in the PixelLab sprites. React renders overlays only; per-frame
// state never enters React.
import { useEffect, useRef, useState } from "react";
import {
  AnimatedSprite,
  Application,
  Assets,
  Container,
  Graphics,
  Text,
  Texture,
  type Spritesheet,
} from "pixi.js";
import { useOfficeStore } from "../../stores/office.js";
import type { OfficeSceneEngine } from "./sceneState.js";
import { WALL, computeFloorplan, shade, type Floorplan } from "./floorplan.js";
import {
  SPRITE_BASE,
  loadAvatars,
  resolveAvatarId,
  type AvatarEntry,
  type WalkDir,
} from "./characters.js";

// presence palette (36 §2)
const BADGE_COLOR: Record<string, number> = {
  IDLE: 0x5c6773,
  WORKING: 0x4c9aff,
  COMMUNICATING: 0x3fd0a0,
  REVIEWING: 0xffcb47,
  ESCALATING: 0xff4d4d,
  OFFLINE: 0x3a424c,
  THINKING: 0xa879ff,
};

const BG = 0x0b0e13;
const CORRIDOR = 0x12161d;
const WALL_FILL = 0x2a3340;
const WALL_TOP = 0x3a4757;

const hexInt = (hex: string): number => parseInt(hex.slice(1), 16);
/** 15% accent over the app dark — the room's floor base tint. */
function roomBase(accent: string): string {
  const a = parseInt(accent.slice(1), 16);
  const d = BG;
  const mix = (shift: number) =>
    Math.round(((a >> shift) & 255) * 0.15 + ((d >> shift) & 255) * 0.85);
  return `#${((mix(16) << 16) | (mix(8) << 8) | mix(0)).toString(16).padStart(6, "0")}`;
}

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

function paintProps(g: Graphics, plan: Floorplan, cell: number): void {
  for (const prop of plan.props) {
    const x = prop.x * cell;
    const y = prop.y * cell;
    if (prop.kind === "rack") {
      g.rect(x, y, 1.3 * cell, 2.8 * cell).fill(0x161b22);
      for (let i = 0; i < 5; i++) {
        g.rect(x + 0.2 * cell, y + (0.3 + i * 0.5) * cell, 0.7 * cell, 0.18 * cell).fill(0x243040);
        g.rect(x + 1.0 * cell, y + (0.3 + i * 0.5) * cell, 0.14 * cell, 0.18 * cell).fill(
          i % 2 ? 0x3fd0a0 : 0xffcb47,
        );
      }
    } else if (prop.kind === "plant") {
      g.rect(x + 0.25 * cell, y + 0.9 * cell, 0.5 * cell, 0.5 * cell).fill(0x5a4632);
      g.circle(x + 0.5 * cell, y + 0.55 * cell, 0.5 * cell).fill(0x2f7d4a);
      g.circle(x + 0.3 * cell, y + 0.35 * cell, 0.3 * cell).fill(0x3c9a5c);
    } else if (prop.kind === "meeting_table") {
      const w = 5 * cell;
      const h = 2 * cell;
      g.roundRect(x - w / 2, y - h / 2, w, h, 6)
        .fill(0x4a3a2a)
        .stroke({ color: 0x5c4834, width: 2 });
      for (const dx of [-1.6, 0, 1.6]) {
        g.rect(x + dx * cell - 0.3 * cell, y - h / 2 - 0.75 * cell, 0.6 * cell, 0.55 * cell).fill(
          0x2b3440,
        );
        g.rect(x + dx * cell - 0.3 * cell, y + h / 2 + 0.2 * cell, 0.6 * cell, 0.55 * cell).fill(
          0x2b3440,
        );
      }
    } else if (prop.kind === "coffee") {
      g.rect(x, y, 0.9 * cell, 1.1 * cell).fill(0x20262e);
      g.rect(x + 0.2 * cell, y + 0.2 * cell, 0.5 * cell, 0.3 * cell).fill(0x3a2c22);
      g.circle(x + 0.72 * cell, y + 0.9 * cell, 0.08 * cell).fill(0xff6b8a);
    } else {
      // reception
      g.rect(x, y, 5 * cell, 1.1 * cell).fill(0x3a3550);
      g.rect(x, y, 5 * cell, 0.2 * cell).fill(0x4a4568);
    }
  }
}

function paintFloorplan(layer: Container, plan: Floorplan, cell: number): void {
  layer.removeChildren();
  const g = new Graphics();
  layer.addChild(g);

  // corridor/lobby ground fills the whole envelope; rooms paint over it
  g.rect(plan.bounds.x * cell, plan.bounds.y * cell, plan.bounds.w * cell, plan.bounds.h * cell).fill(
    CORRIDOR,
  );

  // room floors: per-department base tint + 1-cell checker
  for (const room of plan.rooms) {
    const base = roomBase(room.accent);
    const light = hexInt(shade(base, 7));
    const { x, y, w, h } = room.rect;
    g.rect(x * cell, y * cell, w * cell, h * cell).fill(hexInt(base));
    for (let cy = Math.ceil(y); cy < y + h; cy++) {
      for (let cx = Math.ceil(x); cx < x + w; cx++) {
        if ((cx + cy) % 2 === 0) g.rect(cx * cell, cy * cell, cell, cell).fill(light);
      }
    }
  }

  // meeting floor
  if (plan.meeting) {
    const { x, y, w, h } = plan.meeting.rect;
    g.rect(x * cell, y * cell, w * cell, h * cell).fill(0x151a24);
  }

  // desks: chair + wooden top (monitor tint is dynamic — see monitor layer)
  for (const room of plan.rooms) {
    for (const desk of room.desks) {
      const cx = desk.cell.x * cell;
      const cy = desk.cell.y * cell;
      g.rect(cx - 0.35 * cell, cy + 0.25 * cell, 0.7 * cell, 0.55 * cell).fill(0x2b3440); // chair
      g.rect(cx - 0.95 * cell, cy - 1.35 * cell, 1.9 * cell, 0.85 * cell).fill(0x5a4632); // top
      g.rect(cx - 0.95 * cell, cy - 1.35 * cell, 1.9 * cell, 0.15 * cell).fill(0x6d573f);
      g.rect(cx - 0.5 * cell, cy - 1.28 * cell, 1.0 * cell, 0.62 * cell).fill(0x0c0f14); // monitor
    }
  }

  // walls (door gaps pre-cut) with a top highlight for pseudo-3D
  for (const wall of plan.walls) {
    g.rect(wall.x * cell, wall.y * cell, wall.w * cell, wall.h * cell).fill(WALL_FILL);
    g.rect(wall.x * cell, wall.y * cell, wall.w * cell, 0.22 * cell).fill(WALL_TOP);
  }

  // entrance: dark threshold + welcome mat
  g.rect(plan.entrance.x * cell, plan.entrance.y * cell, plan.entrance.w * cell, WALL * cell).fill(
    0x0c1016,
  );
  g.rect(
    plan.entrance.x * cell,
    (plan.entrance.y - 0.5) * cell,
    plan.entrance.w * cell,
    0.4 * cell,
  ).fill(0x2f3a2a);

  paintProps(g, plan, cell);

  // labels
  for (const room of plan.rooms) {
    const label = new Text({
      text: room.label.toUpperCase(),
      style: { fill: room.accent, fontSize: 13, fontFamily: "monospace", fontWeight: "bold" },
    });
    label.alpha = 0.8;
    label.position.set((room.rect.x + 1.2) * cell, (room.rect.y + 1.0) * cell);
    layer.addChild(label);
  }
  if (plan.meeting) {
    const label = new Text({
      text: plan.meeting.label.toUpperCase(),
      style: { fill: 0x8fa3c8, fontSize: 12, fontFamily: "monospace" },
    });
    label.alpha = 0.7;
    label.position.set((plan.meeting.rect.x + 0.8) * cell, (plan.meeting.rect.y + 0.6) * cell);
    layer.addChild(label);
  }
  const lobby = new Text({
    text: "LOBBY",
    style: { fill: 0xc9c4e0, fontSize: 11, fontFamily: "monospace" },
  });
  lobby.alpha = 0.55;
  lobby.position.set((plan.entrance.x - 6.6) * cell, (plan.entrance.y - 3.2) * cell);
  layer.addChild(lobby);
}

export function OfficeCanvas({
  onSelectAgent,
  avatarUrls,
}: {
  onSelectAgent?: (agentId: string) => void;
  /** agentId → agents.avatar_url (persistent identity → same character, U15) */
  avatarUrls?: ReadonlyMap<string, string | null>;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const engine = useOfficeStore((s) => s.engine);
  const snapshotCount = useOfficeStore((s) => s.snapshotCount);
  const [fallback, setFallback] = useState(false);
  const snapshotCountRef = useRef(snapshotCount);
  snapshotCountRef.current = snapshotCount;
  const avatarUrlsRef = useRef(avatarUrls);
  avatarUrlsRef.current = avatarUrls;

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
    let plan: Floorplan | null = null;
    let userAdjusted = false;
    interface AvatarNode {
      root: Container;
      sprite: AnimatedSprite | null;
      body: Graphics | null;
      badge: Graphics;
      label: Text;
      lastX: number;
      lastY: number;
      dir: WalkDir;
      anim: string;
    }
    const avatarNodes = new Map<string, AvatarNode>();

    (async () => {
      try {
        await app.init({ background: BG, resizeTo: host, antialias: true });
      } catch {
        if (!destroyed) setFallback(true); // §15 degraded mode: canvas → list
        return;
      }
      if (destroyed) {
        app.destroy(true);
        return;
      }
      host.appendChild(app.canvas);

      // U15: baked character atlas (single page — one draw batch). Failure
      // falls back to the pre-U15 circles; motion semantics are identical.
      let sheet: Spritesheet | null = null;
      const avatarLib = new Map<string, AvatarEntry>();
      try {
        const [loadedSheet, avatarList] = await Promise.all([
          Assets.load<Spritesheet>(`${SPRITE_BASE}/characters.json`),
          loadAvatars(),
        ]);
        sheet = loadedSheet;
        for (const entry of avatarList) avatarLib.set(entry.avatarId, entry);
      } catch {
        sheet = null;
      }
      const camera = new Container();
      const zoneLayer = new Container();
      const monitorLayer = new Graphics();
      const avatarLayer = new Container();
      avatarLayer.sortableChildren = true; // y-sort so lower avatars draw in front
      const effectLayer = new Container();
      camera.addChild(zoneLayer, monitorLayer, avatarLayer, effectLayer);
      app.stage.addChild(camera);

      const CELL = 32;

      // fit the whole floorplan edge-to-edge until the user pans/zooms (36 §7)
      function fitCamera(): void {
        if (userAdjusted || !plan) return;
        const sw = app.screen.width;
        const sh = app.screen.height;
        const pw = plan.bounds.w * CELL;
        const ph = plan.bounds.h * CELL;
        if (pw <= 0 || ph <= 0 || sw <= 0 || sh <= 0) return;
        const scale = Math.min(sw / pw, sh / ph);
        camera.scale.set(scale);
        camera.position.set(
          (sw - pw * scale) / 2 - plan.bounds.x * CELL * scale,
          (sh - ph * scale) / 2 - plan.bounds.y * CELL * scale,
        );
      }
      app.renderer.on("resize", fitCamera);

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
        userAdjusted = true;
        camera.position.x += e.clientX - last.x;
        camera.position.y += e.clientY - last.y;
        last = { x: e.clientX, y: e.clientY };
      });
      app.canvas.addEventListener("wheel", (e) => {
        e.preventDefault();
        userAdjusted = true;
        const next = Math.min(2.5, Math.max(0.2, camera.scale.x * (e.deltaY > 0 ? 0.9 : 1.1)));
        camera.scale.set(next);
      });

      app.ticker.add((ticker) => {
        engine.tick(ticker.deltaMS / 1000);
        if (engine.layout && engine.layoutVersion !== renderedLayoutVersion) {
          renderedLayoutVersion = engine.layoutVersion;
          plan = computeFloorplan(engine.layout);
          paintFloorplan(zoneLayer, plan, CELL);
          fitCamera();
        }
        if (engine.version === renderedEngineVersion) return;
        renderedEngineVersion = engine.version;

        // desk monitors tinted by the seated agent's live status
        monitorLayer.clear();
        if (plan) {
          for (const room of plan.rooms) {
            for (const desk of room.desks) {
              if (!desk.agentId) continue;
              const avatar = engine.avatars.get(desk.agentId);
              const color = avatar ? (BADGE_COLOR[avatar.badge] ?? 0x233040) : 0x233040;
              monitorLayer
                .rect(
                  (desk.cell.x - 0.45) * CELL,
                  (desk.cell.y - 1.22) * CELL,
                  0.9 * CELL,
                  0.5 * CELL,
                )
                .fill({ color, alpha: avatar ? 0.8 : 0.35 });
            }
          }
        }

        // avatars: create/update/remove Pixi nodes from engine state.
        // PixelLab-style sprites (U15): 4-direction walk while a projector
        // walk plays, idle frame at rest — facing derives from the SAME
        // interpolated positions the engine computes (no new motion source).
        for (const [agentId, avatar] of engine.avatars) {
          let node = avatarNodes.get(agentId);
          if (!node) {
            const root = new Container();
            let sprite: AnimatedSprite | null = null;
            let body: Graphics | null = null;
            if (sheet) {
              sprite = new AnimatedSprite([Texture.EMPTY]);
              sprite.anchor.set(0.5, 0.85);
              sprite.scale.set(2); // 16×20 frame → 32×40 on a 32px cell
              sprite.animationSpeed = 0.16;
              root.addChild(sprite);
            } else {
              body = new Graphics();
              root.addChild(body);
            }
            const badge = new Graphics();
            const label = new Text({
              text: avatar.name,
              style: { fill: 0xdbe4f5, fontSize: 12, fontFamily: "sans-serif" },
            });
            label.anchor.set(0.5, 0);
            label.position.set(0, 8);
            root.addChild(badge, label);
            root.eventMode = "static";
            root.cursor = "pointer";
            root.on("pointertap", () => onSelectAgent?.(agentId));
            avatarLayer.addChild(root);
            node = {
              root,
              sprite,
              body,
              badge,
              label,
              lastX: avatar.pos.x,
              lastY: avatar.pos.y,
              dir: "down",
              anim: "",
            };
            avatarNodes.set(agentId, node);
          }

          const dx = avatar.pos.x - node.lastX;
          const dy = avatar.pos.y - node.lastY;
          const moving = Math.abs(dx) + Math.abs(dy) > 0.002;
          if (moving) {
            node.dir =
              Math.abs(dx) >= Math.abs(dy)
                ? dx > 0
                  ? "right"
                  : "left"
                : dy > 0
                  ? "down"
                  : "up";
          }
          node.lastX = avatar.pos.x;
          node.lastY = avatar.pos.y;

          const badgeColor = BADGE_COLOR[avatar.badge] ?? 0x5c6773;
          if (node.sprite && sheet) {
            const avatarId = resolveAvatarId(agentId, avatarUrlsRef.current?.get(agentId) ?? null);
            const animKey = `${avatarId}:${moving ? "walk" : "idle"}:${node.dir}`;
            if (node.anim !== animKey) {
              node.anim = animKey;
              const entry = avatarLib.get(avatarId);
              if (entry) {
                if (moving) {
                  node.sprite.textures = entry.walk[node.dir].map(
                    (name) => sheet!.textures[name] ?? Texture.EMPTY,
                  );
                  node.sprite.play();
                } else {
                  node.sprite.textures = [sheet.textures[entry.idle[node.dir]] ?? Texture.EMPTY];
                  node.sprite.gotoAndStop(0);
                }
              }
            }
            // presence badge above the head (36 §7)
            node.badge
              .clear()
              .circle(0, -40, 3.5)
              .fill(badgeColor)
              .stroke({ color: 0x0b0e13, width: 1 });
          } else if (node.body) {
            node.body
              .clear()
              .ellipse(0, 12, 8, 3)
              .fill({ color: 0x000000, alpha: 0.3 })
              .circle(0, 0, 10)
              .fill({ color: badgeColor })
              .stroke({ color: 0x0b0e13, width: 2 });
            node.label.position.set(0, 14);
          }
          node.label.text = avatar.name;
          node.root.position.set(avatar.pos.x * CELL, avatar.pos.y * CELL);
          node.root.zIndex = avatar.pos.y;
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
          const color = interaction.kind === "escalation" ? 0xff4d4d : 0x3fd0a0;
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
  // height is the caller's: the route view pins 540px, panels give h-full
  return <div ref={hostRef} data-testid="office-canvas" className="h-full w-full rounded-lg" />;
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
