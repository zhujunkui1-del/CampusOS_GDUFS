import { describe, expect, it } from "vitest";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { normalizeImage } from "@/lib/server/ingestion/image-normalize";

function png(width: number, height: number): Uint8Array {
  const image = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    image.data[i * 4] = 240;
    image.data[i * 4 + 1] = 240;
    image.data[i * 4 + 2] = 240;
    image.data[i * 4 + 3] = 255;
  }
  return new Uint8Array(PNG.sync.write(image));
}

describe("image normalization", () => {
  it("keeps a small image untouched", () => {
    const small = png(200, 200);
    const result = normalizeImage(small);
    expect(result.resized).toBe(false);
    expect(result.type).toBe("image/png");
    expect(result.bytes).toBe(small);
  });

  it("downscales a poster that would exceed the vision budget", () => {
    const large = png(1600, 2200);
    const result = normalizeImage(large);
    expect(result.resized).toBe(true);
    expect(result.type).toBe("image/jpeg");
    expect(result.bytes.length).toBeLessThan(600_000);

    const decoded = jpeg.decode(Buffer.from(result.bytes), { useTArray: true });
    expect(decoded.width).toBeLessThanOrEqual(1280);
    expect(decoded.height).toBeLessThanOrEqual(1280);
  });
});
