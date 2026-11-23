import type { Point, Quad, RgbaImage } from './types.js';

export interface DeskewSize {
  readonly width: number;
  readonly height: number;
}

const maxSide = 4096;
const maxPixels = 8_388_608;

function cross(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
}

function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function validateQuad(quad: Quad, width: number, height: number): boolean {
  if (quad.length !== 4 || !Number.isFinite(width) || !Number.isFinite(height)) return false;
  for (let i = 0; i < quad.length; i++) {
    const p = quad[i];
    const next = quad[(i + 1) % 4]!;
    const after = quad[(i + 2) % 4]!;
    if (!p || !next || !after || !Number.isFinite(p.x) || !Number.isFinite(p.y)
        || p.x < 0 || p.x > width || p.y < 0 || p.y > height || distance(p, next) < 1
        || cross(p, next, after) < 1) return false;
  }
  const [tl, tr, br, bl] = quad;
  // Average the opposite edges so a tilted or perspective-skewed top edge can still start at TL.
  const acrossX = tr.x - tl.x + br.x - bl.x;
  const acrossY = tr.y - tl.y + br.y - bl.y;
  const downX = bl.x - tl.x + br.x - tr.x;
  const downY = bl.y - tl.y + br.y - tr.y;
  if (acrossX <= Math.abs(acrossY) || downY <= Math.abs(downX)) return false;
  const { minWeight } = transform(quad);
  return minWeight > 1e-9;
}

function transform(quad: Quad) {
  const [a, b, c, d] = quad;
  // Shift the origin and scale the source coordinates before solving.
  const scale = Math.max(distance(a, b), distance(a, c), distance(a, d));
  const bx = (b.x - a.x) / scale;
  const by = (b.y - a.y) / scale;
  const cx = (c.x - a.x) / scale;
  const cy = (c.y - a.y) / scale;
  const dx = (d.x - a.x) / scale;
  const dy = (d.y - a.y) / scale;
  const rx = cx - bx - dx;
  const ry = cy - by - dy;
  const det = (bx - cx) * (dy - cy) - (dx - cx) * (by - cy);
  const g = (rx * (dy - cy) - ry * (dx - cx)) / det;
  const h = ((bx - cx) * ry - (by - cy) * rx) / det;
  const ux = bx * (1 + g);
  const uy = by * (1 + g);
  const vx = dx * (1 + h);
  const vy = dy * (1 + h);

  return {
    minWeight: Math.min(1, 1 + g, 1 + h, 1 + g + h),
    toQuad(u: number, v: number): Point {
      const factor = scale / (g * u + h * v + 1);
      return { x: a.x + (ux * u + vx * v) * factor, y: a.y + (uy * u + vy * v) * factor };
    },
    toUnit(point: Point): Point {
      const x = (point.x - a.x) / scale;
      const y = (point.y - a.y) / scale;
      const aa = ux - x * g;
      const bb = vx - x * h;
      const cc = uy - y * g;
      const dd = vy - y * h;
      const denominator = aa * dd - bb * cc;
      return { x: (x * dd - y * bb) / denominator, y: (aa * y - cc * x) / denominator };
    },
  };
}

/** Rectified points use pixel coordinates from (0, 0) to (width - 1, height - 1). */
export function projectRectToQuad(point: Point, quad: Quad, size: DeskewSize): Point {
  return transform(quad).toQuad(point.x / (size.width - 1), point.y / (size.height - 1));
}

export function projectQuadToRect(point: Point, quad: Quad, size: DeskewSize): Point {
  const unit = transform(quad).toUnit(point);
  return { x: unit.x * (size.width - 1), y: unit.y * (size.height - 1) };
}

function outputSize([a, b, c, d]: Quad, size: DeskewSize | undefined): DeskewSize {
  const width = size?.width ?? (distance(a, b) + distance(d, c)) / 2 + 1;
  const height = size?.height ?? (distance(a, d) + distance(b, c)) / 2 + 1;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 2 || height < 2) {
    throw new Error('Invalid rectified image size');
  }
  const scale = Math.min(1, maxSide / width, maxSide / height, Math.sqrt(maxPixels / width / height));
  const w = Math.max(2, Math.round(width * scale));
  return { width: w, height: Math.max(2, Math.min(Math.round(height * scale), Math.floor(maxPixels / w))) };
}

export function normalizeQuad(quad: Quad, imageWidth: number, imageHeight: number): Quad {
  const [tl, tr, br, bl] = quad;
  const fullWidth = tl.x === 0 && bl.x === 0 && tr.x === imageWidth && br.x === imageWidth;
  const fullHeight = tl.y === 0 && tr.y === 0 && bl.y === imageHeight && br.y === imageHeight;
  // Full-image bounds can use the exclusive right and bottom edges.
  const pixelPoint = ({ x, y }: Point): Point => ({
    x: fullWidth ? Math.min(x, imageWidth - 1) : x,
    y: fullHeight ? Math.min(y, imageHeight - 1) : y,
  });
  return fullWidth || fullHeight ? [pixelPoint(tl), pixelPoint(tr), pixelPoint(br), pixelPoint(bl)] : quad;
}

export function rectifyGrid(image: RgbaImage, quad: Quad, size?: DeskewSize): RgbaImage {
  if (!Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width < 2 || image.height < 2
      || image.data.length !== image.width * image.height * 4) throw new Error('Invalid RGBA capture dimensions');
  if (!validateQuad(quad, image.width, image.height)) {
    throw new Error('Invalid deskew corners: use four convex corners inside the image in TL, TR, BR, BL order');
  }
  const pixelQuad = normalizeQuad(quad, image.width, image.height);
  const { width, height } = outputSize(pixelQuad, size);
  const { toQuad } = transform(pixelQuad);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const point = toQuad(x / (width - 1), y / (height - 1));
      const px = Math.min(image.width - 1, Math.max(0, point.x));
      const py = Math.min(image.height - 1, Math.max(0, point.y));
      const left = Math.floor(px);
      const top = Math.floor(py);
      const right = Math.min(left + 1, image.width - 1);
      const bottom = Math.min(top + 1, image.height - 1);
      const fx = px - left;
      const fy = py - top;
      const tl = (top * image.width + left) * 4;
      const tr = (top * image.width + right) * 4;
      const bl = (bottom * image.width + left) * 4;
      const br = (bottom * image.width + right) * 4;
      const dest = (y * width + x) * 4;
      const a = image.data[tl + 3]! * (1 - fx) * (1 - fy);
      const b = image.data[tr + 3]! * fx * (1 - fy);
      const c = image.data[bl + 3]! * (1 - fx) * fy;
      const d = image.data[br + 3]! * fx * fy;
      const alpha = a + b + c + d;
      data[dest + 3] = alpha;
      if (alpha === 0) continue;
      for (let i = 0; i < 3; i++) {
        data[dest + i] = (image.data[tl + i]! * a + image.data[tr + i]! * b
          + image.data[bl + i]! * c + image.data[br + i]! * d) / alpha;
      }
    }
  }
  return { width, height, data };
}
