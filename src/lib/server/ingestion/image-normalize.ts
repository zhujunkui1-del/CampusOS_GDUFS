import jpeg from "jpeg-js";
import { PNG } from "pngjs";

const MAX_EDGE = 1280;
const MAX_PIXELS = 1_800_000;

type Bitmap = { data: Uint8Array; width: number; height: number };

function mimeOf(bytes: Uint8Array) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  return "application/octet-stream";
}

function dimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (mimeOf(bytes) === "image/png" && bytes.length >= 24) {
    return { width: (bytes[16] << 24 | bytes[17] << 16 | bytes[18] << 8 | bytes[19]) >>> 0,
      height: (bytes[20] << 24 | bytes[21] << 16 | bytes[22] << 8 | bytes[23]) >>> 0 };
  }
  if (mimeOf(bytes) === "image/jpeg") {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset++; continue; }
      const marker = bytes[offset + 1];
      const length = bytes[offset + 2] << 8 | bytes[offset + 3];
      if (marker >= 0xc0 && marker <= 0xc2) {
        return { height: bytes[offset + 5] << 8 | bytes[offset + 6],
          width: bytes[offset + 7] << 8 | bytes[offset + 8] };
      }
      offset += 2 + length;
    }
  }
  return null;
}

function decode(bytes: Uint8Array): Bitmap | null {
  try {
    const png = PNG.sync.read(Buffer.from(bytes));
    const rgba = new Uint8Array(png.width * png.height * 4);
    for (let i = 0; i < rgba.length; i += 4) {
      const alpha = png.data[i + 3] / 255;
      rgba[i] = Math.round(png.data[i] * alpha + 255 * (1 - alpha));
      rgba[i + 1] = Math.round(png.data[i + 1] * alpha + 255 * (1 - alpha));
      rgba[i + 2] = Math.round(png.data[i + 2] * alpha + 255 * (1 - alpha));
      rgba[i + 3] = 255;
    }
    return { data: rgba, width: png.width, height: png.height };
  } catch {
    // not a PNG
  }
  try {
    const jpg = jpeg.decode(Buffer.from(bytes), { useTArray: true });
    const rgba = new Uint8Array(jpg.width * jpg.height * 4);
    rgba.set(jpg.data);
    return { data: rgba, width: jpg.width, height: jpg.height };
  } catch {
    return null;
  }
}

function resize(source: Bitmap, width: number, height: number): Bitmap {
  const out = new Uint8Array(width * height * 4);
  const xScale = (source.width - 1) / Math.max(1, width - 1);
  const yScale = (source.height - 1) / Math.max(1, height - 1);
  for (let y = 0; y < height; y++) {
    const sy = y * yScale;
    const y0 = Math.floor(sy);
    const y1 = Math.min(source.height - 1, y0 + 1);
    const wy = sy - y0;
    for (let x = 0; x < width; x++) {
      const sx = x * xScale;
      const x0 = Math.floor(sx);
      const x1 = Math.min(source.width - 1, x0 + 1);
      const wx = sx - x0;
      const o = (y * width + x) * 4;
      for (let c = 0; c < 4; c++) {
        const top = source.data[(y0 * source.width + x0) * 4 + c] * (1 - wx)
          + source.data[(y0 * source.width + x1) * 4 + c] * wx;
        const bottom = source.data[(y1 * source.width + x0) * 4 + c] * (1 - wx)
          + source.data[(y1 * source.width + x1) * 4 + c] * wx;
        out[o + c] = Math.round(top * (1 - wy) + bottom * wy);
      }
      out[o + 3] = 255;
    }
  }
  return { data: out, width, height };
}

/**
 * Posters from university sites are often 2000px+ PNGs, which makes the
 * vision model time out inside the Worker request budget. Downscale to a
 * readable JPEG before sending; text on an A4 poster stays legible at 1280px.
 */
export function normalizeImage(bytes: Uint8Array): { bytes: Uint8Array; type: string; resized: boolean } {
  const type = mimeOf(bytes);
  const size = dimensions(bytes);
  if (!size) return { bytes, type, resized: false };
  const scale = Math.min(1, MAX_EDGE / Math.max(size.width, size.height),
    Math.sqrt(MAX_PIXELS / (size.width * size.height)));
  if (scale >= 0.98) return { bytes, type, resized: false };
  const bitmap = decode(bytes);
  if (!bitmap) return { bytes, type, resized: false };
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const small = resize(bitmap, width, height);
  const encoded = jpeg.encode({ data: Buffer.from(small.data), width, height }, 82);
  return { bytes: new Uint8Array(encoded.data), type: "image/jpeg", resized: true };
}
