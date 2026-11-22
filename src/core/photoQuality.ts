import type { RgbaImage } from './types.js';

export type PhotoQualityIssue = 'blurry' | 'glare' | 'low_contrast' | 'tilted' | 'low_resolution';

export interface PhotoQualityReport {
  readonly passed: boolean;
  readonly score: number;
  readonly issues: readonly PhotoQualityIssue[];
  readonly sharpness: number;
  readonly glarePct: number;
  readonly contrast: number;
  readonly tiltDeg: number;
}

const sampleLimit = 640;
const angles = Array.from({ length: 49 }, (_, i) => (i - 24) / 2);
const slopes = angles.map(angle => Math.tan(angle * Math.PI / 180));

function percentile(histogram: Uint32Array, count: number, fraction: number): number {
  const target = Math.ceil(count * fraction);
  let seen = 0;
  for (let value = 0; value < histogram.length; value++) {
    seen += histogram[value]!;
    if (seen >= target) return value;
  }
  return 255;
}

function samplePhoto(image: RgbaImage) {
  const scale = Math.max(1, image.width / sampleLimit, image.height / sampleLimit);
  const width = Math.max(1, Math.floor(image.width / scale));
  const height = Math.max(1, Math.floor(image.height / scale));
  const levels = new Uint8Array(width * height);
  const histogram = new Uint32Array(256);
  const insetX = Math.floor(width * 0.08);
  const insetY = Math.floor(height * 0.08);
  const positions = scale > 1 ? [0.25, 0.75] : [0.5];
  const samplesPerPixel = positions.length ** 2;
  let dark = 0;
  let clipped = 0;
  let whiteBorder = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const interior = x >= insetX && x < width - insetX && y >= insetY && y < height - insetY;
      let sum = 0;
      for (const dy of positions) {
        const row = Math.floor((y + dy) * scale) * image.width;
        for (const dx of positions) {
          const index = (row + Math.floor((x + dx) * scale)) * 4;
          const r = image.data[index]!;
          const g = image.data[index + 1]!;
          const b = image.data[index + 2]!;
          const level = (54 * r + 183 * g + 19 * b) / 256;
          sum += level;
          if (interior) {
            if (level < 80) dark++;
            if (r >= 248 && g >= 248 && b >= 248) clipped++;
          }
        }
      }
      const level = Math.round(sum / samplesPerPixel);
      levels[y * width + x] = level;
      histogram[level] = histogram[level]! + 1;
      if (!interior && level >= 215) whiteBorder++;
    }
  }
  const contrast = percentile(histogram, levels.length, 0.95) - percentile(histogram, levels.length, 0.05);
  const interiorPixels = (width - 2 * insetX) * (height - 2 * insetY);
  const borderCount = levels.length - interiorPixels;
  const whiteBackground = percentile(histogram, levels.length, 0.30) >= 215 && whiteBorder >= borderCount * 0.65;
  const interiorCount = interiorPixels * samplesPerPixel;
  const glarePct = !whiteBackground && dark >= interiorCount * 0.12 ? 100 * clipped / interiorCount : 0;
  return { levels, width, height, contrast, glarePct };
}

function measureEdges({ levels, width, height, contrast }: ReturnType<typeof samplePhoto>) {
  const xEdges: number[] = [];
  const yEdges: number[] = [];
  const minEdge = Math.max(12, contrast * 0.1);
  const insetX = Math.max(1, Math.floor(width * 0.04));
  const insetY = Math.max(1, Math.floor(height * 0.04));
  let count = 0;
  let laplacianSum = 0;
  let laplacianSquares = 0;
  let gradientXSquares = 0;
  let gradientYSquares = 0;
  let curvatureXSquares = 0;
  let curvatureYSquares = 0;
  for (let y = insetY; y < height - insetY; y++) {
    for (let x = insetX; x < width - insetX; x++) {
      count++;
      const i = y * width + x;
      const center = levels[i]!;
      const left = levels[i - 1]!;
      const right = levels[i + 1]!;
      const above = levels[i - width]!;
      const below = levels[i + width]!;
      const curvatureX = left + right - 2 * center;
      const curvatureY = above + below - 2 * center;
      const laplacian = curvatureX + curvatureY;
      laplacianSum += laplacian;
      laplacianSquares += laplacian ** 2;
      gradientXSquares += (right - center) ** 2;
      gradientYSquares += (below - center) ** 2;
      curvatureXSquares += curvatureX ** 2;
      curvatureYSquares += curvatureY ** 2;

      const dy = Math.abs(above - below);
      if (dy >= minEdge && dy >= 1.5 * Math.abs(left - right)) {
        xEdges.push(x);
        yEdges.push(y);
      }
    }
  }
  const sharpness = count ? Math.max(0, laplacianSquares / count - (laplacianSum / count) ** 2) : 0;
  const gradientSquares = gradientXSquares + gradientYSquares;
  const detailX = gradientXSquares > gradientSquares * 0.01 ? curvatureXSquares / gradientXSquares : Infinity;
  const detailY = gradientYSquares > gradientSquares * 0.01 ? curvatureYSquares / gradientYSquares : Infinity;
  const edgeDetail = gradientSquares ? Math.min(laplacianSquares / gradientSquares, detailX, detailY) : 0;
  return { sharpness, edgeDetail, xEdges, yEdges };
}

function estimateTilt(width: number, height: number, xEdges: readonly number[], yEdges: readonly number[]): number {
  const pad = Math.ceil(width * slopes[slopes.length - 1]!);
  const votes = new Uint32Array(height + 2 * pad);
  let bestAngle = 0;
  let bestStrength = 0;
  let uprightStrength = 0;
  for (const [i, slope] of slopes.entries()) {
    votes.fill(0);
    for (let edge = 0; edge < xEdges.length; edge++) {
      const bin = Math.round(yEdges[edge]! - xEdges[edge]! * slope) + pad;
      votes[bin] = votes[bin]! + 1;
    }
    let peak = 0;
    let strength = 0;
    for (let bin = 1; bin < votes.length; bin++) {
      const adjacent = votes[bin - 1]! + votes[bin]!;
      peak = Math.max(peak, adjacent);
      if (adjacent >= width * 0.25) strength += adjacent ** 2;
    }
    const angle = angles[i]!;
    if (angle === 0) uprightStrength = strength;
    if (peak >= width * 0.45 && strength > bestStrength) {
      bestStrength = strength;
      bestAngle = angle;
    }
  }
  return bestStrength > uprightStrength * 1.2 ? bestAngle : 0;
}

export function assessPhotoQuality(image: RgbaImage): PhotoQualityReport {
  if (!Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width < 1 || image.height < 1
      || image.data.length !== image.width * image.height * 4) throw new Error('Invalid RGBA capture dimensions');

  const photo = samplePhoto(image);
  const { contrast, glarePct } = photo;
  const { sharpness, edgeDetail, xEdges, yEdges } = measureEdges(photo);
  const tiltDeg = estimateTilt(photo.width, photo.height, xEdges, yEdges);
  const issues: PhotoQualityIssue[] = [];
  if (sharpness < 20 || edgeDetail < 0.8) issues.push('blurry');
  if (glarePct >= 2) issues.push('glare');
  if (contrast < 45) issues.push('low_contrast');
  if (Math.abs(tiltDeg) > 3.5) issues.push('tilted');
  if (image.width < 480 || image.height < 320) issues.push('low_resolution');

  const score = Math.round(100 * (
    0.35 * Math.min(1, sharpness / 20, edgeDetail / 0.8)
    + 0.20 * Math.max(0, 1 - glarePct / 10)
    + 0.20 * Math.min(1, contrast / 45)
    + 0.15 * Math.max(0, 1 - Math.abs(tiltDeg) / 12)
    + 0.10 * Math.min(1, image.width / 480, image.height / 320)
  ));
  const passed = issues.length === 0;
  return { passed, score: passed ? score : Math.min(99, score), issues, sharpness, glarePct, contrast, tiltDeg };
}
