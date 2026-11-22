import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import configuration from '../../src/core/profiles.json';
import { logo as rigolLogo } from '../../src/core/font/rigolFont.js';
import { parseQuantity } from '../../src/core/font/matcher.js';
import { analyzeCapture, analyzePngBytes } from '../../src/core/pipeline.js';
import { decodePng } from '../../src/core/png.js';
import { detectProfile, validateProfiles } from '../../src/core/profiles.js';
import { bitmap, paint, pixel, sample, yellow } from './fixtures.js';

describe('native capture profiles', () => {
  test('checks profile version, required fields, geometry and bounds at startup', () => {
    expect(validateProfiles(configuration).map(p => p.id)).toEqual(['siglent-sds2000x-plus', 'rigol-ds1054z']);
    expect(() => validateProfiles({ ...configuration, version: 2 })).toThrow('Invalid oscilloscope profile configuration');
    expect(() => validateProfiles({ ...configuration, profiles: [configuration.profiles[0], configuration.profiles[0]] })).toThrow();
    for (const change of [
      { channels: {} },
      { zeroMarkerStrip: { x: -1, y: 0, width: 1, height: 1 } },
      { graticule: { ...configuration.profiles[0]!.graticule, pxPerHDiv: NaN } },
      { graticule: { ...configuration.profiles[0]!.graticule, vDivs: 7 } },
    ]) {
      expect(() => validateProfiles({ ...configuration, profiles: [{ ...configuration.profiles[0], ...change }, configuration.profiles[1]] })).toThrow();
    }
  });

  test.each([
    ['sine_schmitt.png', 'measure-1row', 499, 56.25],
    ['zener_clip.png', 'no-measure', 529, 60],
    ['sweep_04.png', 'measure-2row', 479, 53.75],
  ] as const)('matches %s and recovers its grid', (fileName, variant, bottom, pxPerVDiv) => {
    const result = detectProfile(decodePng(sample(fileName)));
    expect(result.profileId).toBe('siglent-sds2000x-plus');
    expect(result.matchedAnchors).toEqual(['dimensions', 'logo', 'header', 'bottom_bar', 'graticule']);
    expect(result.grid).toMatchObject({ left: 19, right: 1019, top: 49, bottom, pxPerVDiv, layoutVariant: variant });
    expect(result.grid.fitErrorPx).toBeLessThan(1);
  });

  test('rejects blank, random, resized and shifted frames', () => {
    const noise = bitmap(1024, 600);
    let seed = 42;
    for (let i = 0; i < noise.data.length; i += 4) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      noise.data[i] = seed >>> 24;
      noise.data[i + 1] = (seed >>> 16) & 255;
      noise.data[i + 2] = seed & 255;
    }
    const photo = bitmap(1024, 600, [41, 23, 91]);
    const original = decodePng(sample('sine_schmitt.png'));
    for (let y = 0; y < 575; y++) photo.data.set(original.data.subarray((y * 1024 + 24) * 4, (y * 1024 + 1024) * 4), ((y + 25) * 1024) * 4);
    for (const image of [bitmap(1024, 600), bitmap(800, 480, [235, 235, 235]), noise, photo, bitmap(1024, 599)]) {
      expect(detectProfile(image)).toMatchObject({ profileId: 'universal-fallback', matchedAnchors: [] });
    }
    expect(detectProfile(noise, { profileId: 'siglent-sds2000x-plus' }).fallbackReason).toBe('native_anchors_mismatch');
    expect(detectProfile(bitmap(1024, 599)).fallbackReason).toBe('unsupported_resolution');
  });

  test('matches a Rigol grid and rejects an exact logo with a missing grid', () => {
    const image = bitmap(800, 480);
    rigolLogo.forEach((row, y) => [...row].forEach((bit, x) => {
      if (bit === '1') pixel(image, 4 + x, 8 + y, yellow);
    }));
    expect(detectProfile(image).profileId).toBe('universal-fallback');
    for (let y = 38; y <= 438; y += 50) {
      for (let x = 84; x <= 684; x += y === 38 || y === 438 ? 1 : 2) pixel(image, x, y, y === 438 ? [96, 100, 96] : [48, 48, 48]);
    }
    for (let x = 134; x < 684; x += 50) {
      for (let y = 40; y < 438; y += 2) pixel(image, x, y, [48, 48, 48]);
    }
    expect(detectProfile(image)).toMatchObject({
      profileId: 'rigol-ds1054z', grid: { left: 84, right: 684, top: 38, bottom: 438, hDivs: 12, vDivs: 8, pxPerHDiv: 50, pxPerVDiv: 50 },
    });
  });

  test('finds a rectangular dark plot and honors crop and division overrides', () => {
    const image = bitmap(400, 300, [225, 225, 225]);
    paint(image, { x: 39, y: 48, width: 323, height: 203 }, [13, 13, 13]);
    expect(detectProfile(image).grid).toMatchObject({ left: 39, right: 361, top: 48, bottom: 250, inverted: false });
    expect(detectProfile(image, { manualCrop: { x: 50, y: 55, width: 300, height: 192 }, hDivs: 12, vDivs: 6 })).toMatchObject({
      fallbackReason: 'manual_crop', grid: { left: 50, right: 350, top: 55, bottom: 247, pxPerHDiv: 25, pxPerVDiv: 32 },
    });
    expect(analyzeCapture(bitmap(1, 1), 'tiny.png').detection.profileId).toBe('universal-fallback');
  });
});

const rigolPath = process.env.GRATICULE_RIGOL_PNG;
test.skipIf(!rigolPath || !existsSync(rigolPath))('reads the real local Rigol capture and its scale cards', () => {
  const result = analyzePngBytes(readFileSync(rigolPath!), 'rigol_sample.png');
  expect(result.detection.profileId).toBe('rigol-ds1054z');
  expect(result.timebase).toMatchObject({ source: 'ocr', rawText: '1.00ms', secPerDiv: 0.001 });
  expect(result.timebase.triggerOffsetSec).toBeCloseTo(0.00032, 9);
  expect(result.traces.map(trace => [trace.channel, trace.settings.voltsPerDiv, trace.settings.zeroSource, trace.validCount])).toEqual([
    ['C1', 2, 'marker', 600], ['C2', 5, 'marker', 600],
  ]);
});

test.each([
  ['-7.357mV', -7.357e-3], ['509uV', 509e-6], ['8µV', 8e-6], ['4V', 4], ['25ns', 25e-9],
  ['500us', 5e-4], ['1,5ms', 1.5e-3], ['2s', 2], ['21Hz', 21], ['1.2kHz', 1200], ['10MHz', 1e7], ['50%', 50],
])('parses %s as an SI or percentage value', (text, value) => {
  expect(parseQuantity(text)?.value).toBeCloseTo(value, 13);
  expect(parseQuantity('9?9Hz')).toBeNull();
});
