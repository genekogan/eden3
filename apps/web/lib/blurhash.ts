/**
 * Minimal blurhash decoder (https://blurha.sh reference algorithm), inlined
 * so the web app takes no extra dependency. Legacy creations may carry a
 * `blurhash` in `mediaAttributes`; components/media.tsx paints it on a tiny
 * canvas behind the real asset while it loads.
 *
 * Returns null (never throws) on malformed input — the placeholder is purely
 * cosmetic and must not take a surface down.
 */

const BASE83 =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~";

function decode83(text: string, from: number, to: number): number | null {
  let value = 0;
  for (let i = from; i < to; i += 1) {
    const digit = BASE83.indexOf(text[i] ?? "");
    if (digit < 0) return null;
    value = value * 83 + digit;
  }
  return value;
}

function srgbToLinear(value: number): number {
  const v = value / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(value: number): number {
  const v = Math.max(0, Math.min(1, value));
  const srgb = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.round(srgb * 255);
}

function signPow(value: number, exp: number): number {
  return Math.sign(value) * Math.abs(value) ** exp;
}

type Rgb = [number, number, number];

/**
 * Decode a blurhash into `width * height` RGBA pixels (Uint8ClampedArray of
 * length `width * height * 4`), or null if the hash is malformed. Keep the
 * target tiny (e.g. 32×32) — it is meant to be scaled up blurry.
 */
export function decodeBlurhash(
  hash: string | null | undefined,
  width = 32,
  height = 32,
  punch = 1,
): Uint8ClampedArray | null {
  if (!hash || hash.length < 6 || width <= 0 || height <= 0) return null;

  const sizeFlag = decode83(hash, 0, 1);
  if (sizeFlag === null) return null;
  const numY = Math.floor(sizeFlag / 9) + 1;
  const numX = (sizeFlag % 9) + 1;
  if (hash.length !== 4 + 2 * numX * numY) return null;

  const quantMax = decode83(hash, 1, 2);
  const dcValue = decode83(hash, 2, 6);
  if (quantMax === null || dcValue === null) return null;
  const maxValue = ((quantMax + 1) / 166) * punch;

  const colors: Rgb[] = [
    [
      srgbToLinear(dcValue >> 16),
      srgbToLinear((dcValue >> 8) & 255),
      srgbToLinear(dcValue & 255),
    ],
  ];
  for (let i = 1; i < numX * numY; i += 1) {
    const value = decode83(hash, 4 + i * 2, 6 + i * 2);
    if (value === null) return null;
    colors.push([
      signPow((Math.floor(value / (19 * 19)) - 9) / 9, 2) * maxValue,
      signPow(((Math.floor(value / 19) % 19) - 9) / 9, 2) * maxValue,
      signPow(((value % 19) - 9) / 9, 2) * maxValue,
    ]);
  }

  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let j = 0; j < numY; j += 1) {
        const cosY = Math.cos((Math.PI * y * j) / height);
        for (let i = 0; i < numX; i += 1) {
          const basis = Math.cos((Math.PI * x * i) / width) * cosY;
          const color = colors[i + j * numX];
          if (!color) continue;
          r += color[0] * basis;
          g += color[1] * basis;
          b += color[2] * basis;
        }
      }
      const offset = 4 * (x + y * width);
      pixels[offset] = linearToSrgb(r);
      pixels[offset + 1] = linearToSrgb(g);
      pixels[offset + 2] = linearToSrgb(b);
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}
