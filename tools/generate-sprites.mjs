// Generates Stardew-inspired pixel PNGs into public/assets/.
// No dependencies — pure Node + zlib, so `npm run sprites` works in nix develop.
// Art direction: chunky pixels, design at low res, scale up in-game with NEAREST.

import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "public", "assets");
mkdirSync(outDir, { recursive: true });

// --- minimal PNG encoder (RGBA8) ---------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, Buffer.from(data)])), 0);
  return Buffer.concat([len, typeBuf, Buffer.from(data), crc]);
}

function encodePng(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter 0
    Buffer.from(rgba.slice(y * w * 4, (y + 1) * w * 4)).copy(raw, y * (w * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return png;
}

// --- tiny raster canvas -------------------------------------------------

function hex(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
}

function makeCanvas(w, h) {
  return {
    w,
    h,
    data: new Uint8ClampedArray(w * h * 4), // transparent by default (alpha 0)
    px(x, y, c) {
      if (x < 0 || y < 0 || x >= w || y >= h) return;
      const i = (y * w + x) * 4;
      const [r, g, b, a] = c;
      this.data[i] = r;
      this.data[i + 1] = g;
      this.data[i + 2] = b;
      this.data[i + 3] = a;
    },
    rect(x, y, rw, rh, c) {
      for (let j = 0; j < rh; j++) for (let i = 0; i < rw; i++) this.px(x + i, y + j, c);
    },
    // filled ellipse
    ellipse(cx, cy, rx, ry, c) {
      for (let y = -ry; y <= ry; y++)
        for (let x = -rx; x <= rx; x++) {
          if ((x * x) / (rx * rx) + (y * y) / (ry * ry) <= 1) this.px(cx + x, cy + y, c);
        }
    },
  };
}

function save(name, cv) {
  writeFileSync(join(outDir, name), encodePng(cv.w, cv.h, cv.data));
  console.log(`wrote assets/${name} (${cv.w}x${cv.h})`);
}

// --- horses -------------------------------------------------------------
// Side view facing right. 64x48. Frame variants for walk + graze.
// Trev: warm chestnut, short cropped dark mane, short dark tail, dark halter, no white.

function drawHorse(coat, mane, dark, halter, opts = {}) {
  const { legPhase = 0, headDown = false, drinkTilt = false } = opts;
  const W = 64;
  const H = 48;
  const cv = makeCanvas(W, H);
  const C = hex(coat);
  const CD = shade(coat, 0.82);
  const M = hex(mane);
  const D = hex(dark);
  const HL = hex(halter);

  // tail: short dark, attached to the rear (overlaps body edge at x=16)
  cv.rect(13, 20, 4, 9, M);
  cv.rect(12, 28, 5, 3, M);

  // legs: 4 slender long legs, walk phase offsets far/near pairs
  const legXs = [21, 26, 37, 42];
  const offsets = [
    Math.round(Math.sin(legPhase) * 2),
    Math.round(Math.sin(legPhase + Math.PI) * 2),
  ];
  legXs.forEach((lx, i) => {
    const off = offsets[i % 2];
    const top = 30;
    const len = 12;
    cv.rect(lx + off, top, 3, len, i < 2 ? CD : C);
    // hoof
    cv.rect(lx + off, top + len, 3, 2, D);
  });

  // body: slender athletic barrel
  cv.ellipse(31, 25, 15, 7, C);
  cv.rect(18, 22, 26, 7, C);
  cv.rect(20, 28, 22, 2, CD); // belly shade

  const neckBaseY = headDown ? 26 : 18;
  const headY = headDown ? 30 : 10;

  // neck diagonal
  for (let i = 0; i < 10; i++) {
    const t = i / 9;
    const nx = Math.round(38 + t * 8);
    const ny = Math.round(neckBaseY + (headY + 4 - neckBaseY) * t - 2);
    cv.rect(nx - 2, ny, 5, 4, C);
  }
  // mane ridge: short cropped strip along neck
  for (let i = 0; i < 9; i++) {
    const t = i / 8;
    const nx = Math.round(37 + t * 7);
    const ny = Math.round(neckBaseY + (headY + 3 - neckBaseY) * t - 4);
    cv.rect(nx - 2, ny, 3, 2, M);
  }

  // head
  const hx = 48;
  const hy = headY;
  cv.rect(hx - 2, hy, 12, 6, C);
  cv.rect(hx + 6, hy + 1 + (drinkTilt ? 1 : 0), 5, 4, CD); // muzzle
  cv.px(hx + 9, hy + 3, D); // nostril
  cv.px(hx + 2, hy + 2, [20, 12, 8, 255]); // eye
  // ear
  cv.rect(hx - 1, hy - 3, 2, 3, C);
  // halter: dark strap around muzzle + poll
  cv.rect(hx + 5, hy + 1, 1, 4, HL);
  cv.rect(hx - 1, hy + 1, 8, 1, HL);
  cv.px(hx + 5, hy + 3, [200, 200, 200, 255]); // buckle glint

  return cv;
}

function shade(h, f) {
  const [r, g, b, a] = hex(h);
  return [Math.round(r * f), Math.round(g * f), Math.round(b * f), a];
}

const HERD = [
  { file: "trev", coat: "#8E4F2C", mane: "#2F2015", dark: "#241A12", halter: "#1E1E1E" },
  { file: "bramble", coat: "#3B2E26", mane: "#14100C", dark: "#100C09", halter: "#2A1F16" },
  { file: "willow", coat: "#A8A094", mane: "#5A534C", dark: "#2B2724", halter: "#3A2E24" },
];

for (const h of HERD) {
  save(`${h.file}_walk0.png`, drawHorse(h.coat, h.mane, h.dark, h.halter, { legPhase: 0 }));
  save(`${h.file}_walk1.png`, drawHorse(h.coat, h.mane, h.dark, h.halter, { legPhase: Math.PI }));
  save(`${h.file}_idle.png`, drawHorse(h.coat, h.mane, h.dark, h.halter, { legPhase: 0.4 }));
  save(`${h.file}_graze.png`, drawHorse(h.coat, h.mane, h.dark, h.halter, { headDown: true }));
  save(
    `${h.file}_drink.png`,
    drawHorse(h.coat, h.mane, h.dark, h.halter, { headDown: true, drinkTilt: true }),
  );
}

// --- grass tiles (16x16, Stardew-ish) ------------------------------------

function grass(base, speck1, speck2, seed) {
  const cv = makeCanvas(16, 16);
  const B = hex(base);
  const S1 = hex(speck1);
  const S2 = hex(speck2);
  cv.rect(0, 0, 16, 16, B);
  let s = seed;
  const rnd = () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
  for (let i = 0; i < 26; i++) {
    const x = Math.floor(rnd() * 16);
    const y = Math.floor(rnd() * 16);
    cv.px(x, y, rnd() > 0.5 ? S1 : S2);
    if (rnd() > 0.7) cv.px(x, y + 1, S1);
  }
  // tiny clover tufts
  cv.rect(3, 5, 1, 2, S1);
  cv.rect(11, 10, 1, 2, S1);
  return cv;
}

save("grass_0.png", grass("#6FAE4E", "#5C9440", "#86C05E", 1234));
save("grass_1.png", grass("#6AA847", "#578A3B", "#7FB855", 987));
save("grass_dry.png", grass("#8BAE4E", "#75963E", "#A4C464", 555));

// --- fence: metal pole + rails drawn in-game, post sprite here -----------

{
  const cv = makeCanvas(16, 40);
  const P = hex("#9AA0A6");
  const PD = hex("#6E747A");
  const HL = hex("#CFD6DC");
  cv.rect(5, 2, 6, 36, P);
  cv.rect(5, 2, 2, 36, HL); // highlight
  cv.rect(9, 2, 2, 36, PD); // shade
  cv.rect(4, 0, 8, 3, PD); // cap
  cv.rect(4, 37, 8, 3, PD); // foot
  // 3 insulator dots where electric rows attach
  const INS = hex("#D32F2F");
  cv.rect(10, 8, 3, 3, INS);
  cv.rect(10, 18, 3, 3, INS);
  cv.rect(10, 28, 3, 3, INS);
  save("fence_post.png", cv);
}

// --- stations ------------------------------------------------------------

{
  // green hanging water bowl (side view over fence)
  const cv = makeCanvas(32, 24);
  const BOWL = hex("#2E7D32");
  const BOWLD = hex("#1B5E20");
  const WATER = hex("#B2E5F2");
  // hook over fence
  cv.rect(14, 0, 4, 6, hex("#616161"));
  // bowl
  cv.ellipse(16, 14, 13, 7, BOWL);
  cv.ellipse(16, 12, 11, 5, BOWLD);
  cv.ellipse(16, 12, 9, 3, WATER);
  cv.rect(5, 14, 2, 2, hex("#E0F7FA")); // glint
  save("water_bowl.png", cv);
}

{
  // black plastic hard-feed tub
  const cv = makeCanvas(32, 20);
  const TUB = hex("#212121");
  const RIM = hex("#424242");
  const FEED = hex("#8D6E63");
  const FEEDD = hex("#6D4C41");
  cv.ellipse(16, 12, 14, 7, TUB);
  cv.ellipse(16, 10, 12, 5, RIM);
  cv.ellipse(16, 10, 10, 4, FEED);
  // feed lumps
  cv.rect(10, 8, 2, 2, FEEDD);
  cv.rect(16, 9, 2, 2, FEEDD);
  cv.rect(21, 8, 2, 2, FEEDD);
  save("feed_tub.png", cv);
}

{
  // round bale in big metal ring feeder (top-down-ish 64x48)
  const cv = makeCanvas(64, 48);
  const HAY = hex("#D7A84E");
  const HAYD = hex("#B5893B");
  const HAYL = hex("#E8C46A");
  const METAL = hex("#B0BEC5");
  const METALD = hex("#78909C");
  cv.ellipse(32, 24, 26, 18, METALD);
  cv.ellipse(32, 23, 26, 18, METAL);
  cv.ellipse(32, 23, 21, 14, HAYD);
  cv.ellipse(32, 22, 21, 14, HAY);
  // spiral + strands
  cv.ellipse(32, 22, 12, 8, HAYD);
  cv.ellipse(32, 22, 7, 4, HAY);
  for (let i = 0; i < 20; i++) {
    const a = (i / 20) * Math.PI * 2;
    cv.px(
      Math.round(32 + Math.cos(a) * (14 + (i % 3))),
      Math.round(22 + Math.sin(a) * (9 + (i % 2))),
      HAYL,
    );
  }
  // feeder bars
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const x = Math.round(32 + Math.cos(a) * 24);
    const y = Math.round(23 + Math.sin(a) * 16);
    cv.rect(x - 1, y - 4, 3, 8, METALD);
  }
  save("bale_feeder.png", cv);
}

{
  // hay flake (dropped feed)
  const cv = makeCanvas(24, 16);
  const HAY = hex("#D7A84E");
  const HAYD = hex("#A67C2E");
  cv.rect(2, 6, 20, 7, HAY);
  cv.rect(2, 11, 20, 2, HAYD);
  for (let i = 0; i < 8; i++) cv.px(4 + i * 2, 5, HAYD);
  save("hay_flake.png", cv);
}

console.log("done.");
