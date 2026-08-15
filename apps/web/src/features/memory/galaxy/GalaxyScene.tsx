// GalaxyScene — hafıza grafiğinin 3D galaksi görünümü (ADR-021, 12 §8.2).
//
// Sahne kökü: koyu uzay, hafif ambient + tek nokta ışık, OrbitControls,
// Bloom. Galaksinin kendisi (düğüm bulutu + kenarlar) yavaşça döner; dalga
// hareketi NodeCloud içindedir.
//
// WebGL yoksa (eski sürücü, uzak masaüstü, CI'ın headless'ı) sahne hiç
// kurulmaz: 2D grafiğe düşülür. Görselleştirme bir lüks katmandır, panelin
// çalışmasını engellememeli.
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { Bloom, EffectComposer } from "@react-three/postprocessing";
import { useRef, useState } from "react";
import type * as THREE from "three";
import { Card } from "@acos/ui";
import { CameraRig, HOME_POSITION, type OrbitLike } from "./CameraRig.js";
import { EdgeLines } from "./EdgeLines.js";
import { FilterPanel } from "./FilterPanel.js";
import { NodeCloud } from "./NodeCloud.js";
import { NodeLabels, NodeTooltip } from "./NodeLabels.js";
import { DEFAULT_FILTERS, useGalaxyData, type GalaxyFilters } from "./useGalaxyData.js";
import type { GalaxyNode } from "./layout.js";

/** Galaksinin kendi ekseni etrafındaki çok yavaş dönüşü (rad/s). */
const SPIN = 0.02;

function SpinningGalaxy({ children }: { children: React.ReactNode }) {
  const groupRef = useRef<THREE.Group>(null);
  useFrame((_state, delta) => {
    if (groupRef.current) groupRef.current.rotation.y += SPIN * delta;
  });
  return <group ref={groupRef}>{children}</group>;
}

export function webglAvailable(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(
      canvas.getContext("webgl2") ??
        canvas.getContext("webgl") ??
        canvas.getContext("experimental-webgl"),
    );
  } catch {
    return false;
  }
}

export function GalaxyScene({
  companyId,
  onSelect,
}: {
  companyId: string;
  onSelect: (memoryId: string | null) => void;
}) {
  const [filters, setFilters] = useState<GalaxyFilters>(DEFAULT_FILTERS);
  const [hoveredId, setHovered] = useState<string | null>(null);
  const [selectedId, setSelected] = useState<string | null>(null);
  const controlsRef = useRef<OrbitLike | null>(null);

  const { nodes, edges, totalCount, capped, fresh, isLoading } = useGalaxyData(companyId, filters);

  const hovered = nodes.find((n) => n.id === hoveredId) ?? null;
  const focus: GalaxyNode | null = nodes.find((n) => n.id === selectedId) ?? null;

  const select = (id: string | null) => {
    setSelected(id);
    onSelect(id);
  };

  return (
    <Card className="relative p-0" data-testid="memory-graph">
      {capped && (
        <p className="absolute right-3 top-3 z-10 rounded bg-acos-bg1/90 px-2 py-1 text-xs" style={{ color: "#ffcb47" }}>
          Graf 500 düğümle sınırlı — filtreleri daraltın.
        </p>
      )}
      <FilterPanel
        filters={filters}
        onChange={setFilters}
        nodeCount={nodes.length}
        totalCount={totalCount}
      />
      {isLoading && (
        <p className="absolute inset-0 z-10 flex items-center justify-center text-xs text-acos-fg2">
          Galaksi yükleniyor…
        </p>
      )}
      <div style={{ height: 560, background: "#05060a", borderRadius: 8, overflow: "hidden" }}>
        <Canvas
          camera={{ position: HOME_POSITION, fov: 55, near: 0.1, far: 400 }}
          dpr={[1, 1.75]} // retina'da 2x yerine 1.75: bloom pahalı
          onPointerMissed={() => select(null)} // boşluğa tıkla → galaksiye dön
        >
          <color attach="background" args={["#05060a"]} />
          <ambientLight intensity={0.35} />
          <pointLight position={[0, 8, 0]} intensity={40} distance={60} color="#8fb8ff" />

          <SpinningGalaxy>
            <EdgeLines nodes={nodes} edges={edges} />
            <NodeCloud
              nodes={nodes}
              fresh={fresh}
              selectedId={selectedId}
              hoveredId={hoveredId}
              onHover={setHovered}
              onSelect={select}
            />
            <NodeLabels nodes={nodes} hoveredId={hoveredId} selectedId={selectedId} />
            <NodeTooltip node={hovered} />
          </SpinningGalaxy>

          <OrbitControls
            // drei'nin ref tipi three-stdlib'in OrbitControls'ü; biz yalnız
            // {target, update} yüzeyini kullanıyoruz (bkz. OrbitLike)
            ref={controlsRef as React.Ref<never>}
            enablePan
            enableDamping
            dampingFactor={0.08}
            minDistance={3}
            maxDistance={90}
          />
          <CameraRig target={focus} controls={controlsRef} />

          {/* Bloom eşiği düşük: yüksek-confidence (parlak) düğümler hâlelensin */}
          <EffectComposer>
            <Bloom intensity={1.15} luminanceThreshold={0.22} luminanceSmoothing={0.9} mipmapBlur />
          </EffectComposer>
        </Canvas>
      </div>
    </Card>
  );
}
