import { describe, expect, test } from 'vitest';
import { projectQuadToRect, projectRectToQuad, rectifyGrid, validateQuad } from '../../src/core/deskew.js';
import { renderOverlaySvg } from '../../src/core/export/svg.js';
import { analyzeCapture } from '../../src/core/pipeline.js';
import type { Quad } from '../../src/core/types.js';
import { bitmap, pixel, yellow } from './fixtures.js';

const quad: Quad = [{ x: 20, y: 15 }, { x: 170, y: 25 }, { x: 185, y: 145 }, { x: 10, y: 130 }];
const size = { width: 161, height: 121 };

describe('four-corner deskew', () => {
  test('maps all four corners exactly and projects interior points both ways', () => {
    const corners = [{ x: 0, y: 0 }, { x: 160, y: 0 }, { x: 160, y: 120 }, { x: 0, y: 120 }];
    for (const [index, corner] of corners.entries()) {
      const p = projectRectToQuad(corner, quad, size);
      expect(p.x).toBeCloseTo(quad[index]!.x, 10);
      expect(p.y).toBeCloseTo(quad[index]!.y, 10);
    }
    const p = { x: 62.2, y: 97.85 };
    const roundtrip = projectQuadToRect(projectRectToQuad(p, quad, size), quad, size);
    expect(roundtrip.x).toBeCloseTo(p.x, 10);
    expect(roundtrip.y).toBeCloseTo(p.y, 10);
  });

  test('uses bilinear samples and preserves a pixel-aligned rectangle exactly', () => {
    const image = bitmap(6, 5);
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) pixel(image, x, y, [x * 40, y * 40, 0]);
    }
    expect(rectifyGrid(image, [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 4 }, { x: 0, y: 4 }])).toEqual(image);
    const rect = rectifyGrid(image, [{ x: 0.5, y: 0.5 }, { x: 4.5, y: 0.5 }, { x: 4.5, y: 3.5 }, { x: 0.5, y: 3.5 }]);
    expect(rect).toMatchObject({ width: 5, height: 4 });
    expect([...rect.data.slice(0, 4)]).toEqual([20, 20, 0, 255]);
  });

  test('keeps transparent pixels from tinting neighboring trace ink', () => {
    const image = bitmap(4, 4, yellow);
    for (let y = 0; y < 4; y++) image.data.set([255, 0, 255, 0], y * 16);
    const rect = rectifyGrid(image, [{ x: 0.5, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 3 }, { x: 0.5, y: 3 }]);
    expect([...rect.data.slice(0, 4)]).toEqual([...yellow, 128]);
  });

  test('rejects crossed, reversed, duplicate, collinear and out-of-bounds corners', () => {
    const [a, b, c, d] = quad;
    const bad: Quad[] = [
      [a, c, b, d], [a, d, c, b], [a, a, c, d], [a, { x: 40, y: 15 }, { x: 60, y: 15 }, d],
      [{ x: -1, y: 15 }, b, c, d], [{ x: NaN, y: 15 }, b, c, d],
    ];
    for (const corners of bad) {
      expect(validateQuad(corners, 200, 160)).toBe(false);
      expect(() => rectifyGrid(bitmap(200, 160), corners)).toThrow(/deskew corners/i);
    }
  });

  test('caps a caller-supplied output size', () => {
    const result = rectifyGrid(bitmap(200, 160), quad, { width: 30_000, height: 30 });
    expect(result.width).toBe(4096);
    expect(result.height).toBeLessThan(30);
  });

  test('recovers calibration on a perspective grid and projects the overlay to the source photo', () => {
    const src = bitmap(200, 160);
    for (let y = 0; y < src.height; y++) {
      for (let x = 0; x < src.width; x++) {
        const p = projectQuadToRect({ x, y }, quad, size);
        const wave = 60 - 26 * Math.cos(2 * Math.PI * p.x / 40);
        if (p.x >= -1 && p.x <= 161 && Math.abs(wave - p.y) < 2) pixel(src, x, y, yellow);
      }
    }
    const result = analyzeCapture(src, 'tilted.png', {
      manualQuad: quad, profileId: 'rigol-ds1054z', hDivs: 8, vDivs: 6, secPerDiv: 1e-3,
      channels: { C1: { voltsPerDiv: 2 } },
    });
    expect(result).toMatchObject({ sourceWidth: 200, sourceHeight: 160, sourceQuad: quad });
    expect(result.detection.profileId).toBe('universal-fallback');
    expect(result.detection.grid).toMatchObject({
      left: 0, top: 0, right: result.imageWidth - 1, bottom: result.imageHeight - 1, hDivs: 8, vDivs: 6,
    });
    expect(result.measurements[0]?.frequencyHz).toBeCloseTo(500, -1);
    expect(result.traces[0]!.validCount).toBeGreaterThan(result.imageWidth * 0.97);
    const overlay = renderOverlaySvg(result);
    expect(overlay).toContain('viewBox="0 0 200 160"');
    expect(overlay).toContain('points="20 15 170 25 185 145 10 130"');
    const first = result.traces[0]!.samples.find(sample => sample.status === 'ok')!;
    const point = projectRectToQuad({ x: first.xPx, y: first.yPx! }, quad, { width: result.imageWidth, height: result.imageHeight });
    const rounded = (value: number) => Math.round(value * 100) / 100;
    expect(overlay).toContain("M" + rounded(point.x) + " " + rounded(point.y));
  });
});
