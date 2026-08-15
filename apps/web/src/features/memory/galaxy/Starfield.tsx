// Starfield — sahnenin arka planı: uzak, sönük, hareketsiz yıldızlar.
//
// Neden var: hafıza düğümleri boşlukta yüzerken sahne derinliksiz görünüyor,
// kamera döndüğünde hareket ettiğini anlamak zor. Uzak yıldızlar paralaks
// referansı verir — döndürünce "içinde bir şeyin döndüğü bir uzay" hissi
// oluşur.
//
// Maliyeti pratikte sıfır: tek `Points` (bir draw call), tek seferlik
// hesaplanmış tampon, hiçbir kare-başı iş yok. Veri DEĞİL dekordur; hiçbir
// anıyı temsil etmez, tıklanmaz (raycast kapalı).
import { useMemo } from "react";
import * as THREE from "three";

const STAR_COUNT = 900;
/** Galaksinin dışında bir küre kabuğu — düğümlerle karışmasın. */
const INNER = 60;
const OUTER = 150;

export function Starfield() {
  const geometry = useMemo(() => {
    const positions = new Float32Array(STAR_COUNT * 3);
    const colors = new Float32Array(STAR_COUNT * 3);
    // sabit tohum: yıldızlar her render'da yer değiştirmesin
    let seed = 0x2f6e2b1;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 0xffffffff;
    };
    for (let i = 0; i < STAR_COUNT; i += 1) {
      // küre yüzeyinde düzgün dağılım (kutuplarda yığılmasın)
      const theta = random() * Math.PI * 2;
      const phi = Math.acos(2 * random() - 1);
      const radius = INNER + random() * (OUTER - INNER);
      positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = radius * Math.cos(phi);
      positions[i * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta);
      // hafif mavi-beyaz tonlama; bir kısmı belirgin sönük
      const shade = 0.25 + random() * 0.55;
      colors[i * 3] = shade * 0.8;
      colors[i * 3 + 1] = shade * 0.85;
      colors[i * 3 + 2] = shade;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    return geo;
  }, []);

  return (
    <points geometry={geometry} raycast={() => null} frustumCulled={false}>
      <pointsMaterial size={0.7} sizeAttenuation vertexColors transparent opacity={0.75} />
    </points>
  );
}
