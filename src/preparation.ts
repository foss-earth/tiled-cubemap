import type { ImageSamplingPlan, LinearImage, SourceSampler } from "@foss-earth/images";
import { SOURCE_CUBE_FACES, type CubeFaceName } from "@foss-earth/sphere-cubemap/core";
import type { CubePreparationKernel } from "@foss-earth/sphere-cubemap/preparation";
import type { CubeWarp } from "./cubeTiling.js";

/**
 * Set by `@foss-earth/sphere-equirectangular`'s `cubePreparationPlan` on the sampler it
 * builds. The value is the pyramid level that sampler reads. A sampler without
 * this mark is read one direction at a time, as before.
 */
const CUBE_PREPARATION_LEVEL = Symbol.for("foss-earth.equirectangular.cubePreparationLevel");

/** Full face including exterior gutter, preserving renderTileFace's sample grid. */
export function renderTileFace(plan: ImageSamplingPlan, face: CubeFaceName, size: number, warp: CubeWarp, gutter: number, kernel?: CubePreparationKernel): LinearImage {
  return renderRegion(plan, face, size, warp, gutter, 0, 0, size, kernel);
}
/** Same pixels as cropping the full face at x*tileSize,y*tileSize, without its allocation. */
export function renderCubeTile(plan: ImageSamplingPlan, face: CubeFaceName, faceSize: number, warp: CubeWarp, gutter: number, tileSize: number, x: number, y: number, kernel?: CubePreparationKernel): LinearImage {
  if (!Number.isSafeInteger(tileSize) || tileSize < 1 || faceSize % tileSize !== 0 || !Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 0 || y < 0 || x >= faceSize / tileSize || y >= faceSize / tileSize) throw new RangeError("Tile coordinates must address a complete face grid.");
  return renderRegion(plan, face, faceSize, warp, gutter, x * tileSize, y * tileSize, tileSize, kernel);
}
function renderRegion(plan: ImageSamplingPlan, face: CubeFaceName, size: number, warp: CubeWarp, gutter: number, x: number, y: number, regionSize: number, kernel?: CubePreparationKernel): LinearImage {
  const { samplesPerAxis: samples } = plan;
  if (!Number.isSafeInteger(size) || size < 1 || !Number.isSafeInteger(gutter) || gutter < 0 || !Number.isSafeInteger(samples) || samples < 1 || !Number.isFinite(plan.footprintRadians) || plan.footprintRadians < 0 || !["equi-angular", "gnomonic"].includes(warp)) throw new RangeError("Preparation needs valid face/grid/gutter/warp and angular footprint.");
  const { f, r, t } = SOURCE_CUBE_FACES[face];
  const level = cubePreparationLevel(plan.source);
  if (kernel) {
    if (!level) throw new RangeError("A cube preparation kernel needs an equirectangular preparation level.");
    return kernel.renderEquirectRegion({ source: level, face, faceSize: size, samplesPerAxis: samples,
      warp, gutter, originX: x, originY: y, regionSize });
  }
  if (level) return renderEquirectRegion(level, f, r, t, size, warp, gutter, x, y, regionSize, samples);
  const side = regionSize + 2 * gutter;
  const data = new Float32Array(side * side * 3);
  const colour = [0, 0, 0];
  const warped = (s: number): number => warp === "equi-angular" ? Math.tan(s * Math.PI / 4) : s;
  for (let j = 0; j < side; j++) for (let i = 0; i < side; i++) {
    let red = 0, green = 0, blue = 0;
    for (let sj = 0; sj < samples; sj++) for (let si = 0; si < samples; si++) {
      const a = warped(2 * ((x + i - gutter + (si + 0.5) / samples) / size) - 1);
      const b = warped(1 - 2 * ((y + j - gutter + (sj + 0.5) / samples) / size));
      plan.source.sample([f[0] + a * r[0] + b * t[0], f[1] + a * r[1] + b * t[1], f[2] + a * r[2] + b * t[2]], plan.footprintRadians, colour);
      red += colour[0]; green += colour[1]; blue += colour[2];
    }
    const n = samples * samples, d = (j * side + i) * 3;
    data[d] = red / n; data[d + 1] = green / n; data[d + 2] = blue / n;
  }
  return { width: side, height: side, data };
}

function cubePreparationLevel(sampler: SourceSampler): LinearImage | null {
  if (typeof sampler !== "object" || sampler === null) return null;
  const level = (sampler as unknown as Record<symbol, unknown>)[CUBE_PREPARATION_LEVEL];
  if (typeof level !== "object" || level === null) return null;
  const { width, height, data } = level as LinearImage;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) return null;
  if (!(data instanceof Float32Array) || data.length !== width * height * 3) return null;
  return level as LinearImage;
}

/** Math.hypot(x, y, z) as V8 14.6 computes it for three numbers (math.tq, FastMathHypot). */
function hypot3(x: number, y: number, z: number): number {
  const a = Math.abs(x), b = Math.abs(y), c = Math.abs(z);
  if (a === Infinity || b === Infinity || c === Infinity) return Infinity;
  const max = Math.max(Math.max(a, b), c);
  if (Number.isNaN(max)) return NaN;
  if (max === 0) return 0;
  const powerA = (a / max) * (a / max);
  const powerB = (b / max) * (b / max);
  const compensation = (powerA + powerB) - powerA - powerB;
  const powerC = (c / max) * (c / max) - compensation;
  return Math.sqrt(powerA + powerB + powerC) * max;
}

function renderEquirectRegion(level: LinearImage, f: readonly number[], r: readonly number[], t: readonly number[], size: number, warp: CubeWarp, gutter: number, originX: number, originY: number, regionSize: number, samples: number): LinearImage {
  const f0 = f[0], f1 = f[1], f2 = f[2], r0 = r[0], r1 = r[1], r2 = r[2], t0 = t[0], t1 = t[1], t2 = t[2];
  const { width, height, data: src } = level;
  const equiAngular = warp === "equi-angular";
  const side = regionSize + 2 * gutter;
  const out = new Float32Array(side * side * 3);
  for (let j = 0; j < side; j++) for (let i = 0; i < side; i++) {
    let red = 0, green = 0, blue = 0;
    for (let sj = 0; sj < samples; sj++) for (let si = 0; si < samples; si++) {
      let a = 2 * ((originX + i - gutter + (si + 0.5) / samples) / size) - 1;
      let b = 1 - 2 * ((originY + j - gutter + (sj + 0.5) / samples) / size);
      if (equiAngular) { a = Math.tan(a * Math.PI / 4); b = Math.tan(b * Math.PI / 4); }
      const x = f0 + a * r0 + b * t0, y = f1 + a * r1 + b * t1, z = f2 + a * r2 + b * t2;
      const n = hypot3(x, y, z);
      const u = 0.5 + Math.atan2(x, y) / (2 * Math.PI);
      const v = 0.5 - Math.asin(Math.max(-1, Math.min(1, z / n))) / Math.PI;
      const fx = u * width - 0.5;
      const fy = Math.min(height - 1, Math.max(0, v * height - 0.5));
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const tx = fx - x0, ty = fy - y0;
      const y1 = Math.min(height - 1, y0 + 1);
      const xa = ((x0 % width) + width) % width, xb = (xa + 1) % width;
      const p00 = (y0 * width + xa) * 3, p01 = (y0 * width + xb) * 3, p10 = (y1 * width + xa) * 3, p11 = (y1 * width + xb) * 3;
      const top0 = src[p00] * (1 - tx) + src[p01] * tx, bottom0 = src[p10] * (1 - tx) + src[p11] * tx;
      const top1 = src[p00 + 1] * (1 - tx) + src[p01 + 1] * tx, bottom1 = src[p10 + 1] * (1 - tx) + src[p11 + 1] * tx;
      const top2 = src[p00 + 2] * (1 - tx) + src[p01 + 2] * tx, bottom2 = src[p10 + 2] * (1 - tx) + src[p11 + 2] * tx;
      red += top0 * (1 - ty) + bottom0 * ty;
      green += top1 * (1 - ty) + bottom1 * ty;
      blue += top2 * (1 - ty) + bottom2 * ty;
    }
    const count = samples * samples, d = (j * side + i) * 3;
    out[d] = red / count; out[d + 1] = green / count; out[d + 2] = blue / count;
  }
  return { width: side, height: side, data: out };
}
