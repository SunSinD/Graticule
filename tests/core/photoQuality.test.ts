import { describe, expect, it } from 'vitest';
import { assessPhotoQuality } from '../../src/core/photoQuality.js';
import type { RgbaImage } from '../../src/core/types.js';

function capture({ width = 640, height = 400, angle = 0, glare = false, print = false, contrast = 175, bezel = false } = {}): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  const radians = angle * Math.PI / 180;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ox = x - width / 2;
      const oy = y - height / 2;
      const u = ox * Math.cos(radians) + oy * Math.sin(radians);
      const v = oy * Math.cos(radians) - ox * Math.sin(radians);
      const grid = Math.abs(u - 52 * Math.round(u / 52)) <= 1.5 || Math.abs(v - 40 * Math.round(v / 40)) <= 1.5;
      const trace = Math.abs(v - 55 * Math.sin(u / 35)) < 2;
      const level = bezel && (Math.abs(u) > width * 0.28 || Math.abs(v) > height * 0.36) ? 42
        : glare && (ox - 45) ** 2 + (oy + 15) ** 2 < 70 ** 2 ? 255
        : print ? (grid || trace ? 35 : 255) : grid || trace ? 22 + contrast : 22;
      data.set([level, level, level, 255], (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

function boxBlur(image: RgbaImage, radiusX: number, radiusY = radiusX): RgbaImage {
  const { width, height } = image;
  const data = image.data.slice();
  for (let y = radiusY; y < height - radiusY; y++) {
    for (let x = radiusX; x < width - radiusX; x++) {
      let sum = 0;
      for (let dy = -radiusY; dy <= radiusY; dy++) {
        for (let dx = -radiusX; dx <= radiusX; dx++) sum += image.data[((y + dy) * width + x + dx) * 4]!;
      }
      const value = sum / ((2 * radiusX + 1) * (2 * radiusY + 1));
      data.set([value, value, value], (y * width + x) * 4);
    }
  }
  return { ...image, data };
}

describe('phone photo quality', () => {
  it('passes a sharp, high contrast, upright image', () => {
    const report = assessPhotoQuality(capture());
    expect(report).toMatchObject({ passed: true, issues: [], tiltDeg: 0, glarePct: 0, contrast: 175 });
    expect(report.score).toBe(100);
    expect(report.sharpness).toBeGreaterThan(20);
  });

  it('flags box blur and reports less edge detail', () => {
    const image = capture();
    const sharp = assessPhotoQuality(image);
    const blurred = assessPhotoQuality(boxBlur(image, 4));
    expect(blurred.passed).toBe(false);
    expect(blurred.issues).toContain('blurry');
    expect(blurred.sharpness).toBeLessThan(sharp.sharpness / 8);
    expect(blurred.score).toBeLessThan(sharp.score);
  });

  it('flags one-direction motion blur even when the other axis stays sharp', () => {
    const image = capture();
    expect(assessPhotoQuality(boxBlur(image, 5, 0)).issues).toContain('blurry');
    expect(assessPhotoQuality(boxBlur(image, 0, 5)).issues).toContain('blurry');
  });

  it('measures glare on a dark screen and exempts a white print background', () => {
    const washed = assessPhotoQuality(capture({ glare: true }));
    expect(washed.issues).toEqual(['glare']);
    expect(washed.glarePct).toBeGreaterThan(7);
    expect(washed.glarePct).toBeLessThan(11);
    expect(assessPhotoQuality(capture({ print: true }))).toMatchObject({ passed: true, glarePct: 0 });
  });

  it('flags a low contrast screen even when its lines are sharp', () => {
    const report = assessPhotoQuality(capture({ contrast: 32 }));
    expect(report.issues).toEqual(['low_contrast']);
    expect(report.contrast).toBe(32);
  });

  it.each([-10, -5, 4.5, 8])('finds horizontal lines tilted by %s degrees', angle => {
    const report = assessPhotoQuality(capture({ angle }));
    expect(report.issues).toContain('tilted');
    expect(Math.abs(report.tiltDeg - angle)).toBeLessThanOrEqual(0.5);
  });

  it.each([-24, 21])('finds grid tilt of %s degrees through a wide bezel', angle => {
    const report = assessPhotoQuality(capture({ angle, bezel: true }));
    expect(report.issues).toContain('tilted');
    expect(report.tiltDeg).toBeCloseTo(angle, 0);
  });

  it.each([-3, 3.5])('allows a small rotation of %s degrees', angle => {
    const report = assessPhotoQuality(capture({ angle }));
    expect(report.passed).toBe(true);
    expect(Math.abs(report.tiltDeg - angle)).toBeLessThanOrEqual(0.5);
  });

  it('checks the original resolution against both minimum dimensions', () => {
    expect(assessPhotoQuality(capture({ width: 480, height: 320 })).passed).toBe(true);
    expect(assessPhotoQuality(capture({ width: 479 }))).toMatchObject({ issues: ['low_resolution'], score: 99 });
    expect(assessPhotoQuality(capture({ height: 319 })).issues).toEqual(['low_resolution']);
  });

  it('keeps measurements finite when the photograph has no visible detail', () => {
    const report = assessPhotoQuality({ width: 1, height: 1, data: new Uint8ClampedArray([20, 20, 20, 255]) });
    expect(report).toMatchObject({ passed: false, issues: ['blurry', 'low_contrast', 'low_resolution'],
      sharpness: 0, contrast: 0, glarePct: 0, tiltDeg: 0 });
    expect(report.score).toBeGreaterThanOrEqual(0);
    expect(report.score).toBeLessThanOrEqual(100);
  });
});
