// Galaksi yerleşimi (ADR-021) — SAF fonksiyonlar, hiçbir three bağımlılığı yok.
//
// Kural: bir düğümün yeri KİMLİĞİNDEN türetilir, rastgele değil. Her yenilemede
// aynı anı aynı yerde durur; yeni bir anı eklendiğinde diğerleri zıplamaz.
// (Kuvvet tabanlı yerleşim her hesapta farklı sonuç verirdi ve galaksi her
// yenilemede yeniden karılırdı.)
//
// Üç kabuk — 12 §2'nin kapsam hiyerarşisinin görsel karşılığı:
//   company → merkez çekirdek (yoğun, parlak)
//   project → çekirdeğin etrafında kollar
//   agent   → dış yörünge yıldızları
export type MemoryScope = "company" | "project" | "agent";

export interface GalaxyNodeInput {
  id: string;
  title: string;
  type: string;
  scope: string;
  /** Kapsamın sahibi: proje id'si / ajan id'si / null (company). */
  scopeRef: string | null;
  /** Proje ya da ajan adı — tooltip ve kol göstergesi için. */
  scopeLabel: string | null;
  importance: number;
  confidence: number;
  status: string;
}

export interface GalaxyNode extends GalaxyNodeInput {
  /** Sahne koordinatı (deterministik). */
  position: [number, number, number];
  /** Dalga fazı — aynı anda hepsi birlikte inip çıkmasın diye kimlikten. */
  phase: number;
  /** 0.35–1.0: importance'tan türetilen yarıçap. */
  radius: number;
}

/** FNV-1a: kısa, hızlı, çakışması bu ölçekte önemsiz; sürüm boyu sabit. */
export function hashId(id: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Hash'ten [0,1) aralığında kararlı bir sayı (n = alan ayırıcı). */
function unit(hash: number, n: number): number {
  const mixed = Math.imul(hash ^ (n * 0x9e3779b9), 0x85ebca6b) >>> 0;
  return (mixed % 100000) / 100000;
}

const SHELL: Record<MemoryScope, { inner: number; outer: number; thickness: number }> = {
  // çekirdek: küçük yarıçap, hafif kalınlık → yoğun görünür
  company: { inner: 0, outer: 3.2, thickness: 1.6 },
  // kollar: orta bant
  project: { inner: 5.5, outer: 11, thickness: 1.1 },
  // dış yörünge: geniş ve ince → "yıldız tozu"
  agent: { inner: 13, outer: 20, thickness: 0.8 },
};

/**
 * Kol sayısı — sarmal his için sabit.
 *
 * Kol seçimi düğümün KAPSAM SAHİBİNDEN türetilir (proje id'si / ajan id'si):
 * aynı projenin bütün anıları aynı kolda toplanır, farklı projeler ayrı
 * kollara düşer. İlk sürümde graph yanıtı `scopeRef` taşımadığı için kol
 * düğüm kimliğinden geliyordu ve iki farklı projenin anıları karışıyordu;
 * alan sunucuya eklendi (ADR-021 kısıtı kapandı).
 */
export const ARMS = 4;

/**
 * Sarmal bükülmesi (radyan / birim yarıçap).
 *
 * Dekoratif toz bulutu (GalaxyDust) BU sabiti paylaşmak zorunda: kollar aynı
 * denklemden çizilmezse anılar tozun içinde değil, üstünde yüzer ve sahne
 * "galaksi" değil "toz + toplar" gibi görünür.
 */
export const ARM_TWIST = 0.18;

export function scopeOf(raw: string): MemoryScope {
  return raw === "company" || raw === "project" || raw === "agent" ? raw : "agent";
}

/**
 * Bir düğümün galaksi içindeki yeri. Sarmal kollar: açı = kol tabanı + yarıçapla
 * artan bir bükülme, böylece dıştaki düğümler geriye doğru süpürülmüş görünür.
 */
export function placeNode(node: GalaxyNodeInput): GalaxyNode {
  const hash = hashId(node.id);
  const scope = scopeOf(node.scope);
  const shell = SHELL[scope];

  // kol = kapsam sahibi (proje/ajan); sahipsizse düğümün kendisi
  const arm = hashId(node.scopeRef ?? node.id) % ARMS;
  const radial = unit(hash, 1);
  const radius = shell.inner + radial * (shell.outer - shell.inner);
  // kol tabanı + sarmal bükülme + kol içi dağılım
  const spread = (unit(hash, 2) - 0.5) * 0.5;
  const angle = (arm / ARMS) * Math.PI * 2 + radius * ARM_TWIST + spread;
  // çekirdekte kol yok: küre gibi dağılsın
  const finalAngle = scope === "company" ? unit(hash, 3) * Math.PI * 2 : angle;
  const height = (unit(hash, 4) - 0.5) * shell.thickness;

  return {
    ...node,
    position: [
      Math.cos(finalAngle) * radius,
      height,
      Math.sin(finalAngle) * radius,
    ],
    phase: unit(hash, 5) * Math.PI * 2,
    // Önem büyüklüğe gider; taban yarıçap küçük anıların da görünmesini
    // sağlar. Şirket kapsamı biraz daha iri: çekirdek uzaktan da okunsun.
    radius: (scope === "company" ? 0.3 : 0.22) + 0.42 * clamp01(node.importance),
  };
}

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Kapsam renkleri — acosDark paletiyle uyumlu (mavi çekirdek → mor kol → camgöbeği toz). */
export const SCOPE_COLOR: Record<MemoryScope, string> = {
  company: "#4c9aff",
  project: "#a879ff",
  agent: "#3fd0a0",
};

/** İlişki türü → çizgi rengi (mevcut 2D grafiğin paletiyle aynı). */
export const EDGE_COLOR: Record<string, string> = {
  contradicts: "#ff4d4d",
  derived_from: "#a879ff",
  supports: "#3fd0a0",
  supersedes: "#5c6773",
  related_to: "#3a424c",
};
