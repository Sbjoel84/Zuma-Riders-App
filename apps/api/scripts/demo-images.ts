/**
 * Draws simple placeholder images (document cards, car photos, selfies) as PNGs with no dependencies,
 * so demo drivers have something to show in the dashboard's verification view. Development only.
 */
import { deflateSync } from "zlib";

type RGB = [number, number, number];

class Canvas {
  readonly px: Buffer;
  constructor(readonly w: number, readonly h: number, bg: RGB) {
    this.px = Buffer.alloc(w * h * 3);
    this.rect(0, 0, w, h, bg);
  }
  rect(x: number, y: number, w: number, h: number, c: RGB) {
    for (let j = Math.max(0, y); j < Math.min(this.h, y + h); j++) {
      for (let i = Math.max(0, x); i < Math.min(this.w, x + w); i++) {
        const o = (j * this.w + i) * 3;
        this.px[o] = c[0];
        this.px[o + 1] = c[1];
        this.px[o + 2] = c[2];
      }
    }
  }
  circle(cx: number, cy: number, r: number, c: RGB) {
    for (let j = cy - r; j <= cy + r; j++) for (let i = cx - r; i <= cx + r; i++) if ((i - cx) ** 2 + (j - cy) ** 2 <= r * r) this.rect(i, j, 1, 1, c);
  }
  png(): Buffer {
    const raw = Buffer.alloc((this.w * 3 + 1) * this.h);
    for (let y = 0; y < this.h; y++) {
      raw[y * (this.w * 3 + 1)] = 0;
      this.px.copy(raw, y * (this.w * 3 + 1) + 1, y * this.w * 3, (y + 1) * this.w * 3);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(this.w, 0);
    ihdr.writeUInt32BE(this.h, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // truecolour
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  }
}

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(b: Buffer) {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

const GREY: RGB = [205, 209, 202];
const DARK: RGB = [70, 76, 70];

/** An ID-card-like document: coloured header band, photo box, lines of "text". */
export function documentImage(band: RGB, seed: number): Buffer {
  const c = new Canvas(480, 300, [246, 244, 236]);
  c.rect(0, 0, 480, 54, band);
  c.rect(20, 18, 180, 16, [255, 255, 255]);
  c.rect(24, 76, 120, 150, [214, 206, 190]);
  c.circle(84, 132, 30, [150, 120, 95]);
  c.rect(44, 168, 80, 58, [150, 120, 95]);
  for (let i = 0; i < 6; i++) c.rect(166, 84 + i * 26, 150 + ((seed * 37 + i * 53) % 130), 10, i % 2 ? GREY : DARK);
  c.rect(24, 250, 432, 12, GREY);
  c.rect(24, 270, 300, 10, GREY);
  return c.png();
}

/** A car seen from the front or back. */
export function carImage(body: RGB, back = false): Buffer {
  const c = new Canvas(480, 320, [196, 222, 240]);
  c.rect(0, 210, 480, 110, [120, 124, 120]);
  c.rect(80, 120, 320, 110, body);
  c.rect(130, 70, 220, 60, body);
  c.rect(146, 80, 188, 44, [150, 180, 200]);
  c.rect(96, 150, 56, 22, back ? [200, 40, 40] : [250, 245, 200]);
  c.rect(328, 150, 56, 22, back ? [200, 40, 40] : [250, 245, 200]);
  c.rect(190, 188, 100, 28, [255, 255, 255]); // number plate
  c.rect(198, 196, 84, 12, [30, 110, 60]);
  c.rect(92, 226, 60, 30, [30, 30, 30]);
  c.rect(328, 226, 60, 30, [30, 30, 30]);
  return c.png();
}

export function selfieImage(skin: RGB, shirt: RGB): Buffer {
  const c = new Canvas(360, 440, [230, 232, 226]);
  c.rect(60, 300, 240, 140, shirt);
  c.circle(180, 300, 70, shirt);
  c.rect(150, 230, 60, 60, skin);
  c.circle(180, 180, 78, skin);
  c.circle(180, 130, 70, [40, 30, 25]);
  c.rect(110, 150, 140, 40, skin);
  c.circle(152, 186, 7, [40, 30, 25]);
  c.circle(208, 186, 7, [40, 30, 25]);
  c.rect(160, 220, 40, 6, [150, 80, 70]);
  return c.png();
}
