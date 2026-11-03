import pixelmatch from "pixelmatch";
import sharp from "sharp";

/** pixelmatch's own default: how far a colour may drift before the pixel counts as changed. Anti-aliased edges never count. */
const PIXELMATCH_THRESHOLD = 0.1;

/** An image's size in pixels, or null when it is not a picture sharp can read. */
export async function pictureSize(bytes: Uint8Array): Promise<{ width: number; height: number } | null> {
  try {
    const { width, height } = await sharp(bytes).metadata();
    return width && height ? { width, height } : null;
  } catch {
    return null;
  }
}

type Size = { width: number; height: number };

/**
 * Compares a prototype picture with a screenshot the way Playwright's own screenshot check does, with pixelmatch, and
 * draws the changed pixels in red over a faded copy. A prototype at another scale is brought to the screenshot's width
 * first, and the shorter picture is padded with white. Null when either picture cannot be read.
 */
export async function screenDifference(prototype: Uint8Array, shot: Uint8Array): Promise<{ percent: number; diff: Uint8Array<ArrayBuffer>; prototypeSize: Size; shotSize: Size } | null> {
  try {
    const [source, target] = await Promise.all([sharp(prototype).metadata(), sharp(shot).metadata()]);
    if (!source.width || !source.height || !target.width || !target.height) return null;
    const width = target.width;
    const rgba = (img: ReturnType<typeof sharp>) => img.flatten({ background: "#ffffff" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const [a, b] = await Promise.all([rgba(sharp(prototype).resize({ width })), rgba(sharp(shot))]);
    const height = Math.max(a.info.height, b.info.height);
    const pad = (x: { data: Buffer; info: { height: number } }) => x.info.height === height ? Promise.resolve(x.data)
      : sharp(x.data, { raw: { width, height: x.info.height, channels: 4 } }).extend({ bottom: height - x.info.height, background: { r: 255, g: 255, b: 255, alpha: 1 } }).raw().toBuffer();
    const [pa, pb] = await Promise.all([pad(a), pad(b)]);
    const out = Buffer.alloc(width * height * 4);
    const changed = pixelmatch(pa, pb, out, width, height, { threshold: PIXELMATCH_THRESHOLD });
    const diff = await sharp(out, { raw: { width, height, channels: 4 } }).png().toBuffer();
    return { percent: (changed / (width * height)) * 100, diff: new Uint8Array(diff), prototypeSize: { width: source.width, height: source.height }, shotSize: { width, height: target.height } };
  } catch {
    return null;
  }
}
