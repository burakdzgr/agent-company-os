// CameraRig — tıkla→düğüme uç, boşluğa tıkla→galaksiye dön.
//
// Kamera konumu her karede hedefe LERP edilir; anlık atlama yerine yumuşak
// yaklaşma "uçuş" hissini verir. OrbitControls'ün hedefi de aynı anda
// taşınır, yoksa kullanıcı döndürmeye başladığında kamera eski merkez
// etrafında dönerdi.
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import * as THREE from "three";
import type { GalaxyNode } from "./layout.js";

/**
 * OrbitControls'ün BU dosyanın ihtiyaç duyduğu yüzeyi. Tam tipi `three-stdlib`
 * içinde ve o paket drei'nin iç bağımlılığı — doğrudan import etmek, bizim
 * seçmediğimiz bir sürüme bağlanmak olurdu. Kullandığımız kadarını yazıyoruz.
 */
export interface OrbitLike {
  target: THREE.Vector3;
  update(): void;
}

/** Galaksinin tamamını gören açılış konumu. */
export const HOME_POSITION: [number, number, number] = [0, 14, 30];

export function CameraRig({
  target,
  controls,
}: {
  /** Odaklanılacak düğüm; null ⇒ galaksi görünümüne dön. */
  target: GalaxyNode | null;
  controls: React.RefObject<OrbitLike | null>;
}) {
  const { camera } = useThree();
  const desiredPosition = useRef(new THREE.Vector3(...HOME_POSITION));
  const desiredTarget = useRef(new THREE.Vector3(0, 0, 0));

  useEffect(() => {
    if (!target) {
      desiredPosition.current.set(...HOME_POSITION);
      desiredTarget.current.set(0, 0, 0);
      return;
    }
    const [x, y, z] = target.position;
    desiredTarget.current.set(x, y, z);
    // düğümün biraz dışında dur: merkezden dışa doğru kaydırılmış bir nokta
    const outward = new THREE.Vector3(x, y, z);
    const distance = outward.length() || 1;
    outward.multiplyScalar((distance + 4.5) / distance);
    desiredPosition.current.set(outward.x, outward.y + 1.5, outward.z);
  }, [target]);

  useFrame((_state, delta) => {
    // delta'ya bağlı yumuşatma: kare hızından bağımsız aynı his
    const alpha = 1 - Math.exp(-delta * 3.2);
    camera.position.lerp(desiredPosition.current, alpha);
    const orbit = controls.current;
    if (orbit) {
      orbit.target.lerp(desiredTarget.current, alpha);
      orbit.update();
    }
  });

  return null;
}
