// NodeCloud — düğümler TEK InstancedMesh ile (ADR-021 performans kararı).
//
// 500 düğümü ayrı mesh olarak çizmek 500 draw call demek; instancing bunu bire
// indirir ve 60fps'i mümkün kılan şey budur. Her instance bir anı:
//   renk       = kapsam (company/project/agent)
//   yarıçap    = importance
//   parlaklık  = confidence
//
// Dalga: konumlar HER KAREDE yeniden hesaplanmaz — taban konum sabittir,
// üstüne küçük bir sinüs ofseti binier. Faz düğüm kimliğinden geldiği için
// galaksi "hep birlikte" değil, dalga hâlinde nefes alır.
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { SCOPE_COLOR, clamp01, scopeOf, type GalaxyNode } from "./layout.js";

const WAVE_AMPLITUDE = 0.15;
const WAVE_SPEED = 0.9;
/** Yeni anının 0→1 büyüme süresi (sn). */
const POP_SECONDS = 1.1;

export function NodeCloud({
  nodes,
  fresh,
  selectedId,
  hoveredId,
  onHover,
  onSelect,
}: {
  nodes: GalaxyNode[];
  fresh: Set<string>;
  selectedId: string | null;
  hoveredId: string | null;
  onHover: (id: string | null) => void;
  onSelect: (id: string) => void;
}) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const color = useMemo(() => new THREE.Color(), []);
  /** Yeni düğümlerin pop başlangıç zamanı (saniye). */
  const popStart = useRef(new Map<string, number>());
  const elapsed = useRef(0);

  useEffect(() => {
    for (const id of fresh) {
      if (!popStart.current.has(id)) popStart.current.set(id, elapsed.current);
    }
  }, [fresh]);

  // renk tamponu: kapsam rengi × confidence parlaklığı
  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    nodes.forEach((node, i) => {
      color.set(SCOPE_COLOR[scopeOf(node.scope)]);
      // düşük güven = soluk yıldız; taban 0.45 ki hiç kaybolmasın
      color.multiplyScalar(0.45 + 0.55 * clamp01(node.confidence));
      mesh.setColorAt(i, color);
    });
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [nodes, color]);

  useFrame((_state, delta) => {
    const mesh = meshRef.current;
    if (!mesh) return;
    elapsed.current += delta;
    const t = elapsed.current;

    nodes.forEach((node, i) => {
      const [x, y, z] = node.position;
      // 1) dalga: kimliğe bağlı faz → komşular sırayla iner çıkar
      dummy.position.set(x, y + WAVE_AMPLITUDE * Math.sin(t * WAVE_SPEED + node.phase), z);

      // 2) pop: yeni anı 0'dan büyür (ease-out)
      let scale = node.radius;
      const started = popStart.current.get(node.id);
      if (started !== undefined) {
        const progress = Math.min(1, (t - started) / POP_SECONDS);
        const eased = 1 - (1 - progress) ** 3;
        // hafif "aşma" (overshoot) — yıldız doğarken bir an parlar
        scale *= eased * (1 + 0.35 * Math.sin(progress * Math.PI));
        if (progress >= 1) popStart.current.delete(node.id);
      }
      // seçili/hover düğüm büyür: tıklanabilirliği gösterir
      if (node.id === selectedId) scale *= 1.6;
      else if (node.id === hoveredId) scale *= 1.3;

      dummy.scale.setScalar(Math.max(0.001, scale));
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  });

  if (nodes.length === 0) return null;

  return (
    <instancedMesh
      ref={meshRef}
      // key: düğüm SAYISI değişince instancedMesh yeniden kurulmalı
      key={nodes.length}
      args={[undefined, undefined, nodes.length]}
      onPointerMove={(event) => {
        event.stopPropagation();
        const index = event.instanceId;
        onHover(index === undefined ? null : (nodes[index]?.id ?? null));
      }}
      onPointerOut={() => onHover(null)}
      onClick={(event) => {
        event.stopPropagation();
        const index = event.instanceId;
        const node = index === undefined ? undefined : nodes[index];
        if (node) onSelect(node.id);
      }}
    >
      <sphereGeometry args={[1, 16, 16]} />
      {/* emissive = bloom'un yakaladığı şey; renk instance tamponundan gelir */}
      <meshStandardMaterial
        vertexColors
        emissive="#ffffff"
        emissiveIntensity={0.35}
        roughness={0.45}
        metalness={0.1}
      />
    </instancedMesh>
  );
}
