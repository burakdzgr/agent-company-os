// Pixel-art döşeme kütüphanesi (36 §3 "hand-authored pixel tiles"; 23 §5).
//
// Neden ASCII: ofis eskiden `Graphics.rect` çağrılarıyla çiziliyordu ve sonuç
// piksel sanatı DEĞİL, düz dikdörtgenlerdi — ne kenar ışığı, ne gölge, ne
// doku. Piksel sanatının tanımı, her pikselin bilerek konmuş olması; kod
// içinde bunu okunur tutmanın yolu da resmi harf haritası olarak yazmak.
// Her harf bir palet girdisi, her satır bir piksel sırası.
//
// Burada Pixi YOK — ofis lint kuralı render API'lerini köprüye (OfficeCanvas)
// ayırıyor. Bu dosya saf veridir: harf haritaları + paletler + üreteçler.
// Köprü bunları bir kez dokuya pişirir (nearest-neighbor ölçekleme) ve
// sprite olarak yerleştirir; kare başına iş yoktur.

/** Bir çizim: satırlar + harf→renk paleti. Nokta = saydam. */
export interface PixelArt {
  rows: string[];
  palette: Record<string, number>;
}

// ---------------------------------------------------------------- masa

/**
 * Masa: monitör + klavye + sandalye, tepeden görünüm.
 * 32×24 piksel → 2 ekran pikseli/sanat pikseli ile 2 hücre genişlik.
 */
export const DESK_ART: PixelArt = {
  palette: {
    D: 0x6b5138, // masa ahşabı
    d: 0x46331f, // ön kenar gölgesi
    L: 0x8a6a48, // arka kenar ışığı
    // Monitör çerçevesi bilerek AÇIK: ilk denemede 0x1b2029 idi ve oda
    // zemini de koyu olduğu için ekranda hiç görünmüyordu — masada yalnız
    // ahşap bar duruyor, monitör yok sanılıyordu.
    B: 0x39424f, // monitör çerçevesi
    S: 0x11161d, // ekran (canlı durum rengi bunun üstüne biner)
    s: 0x2e7d9a, // ekran parıltısı
    K: 0x2b3440, // klavye gövdesi
    k: 0x3d4753, // tuşlar
    C: 0x39424f, // sandalye
    c: 0x252c36, // sandalye gölgesi
  },
  rows: [
    "................................",
    "................................",
    ".........LLLLLLLLLLLLLL.........",
    ".........BSSSSSSSSSSSSB.........",
    ".........BSssssssssssSB.........",
    ".........BSSSSSSSSSSSSB.........",
    ".........BSssssssssssSB.........",
    ".........BBBBBBBBBBBBBB.........",
    ".............BdddddB............",
    ".............BdddddB............",
    "..LLLLLLLLLLLLLLLLLLLLLLLLLLLL..",
    "..DDDDDDDDDDDDDDDDDDDDDDDDDDDD..",
    "..DDDDDDDDDDDDDDDDDDDDDDDDDDDD..",
    "..DDDDDDDDKKKKKKKKKKKKDDDDDDDD..",
    "..DDDDDDDDKkkkkkkkkkkKDDDDDDDD..",
    "..DDDDDDDDKKKKKKKKKKKKDDDDDDDD..",
    "..DDDDDDDDDDDDDDDDDDDDDDDDDDDD..",
    "..dddddddddddddddddddddddddddd..",
    "................................",
    "...........CCCCCCCCCC...........",
    "..........CCCCCCCCCCCC..........",
    "..........CccccccccccC..........",
    "..........CCCCCCCCCCCC..........",
    "...........cccccccccc...........",
  ],
};

// ---------------------------------------------------------------- saksı

export const PLANT_ART: PixelArt = {
  palette: {
    G: 0x2f7d4a,
    g: 0x46a862,
    h: 0x1f5c34,
    P: 0x6b4a2e,
    p: 0x46321e,
  },
  rows: [
    "................",
    ".....gg..gg.....",
    "....gGGggGGg....",
    "...gGGGGGGGGg...",
    "..gGGGhhhhGGGg..",
    "..GGGhGGGGhGGG..",
    "..GGGGGGGGGGGG..",
    "...GGGhhhhGGG...",
    "....GGGGGGGG....",
    ".....GGGGGG.....",
    "......GGGG......",
    "......hGGh......",
    ".....PPPPPP.....",
    ".....PPPPPP.....",
    "......pppp......",
    "................",
  ],
};

// ---------------------------------------------------------------- sunucu dolabı

export const RACK_ART: PixelArt = {
  palette: {
    M: 0x232a34, // gövde
    m: 0x161b22, // gölge
    E: 0x39424f, // raf
    a: 0x3fd0a0, // yeşil LED
    b: 0xffcb47, // sarı LED
  },
  rows: [
    "mmmmmmmmmmmmmmmm",
    "mMMMMMMMMMMMMMMm",
    "mMEEEEEEEEEEabMm",
    "mMMMMMMMMMMMMMMm",
    "mMEEEEEEEEEEbaMm",
    "mMMMMMMMMMMMMMMm",
    "mMEEEEEEEEEEabMm",
    "mMMMMMMMMMMMMMMm",
    "mMEEEEEEEEEEaaMm",
    "mMMMMMMMMMMMMMMm",
    "mMEEEEEEEEEEbbMm",
    "mMMMMMMMMMMMMMMm",
    "mMEEEEEEEEEEabMm",
    "mMMMMMMMMMMMMMMm",
    "mMMMMMMMMMMMMMMm",
    "mmmmmmmmmmmmmmmm",
  ],
};

// ---------------------------------------------------------------- kahve makinesi

export const COFFEE_ART: PixelArt = {
  palette: {
    M: 0x2b323c,
    m: 0x1a1f26,
    W: 0x3a2c22, // hazne
    o: 0xff6b8a, // güç ışığı
    S: 0x4a5462,
  },
  rows: [
    "................",
    "...mmmmmmmmmm...",
    "...mMMMMMMMMm...",
    "...mMWWWWWWMm...",
    "...mMWWWWWWMm...",
    "...mMMMMMMMMm...",
    "...mMSSSSSSMm...",
    "...mMMMMMMoMm...",
    "...mMMMMMMMMm...",
    "...mMSSSSSSMm...",
    "...mMMMMMMMMm...",
    "...mmmmmmmmmm...",
    "................",
    "................",
    "................",
    "................",
  ],
};

// ------------------------------------------------- üreteçler (döşeme desenleri)

/** Deterministik 0..1 — döşeme dokusu her yenilemede aynı olmalı. */
function noise(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2246822519) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return (h >>> 8) / 0xffffff;
}

/**
 * Zemin karosu: taban + derz çizgileri + serpinti.
 *
 * Serpinti şart: tek renk zemin ölçeklendiğinde "boş tuval" gibi görünüyor,
 * pikseller okunmuyordu. Az sayıda koyu/açık piksel yüzeye doku veriyor ve
 * kamera yakınlaşınca karo yapısı ortaya çıkıyor.
 */
export function floorTileArt(base: number, seed: number): PixelArt {
  const rows: string[] = [];
  for (let y = 0; y < 16; y += 1) {
    let row = "";
    for (let x = 0; x < 16; x += 1) {
      const grout = x === 0 || y === 0; // 8×8'lik karo derzleri
      const n = noise(x, y, seed);
      row += grout ? "g" : n > 0.94 ? "l" : n < 0.06 ? "d" : "b";
    }
    rows.push(row);
  }
  return {
    rows,
    palette: {
      b: base,
      l: shiftColor(base, 10),
      d: shiftColor(base, -10),
      g: shiftColor(base, -18),
    },
  };
}

/** Duvar yüzü: panel dokusu + üstte kalın ışık şeridi (sözde-3B). */
export function wallFaceArt(): PixelArt {
  const rows: string[] = [];
  for (let y = 0; y < 16; y += 1) {
    let row = "";
    for (let x = 0; x < 16; x += 1) {
      if (y < 3) row += "t"; // üst kapak (ışık alan yüz)
      else if (y === 3) row += "e"; // kapak altı keskin gölge
      else if (x % 8 === 0) row += "s"; // panel derzi
      else row += noise(x, y, 7) > 0.92 ? "h" : "f";
    }
    rows.push(row);
  }
  return {
    rows,
    palette: {
      t: 0x46556a,
      e: 0x1c232d,
      f: 0x2a3340,
      s: 0x222a35,
      h: 0x35404f,
    },
  };
}

/** Koridor/lobi zemini — odalardan koyu, ince tahta dokulu. */
export function corridorTileArt(): PixelArt {
  const rows: string[] = [];
  for (let y = 0; y < 16; y += 1) {
    let row = "";
    for (let x = 0; x < 16; x += 1) {
      if (y % 4 === 0) row += "s";
      else row += noise(x, y, 3) > 0.9 ? "l" : "b";
    }
    rows.push(row);
  }
  return {
    rows,
    palette: { b: 0x12161d, l: 0x171d26, s: 0x0e1218 },
  };
}

/** #rrggbb tamsayısını kanal başına kaydırır (döşeme tonlaması). */
export function shiftColor(color: number, delta: number): number {
  const clamp = (v: number) => Math.max(0, Math.min(255, v));
  const r = clamp(((color >> 16) & 255) + delta);
  const g = clamp(((color >> 8) & 255) + delta);
  const b = clamp((color & 255) + delta);
  return (r << 16) | (g << 8) | b;
}

/**
 * Bir çizimi dikdörtgen çağrılarına açar.
 *
 * Aynı renkteki YATAY komşu pikselleri tek dikdörtgende birleştirir: masa
 * çizimi 768 piksel, birleştirilince ~90 dikdörtgen. Bu olmadan 40 masalık
 * bir ofis on binlerce çağrı ederdi — dokuya pişirilse bile pişirme anı
 * gözle görülür şekilde takılırdı.
 */
export function emitArt(
  art: PixelArt,
  pixel: number,
  draw: (x: number, y: number, w: number, h: number, color: number) => void,
): void {
  art.rows.forEach((row, y) => {
    let runStart = -1;
    let runChar = ".";
    const flush = (end: number) => {
      if (runStart < 0 || runChar === ".") return;
      const color = art.palette[runChar];
      if (color !== undefined) {
        draw(runStart * pixel, y * pixel, (end - runStart) * pixel, pixel, color);
      }
    };
    for (let x = 0; x < row.length; x += 1) {
      const char = row[x]!;
      if (char !== runChar) {
        flush(x);
        runStart = x;
        runChar = char;
      }
    }
    flush(row.length);
  });
}

/** Çizimin ekran boyutu (piksel katsayısı uygulanmış). */
export function artSize(art: PixelArt, pixel: number): { w: number; h: number } {
  return { w: (art.rows[0]?.length ?? 0) * pixel, h: art.rows.length * pixel };
}
