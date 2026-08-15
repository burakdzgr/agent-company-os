// GalaxyDust — sahneyi "toplar" olmaktan çıkarıp GALAKSİ yapan katman.
//
// Neden gerekli: bir şirketin anı sayısı yüzlerle ölçülür, bir galaksinin
// yıldızları milyarlarla. 22 küreyi boşluğa dizince ortaya galaksi değil
// havada duran toplar çıkıyor — kollar görünmüyor, çekirdek yok, derinlik
// yok. Toz bulutu bu boşluğu doldurur: yapıyı O çizer, anılar o yapının
// içinde parlayan yıldızlar olur.
//
// Bu katman VERİ DEĞİL, dekordur. Hiçbir anıyı temsil etmez, tıklanmaz,
// filtrelerden etkilenmez. Anı sayısı değişince toz değişmez — yoksa
// galaksinin şekli şirketin o anki anı sayısına göre oynardı.
//
// Maliyet: iki `Points` + bir `Sprite` = üç draw call, tek seferlik hesap,
// kare başına sıfır iş. Sabit tohumla üretilir; her render'da aynı galaksi.
import { useMemo } from "react";
import * as THREE from "three";
import { ARMS, ARM_TWIST } from "./layout.js";

// Sayılar görselden ayarlandı: 9000/2600'de kollar noktalı ve seyrek
// görünüyordu ("çizgi" değil "kesik kesik iz"). Maliyet önemsiz — nokta sayısı
// draw call'u değiştirmiyor, tek seferlik hesap ve kare başına sıfır iş.
/** Kollardaki toz. */
const DISC_COUNT = 17000;
/** Merkez şişkinliği (bulge) — küresel, yoğun, sıcak. */
const BULGE_COUNT = 4200;
/** Toz diskin dış sınırı: agent kabuğunun (20) biraz ötesi. */
const DISC_RADIUS = 26;

/** Sabit tohumlu LCG — galaksi her yenilemede aynı olmalı. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

/** Üç düzgün dağılımın toplamı ≈ normal dağılım (merkezde yığılır). */
function gaussian(random: () => number): number {
  return random() + random() + random() - 1.5;
}

export function GalaxyDust() {
  const disc = useMemo(() => buildDisc(), []);
  const bulge = useMemo(() => buildBulge(), []);
  const glow = useMemo(() => buildGlowTexture(), []);
  const star = useMemo(() => buildStarTexture(), []);

  return (
    <group>
      {/*
        Çekirdek parıltısı: tek bir additive sprite. Gerçek galakside merkez
        ayrı yıldızlar olarak değil, çözülemeyen bir ışık lekesi olarak
        görünür — noktaları sıklaştırarak bunu taklit etmek pahalı olurdu.

        Ölçü ve opaklık ölçülerek kısıldı: ilk denemede (16 birim, 0.75) Bloom
        ile birlikte merkezi tümüyle beyaza boğuyordu — çekirdek "parlak" değil
        "patlamış" görünüyor, kolların iç ucu kayboluyordu.
      */}
      <sprite scale={[10, 10, 1]} renderOrder={-2}>
        <spriteMaterial
          map={glow}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          transparent
          opacity={0.42}
          toneMapped={false}
        />
      </sprite>
      {/* additive + depthWrite kapalı: toz üst üste binince birikerek
          parlar (gerçek nebula davranışı) ve anıların önünü kesmez */}
      <points geometry={bulge} raycast={() => null} frustumCulled={false} renderOrder={-1}>
        <pointsMaterial
          map={star}
          size={0.34}
          sizeAttenuation
          vertexColors
          transparent
          opacity={0.9}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          toneMapped={false}
        />
      </points>
      <points geometry={disc} raycast={() => null} frustumCulled={false} renderOrder={-1}>
        <pointsMaterial
          map={star}
          size={0.3}
          sizeAttenuation
          vertexColors
          transparent
          opacity={0.85}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          toneMapped={false}
        />
      </points>
    </group>
  );
}

function buildDisc(): THREE.BufferGeometry {
  const random = makeRandom(0x5eed10a);
  const positions = new Float32Array(DISC_COUNT * 3);
  const colors = new Float32Array(DISC_COUNT * 3);

  const CORE = new THREE.Color("#cfe0ff"); // mavi-beyaz iç disk
  const MID = new THREE.Color("#8f6fe0"); // mor kollar (project rengiyle akraba)
  const RIM = new THREE.Color("#245f6e"); // sönük camgöbeği dış kenar
  const color = new THREE.Color();

  for (let i = 0; i < DISC_COUNT; i += 1) {
    // Üs merkeze doğru yoğunlaştırır (düzgün dağılım halka gibi görünürdü).
    // t² fazla agresifti: dış kollar noktasız kalıp galaksi ortada bitiyordu;
    // 1.7 dışa doğru sönümlenen ama YOK OLMAYAN bir kuyruk bırakıyor.
    const t = random();
    const radius = 1.4 + DISC_RADIUS * Math.pow(t, 1.7);
    const arm = Math.floor(random() * ARMS);
    // Kol kalınlığı: dışa doğru hafif açılır — gerçek kollar da dağılır.
    //
    // Bu katsayı ölçülerek düşürüldü. İlk denemede (0.42 + r·0.011) saçılma
    // dış yarıçapta ~0.7 radyanı buluyordu; kollar arası açı 2π/4 ≈ 1.57
    // olduğu için komşu kollar birbirine karışıp toz DÜZGÜN BİR DİSKE
    // dönüşüyordu — ekran görüntüsünde sarmal hiç görünmüyordu.
    const scatter = gaussian(random) * (0.13 + radius * 0.005);
    const angle = (arm / ARMS) * Math.PI * 2 + radius * ARM_TWIST + scatter;
    // Disk merkezde kalın, dışta ince (üstel incelme).
    const thickness = 0.22 + 2.6 * Math.exp(-radius / 7);
    const y = gaussian(random) * thickness * 0.6;

    positions[i * 3] = Math.cos(angle) * radius;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = Math.sin(angle) * radius;

    // renk yarıçapla: iç mavi-beyaz → mor kol → sönük kenar
    const k = Math.min(1, radius / DISC_RADIUS);
    if (k < 0.35) color.copy(CORE).lerp(MID, k / 0.35);
    else color.copy(MID).lerp(RIM, (k - 0.35) / 0.65);
    // parlaklık dağılımı: çoğu toz sönük, azı parlak — düz parlaklık
    // "kum kağıdı" gibi görünürdü
    const brightness = 0.18 + 0.72 * random() * random();
    colors[i * 3] = color.r * brightness;
    colors[i * 3 + 1] = color.g * brightness;
    colors[i * 3 + 2] = color.b * brightness;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return geometry;
}

function buildBulge(): THREE.BufferGeometry {
  const random = makeRandom(0xb0193e);
  const positions = new Float32Array(BULGE_COUNT * 3);
  const colors = new Float32Array(BULGE_COUNT * 3);

  const INNER = new THREE.Color("#fff2d6"); // sıcak beyaz çekirdek
  const OUTER = new THREE.Color("#9fb6ff");
  const color = new THREE.Color();

  for (let i = 0; i < BULGE_COUNT; i += 1) {
    // r ∝ rnd^(1/3)'ün tersi: küp alarak merkeze topluyoruz
    const t = random();
    const radius = 3.6 * t * t * t + 0.15;
    const theta = random() * Math.PI * 2;
    const phi = Math.acos(2 * random() - 1);
    positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
    // şişkinlik küre değil basık küre (galaksiler yassıdır)
    positions[i * 3 + 1] = radius * Math.cos(phi) * 0.65;
    positions[i * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta);

    color.copy(INNER).lerp(OUTER, Math.min(1, radius / 3.6));
    const brightness = 0.3 + 0.7 * random();
    colors[i * 3] = color.r * brightness;
    colors[i * 3 + 1] = color.g * brightness;
    colors[i * 3 + 2] = color.b * brightness;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return geometry;
}

/**
 * Yuvarlak yıldız damgası.
 *
 * `pointsMaterial` dokusuz çizince her nokta KARE olur — ekran görüntüsünde
 * toz "yıldız" değil "piksel çöpü" gibi duruyordu. Yumuşak kenarlı radyal
 * gradyan, noktayı yuvarlak ve merkezi parlak yapar.
 */
function buildStarTexture(): THREE.Texture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (context) {
    const gradient = context.createRadialGradient(
      size / 2,
      size / 2,
      0,
      size / 2,
      size / 2,
      size / 2,
    );
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.35, "rgba(255,255,255,0.55)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Radyal gradyan → çekirdek halesi. 2D canvas'ta üretmek en ucuz yol. */
function buildGlowTexture(): THREE.Texture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (context) {
    const gradient = context.createRadialGradient(
      size / 2,
      size / 2,
      0,
      size / 2,
      size / 2,
      size / 2,
    );
    gradient.addColorStop(0, "rgba(255,246,224,0.95)");
    gradient.addColorStop(0.18, "rgba(190,205,255,0.42)");
    gradient.addColorStop(0.45, "rgba(120,120,235,0.14)");
    gradient.addColorStop(1, "rgba(60,70,160,0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
