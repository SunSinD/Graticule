import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import configuration from '../../src/core/profiles.json';
import { renderWaveformSvg, waveformFrame } from '../../src/core/export/svg.js';
import { glyphs as rigolGlyphs, logo as rigolLogo } from '../../src/core/font/rigolFont.js';
import { rasterFonts } from '../../src/core/font/rasterFonts.js';
import { parseQuantity } from '../../src/core/font/matcher.js';
import { analyzeCapture, analyzePngBytes, compareWithScopeCsv, parseScopeCsv } from '../../src/core/pipeline.js';
import { decodePng } from '../../src/core/png.js';
import { detectProfile, getNativeProfile, validateProfiles } from '../../src/core/profiles.js';
import { bitmap, paint, pixel, sample, yellow } from './fixtures.js';

describe('native capture profiles', () => {
  test('checks profile version, required fields, geometry and bounds at startup', () => {
    expect(validateProfiles(configuration).map(p => p.id)).toEqual([
      'siglent-sds2000x-plus', 'rigol-ds1054z', 'siglent-sds1000x-e', 'rigol-dho924',
      'rohde-schwarz-rtb2004', 'tektronix-dpo7104c',
      'siglent-sds800x-hd', 'keysight-dsox1000',
    ]);
    expect(() => validateProfiles({ ...configuration, version: 2 })).toThrow('Invalid oscilloscope profile configuration');
    expect(() => validateProfiles({ ...configuration, profiles: [configuration.profiles[0], configuration.profiles[0],
      ...configuration.profiles.slice(2)] })).toThrow();
    for (const change of [
      { channels: {} },
      { zeroMarkerStrip: { x: -1, y: 0, width: 1, height: 1 } },
      { graticule: { ...configuration.profiles[0]!.graticule, pxPerHDiv: NaN } },
      { graticule: { ...configuration.profiles[0]!.graticule, vDivs: 7 } },
    ]) {
      expect(() => validateProfiles({ ...configuration, profiles: [{ ...configuration.profiles[0], ...change },
        ...configuration.profiles.slice(1)] })).toThrow();
    }
  });

  test.each(configuration.profiles.slice(2))('rejects blank and noisy screens at the $id resolution', profile => {
    const white = bitmap(profile.width, profile.height, [255, 255, 255]);
    const black = bitmap(profile.width, profile.height);
    const noise = bitmap(profile.width, profile.height);
    let value = 2026;
    for (let i = 0; i < noise.data.length; i += 4) {
      value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
      noise.data[i] = value >>> 24;
      noise.data[i + 1] = (value >>> 16) & 255;
      noise.data[i + 2] = (value >>> 8) & 255;
    }
    for (const image of [white, black, noise]) {
      expect(detectProfile(image)).toMatchObject({ profileId: 'universal-fallback', matchedAnchors: [] });
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

    const slots = [0, 116, 233, 350];
    const colors = [[248, 252, 0], [0, 252, 248], [248, 0, 248], [0, 128, 248]] as const;
    for (const [i, ink] of colors.entries()) {
      const y = 105 + i * 70;
      paint(image, { x: 70, y: y - 3, width: 12, height: 7 }, ink);
      paint(image, { x: 84, y: y - 10, width: 600, height: 1 }, ink);
      let x = slots[i]! + 53;
      for (const value of '2.00V') {
        const glyph = Object.keys(rigolGlyphs).find(key => rigolGlyphs[key] === value)!.split('/');
        glyph.forEach((row, dy) => [...row].forEach((bit, dx) => {
          if (bit === '#') pixel(image, x + dx, 463 + dy, ink);
        }));
        x += glyph[0]!.length + 1;
      }
    }
    expect(analyzeCapture(image, 'rigol-four-channels.png').traces.map(t => [
      t.channel, t.settings.voltsPerDiv, t.settings.zeroY, t.validCount,
    ])).toEqual([['C1', 2, 105, 600], ['C2', 2, 175, 600], ['C3', 2, 245, 600], ['C4', 2, 315, 600]]);

    for (let y = 172; y < 179; y++) {
      for (let x = 70; x < 82; x++) image.data[4 * (y * image.width + x) + 3] = 64;
    }
    const c2 = analyzeCapture(image, 'rigol-transparent-marker.png').traces.find(trace => trace.channel === 'C2');
    expect(c2?.settings).toMatchObject({ zeroSource: 'default', zeroY: 238, voltsPerDiv: 2 });
  });

  test('ignores transparent RGB retained in otherwise matching native profile anchors', () => {
    const image = decodePng(sample('sine_schmitt.png'));
    expect(detectProfile(image).profileId).toBe('siglent-sds2000x-plus');
    for (let index = 3; index < image.data.length; index += 4) image.data[index] = 0;
    expect(detectProfile(image).profileId).toBe('universal-fallback');
  });

  test('keeps the explicitly selected Rigol cyan channel through manual crop and deskew', () => {
    const image = bitmap(211, 91);
    paint(image, { x: 5, y: 40, width: 201, height: 1 }, [0, 252, 248]);
    const profileId = 'rigol-ds1054z';
    const crop = analyzeCapture(image, 'cropped.png', { profileId, manualCrop: { x: 5, y: 5, width: 200, height: 80 } });
    const deskew = analyzeCapture(image, 'deskewed.png', { profileId, manualQuad: [
      { x: 5, y: 5 }, { x: 205, y: 5 }, { x: 205, y: 85 }, { x: 5, y: 85 },
    ] });
    for (const result of [crop, deskew]) expect(result.traces).toMatchObject([{ channel: 'C2', validCount: 201 }]);
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

  test('preserves the cropped RTB2004 horizontal calibration and compares all visible columns', () => {
    const id = 'rohde-schwarz-rtb2004';
    const profile = getNativeProfile(id)!;
    const { anchors, graticule, raster } = profile;
    const { left, top, hDivs, vDivs, pxPerHDiv } = graticule;
    const { bottom, right } = graticule.variants.find(variant => variant.id === 'measure-1row')!;
    const width = right! - left + 1, height = bottom - top + 1;
    const image = bitmap(profile.width, profile.height);
    paint(image, anchors.topBarRoi, raster!.headerInk);
    paint(image, anchors.bottomBarRoi, raster!.footerInk);
    rasterFonts[id].logo.forEach((row, y) => [...row].forEach((bit, x) => {
      if (bit === '1') pixel(image, anchors.logoRoi.x + x, anchors.logoRoi.y + y, raster!.logoInk);
    }));
    for (let i = 1; i < vDivs; i++) {
      paint(image, { x: left, y: top + Math.round(i * (height - 1) / vDivs), width, height: 1 }, raster!.lineInk[0]!);
    }
    for (let i = 1; i < hDivs; i++) {
      paint(image, { x: left + i * pxPerHDiv, y: top, width: 1, height }, raster!.lineInk[0]!);
    }
    paint(image, { x: left, y: top, width, height: 1 }, raster!.topEdgeInk);
    paint(image, { x: left, y: bottom, width, height: 1 }, raster!.bottomEdgeInk);
    for (const x of [left, right!]) paint(image, { x, y: top, width: 1, height }, raster!.sideEdgeInk);
    paint(image, { x: left, y: 400, width, height: 1 }, yellow);

    const analyze = (vDivs?: number) => analyzeCapture(image, 'rtb-cropped.png', { vDivs, channels: { C1: { enabled: true } } });
    const result = analyze();
    expect(result.detection.profileId).toBe(id);
    expect(analyze(8).detection.grid).toMatchObject({
      layoutVariant: 'measure-1row', pxPerHDiv: 100, centerX: 639, vDivs: 8, pxPerVDiv: 642 / 8,
      vLines: result.detection.grid.vLines,
    });
    const overridden = detectProfile(image, { hDivs: 6 }).grid;
    expect(overridden).toMatchObject({
      layoutVariant: 'measure-1row', left, right, width: right! - left, hDivs: 6, pxPerHDiv: 200, centerX: 639,
    });
    expect(overridden.vLines).toEqual([39, 239, 439, 639, 839, 1039]);
    expect(overridden.vLines.every(x => x <= right!)).toBe(true);
    const rows = result.traces[0]!.samples.map(sample => `${sample.timeSec},${sample.voltage ?? ''}`);
    const comparison = compareWithScopeCsv(result, parseScopeCsv(['Time (s),C1', ...rows].join('\n')));
    expect(comparison).toMatchObject({ totalCount: 1165, usableCount: 1165, unaligned: { matchedCount: 1165, rmseV: 0 } });
    const { x0, y0, y1, plotW } = waveformFrame(result);
    const firstTickX = Number((x0 + plotW * pxPerHDiv / (width - 1)).toFixed(2));
    const svg = renderWaveformSvg(result);
    expect(svg).toContain(`x1="${firstTickX}" y1="${y0}" x2="${firstTickX}"`);
    expect(svg).toContain(`x1="${firstTickX}" y1="${Number(y1.toFixed(2))}" x2="${firstTickX}"`);

    paint(image, { x: left, y: 400, width, height: 1 }, [0, 0, 0]);
    const traceY = bottom - 10;
    paint(image, { x: left, y: traceY, width, height: 1 }, [255, 255, 0]);
    const bottomTrace = analyze().traces[0]!;
    expect(bottomTrace.validCount).toBe(width);
    expect(bottomTrace.samples.every(sample => sample.yPx === traceY)).toBe(true);
    paint(image, { x: left + pxPerHDiv - 2, y: traceY, width: 12, height: 1 }, [0, 0, 0]);
    paint(image, { x: left + pxPerHDiv, y: bottom - 17, width: 8, height: 12 }, [252, 252, 0]);
    expect(analyze().traces[0]!.samples[pxPerHDiv]?.status).toBe('masked_overlay');
  });
});

const newScopeRoot = process.env.GRATICULE_NEW_SCOPE_FIXTURES;
const measuredCaptures = [
  { file: 'siglent-mcp-pixels.png', id: 'siglent-sds1000x-e', bounds: [12, 18, 712, 418], pitch: [50, 50],
    divisions: [14, 8], scale: 200e-6, delay: 0, channels: [['C1', 1, 292]], referenceFrequency: 1000 },
  { file: 'rigol-dho924.png', id: 'rigol-dho924', bounds: [12, 93, 508, 507], pitch: [49.6, 51.75],
    divisions: [10, 8], scale: 200e-9, delay: 0, channels: [['C1', 2, 300]], referenceFrequency: 5.2083e6 },
  { file: 'rtb-timing-a.png', id: 'rohde-schwarz-rtb2004', bounds: [39, 100, 1203, 742], pitch: [100, 64.2],
    divisions: [12, 10], scale: 5e-9, delay: 0, channels: [['C1', 2, 436], ['C2', 10, 419]] },
  { file: 'rtb-timing-b.png', id: 'rohde-schwarz-rtb2004', bounds: [39, 100, 1239, 780], pitch: [100, 68],
    divisions: [12, 10], scale: 10e-9, delay: 0, channels: [['C1', 2, 456], ['C2', 2, 485]] },
  { file: 'rtb-timing-c.png', id: 'rohde-schwarz-rtb2004', bounds: [39, 100, 1239, 780], pitch: [100, 68],
    divisions: [12, 10], scale: 20e-9, delay: 49.96e-6, channels: [['C1', 2, 456], ['C2', 2, 485]] },
  { file: 'tektronix-dpo7104c.png', id: 'tektronix-dpo7104c', bounds: [16, 35, 1016, 455], pitch: [100, 42],
    divisions: [10, 10], scale: 2e-3, delay: 0, channels: [['C4', 0.4, 245]], referenceFrequency: 1000 },
] as const;

describe.skipIf(!newScopeRoot)('downloaded native captures for the additional profiles', () => {
  const load = (name: string) => decodePng(readFileSync(join(newScopeRoot!, name)));

  test.each(measuredCaptures)('matches $file and reads its displayed scales', fixture => {
    const { file, id, bounds, pitch, divisions, scale, delay, channels } = fixture;
    const image = load(file);
    const result = analyzeCapture(image, file);
    const { grid } = result.detection;
    expect(result.detection.profileId).toBe(id);
    expect([grid.left, grid.top, grid.right, grid.bottom]).toEqual(bounds);
    expect([grid.pxPerHDiv, grid.pxPerVDiv]).toEqual(pitch);
    expect([grid.hDivs, grid.vDivs]).toEqual(divisions);
    expect(grid.fitErrorPx).toBeLessThan(0.5);
    expect(result.timebase).toMatchObject({ source: 'ocr', secPerDiv: expect.closeTo(scale, 14), triggerOffsetSec: expect.closeTo(delay, 14) });
    expect(result.traces.map(trace => [trace.channel, trace.settings.voltsPerDiv, Math.round(trace.settings.zeroY)])).toEqual(channels);
    expect(result.traces.every(trace => trace.settings.scaleSource === 'ocr' && trace.validCount >= grid.width * 0.94)).toBe(true);
    if ('referenceFrequency' in fixture) {
      const measured = result.measurements[0]?.frequencyHz ?? 0;
      expect(Math.abs(measured - fixture.referenceFrequency) / fixture.referenceFrequency).toBeLessThan(0.001);
    }
    for (const other of validateProfiles(configuration)) {
      if (other.id !== id) expect(detectProfile(image, { profileId: other.id }).profileId).toBe('universal-fallback');
    }

    const profile = validateProfiles(configuration).find(candidate => candidate.id === id)!;
    const withoutLogo = { ...image, data: image.data.slice() };
    paint(withoutLogo, profile.anchors.logoRoi, [0, 0, 0]);
    expect(detectProfile(withoutLogo).profileId).toBe('universal-fallback');
    const withoutGrid = { ...image, data: image.data.slice() };
    paint(withoutGrid, { x: grid.left, y: grid.top, width: grid.width + 1, height: grid.height + 1 }, [0, 0, 0]);
    expect(detectProfile(withoutGrid).profileId).toBe('universal-fallback');
  });

  test.each(['dsox.png', 'rtb.png', 'rigol-oos.png', 'tektronix-dpo4104b.png', 'visa-keysight.png'])('rejects nonmatching layouts in %s', name => {
    expect(detectProfile(load(name))).toMatchObject({ profileId: 'universal-fallback', matchedAnchors: [] });
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

const publicRoot = process.env.GRATICULE_WEB_FIXTURES;
describe.skipIf(!publicRoot)('downloaded public oscilloscope captures', () => {
  const capture = (name: string) => analyzePngBytes(readFileSync(join(publicRoot!, name)), name);

  test.each([
    ['rigol-pklaus.png', 'standard', 200e-6, 0, [['C1', 1]]],
    ['rigol-quickprint2.png', 'measure-1row', 2e-6, 50.1e-6, [['C1', 2], ['C2', 2]]],
    ['rigol-quickprint3.png', 'measure-1row', 20e-6, 312e-6, [['C1', 2], ['C2', 2]]],
    ['rigol-quickprint4.png', 'measure-1row', 200e-6, 1.272e-3, [['C1', 2], ['C2', 2]]],
    ['rigol-rogeorge-1.png', 'standard', 0.5, 1, [['C1', 2]]],
    ['rigol-rogeorge-2.png', 'standard', 0.5, 2.74, [['C1', 2]]],
    ['rigol-rogeorge-3.png', 'fft', 5e-3, 0, [['C1', 2], ['C4', 1]]],
    ['rigol-simple-grab.png', 'standard', 1e-6, 0, [['C1', 0.02]]],
    ['wavebin-rigol.png', 'standard', 1, 5.02, [['C1', 1]]],
  ] as const)('reads the Rigol layout, channels and timebase in %s', (name, layoutVariant, seconds, delay, channels) => {
    const result = capture(name);
    expect(result.detection).toMatchObject({ profileId: 'rigol-ds1054z', grid: { layoutVariant } });
    expect(result.timebase).toMatchObject({ source: 'ocr', secPerDiv: expect.closeTo(seconds, 12), triggerOffsetSec: expect.closeTo(delay, 12) });
    expect(result.traces.map(t => [t.channel, t.settings.voltsPerDiv])).toEqual(channels);
    expect(result.traces.every(t => t.settings.scaleSource === 'ocr' && t.settings.zeroSource === 'marker')).toBe(true);
    if (name === 'rigol-rogeorge-1.png') expect(result.traces[0]?.validCount).toBe(0);
    if (name === 'rigol-rogeorge-3.png') expect(result.measurements.map(m => m.frequencyHz)).toEqual([
      expect.closeTo(1000, 5), expect.closeTo(1000, 5),
    ]);
  });

  test('reads both compact Siglent layouts and omits current channels from the voltage results', () => {
    const mixed = capture('rudi-siglent.png');
    expect(mixed.detection).toMatchObject({
      profileId: 'siglent-sds2000x-plus', grid: { layoutVariant: 'measure-3row', bottom: 459 },
      warnings: ['unsupported_channel_unit:C2', 'unsupported_channel_unit:C4'],
    });
    expect(mixed.timebase).toMatchObject({ source: 'ocr', secPerDiv: 0.002 });
    expect(mixed.traces.map(t => [t.channel, t.settings.voltsPerDiv, t.settings.offsetVolts])).toEqual([
      ['C1', 20, 59], ['C3', 25, -1.25],
    ]);
    const decode = capture('siglent-pyftdi-373.png');
    expect(decode.detection).toMatchObject({
      profileId: 'siglent-sds2000x-plus', grid: { layoutVariant: 'decode-table', right: 872, bottom: 380 },
    });
    expect(decode.timebase).toMatchObject({ source: 'ocr', secPerDiv: expect.closeTo(20e-6, 12) });
    expect(decode.measurements.map(m => m.frequencyHz)).toEqual([null, null]);
    expect(decode.measurements[0]?.vpp).toBeCloseTo(3.47, 2);
  });

  test.each(['rudi-keysight.png', 'rudi-rohde.png'])('uses Universal Fallback for %s', name => {
    expect(capture(name).detection).toMatchObject({ profileId: 'universal-fallback', matchedAnchors: [] });
  });
});

test.each([
  ['-7.357mV', -7.357e-3], ['509uV', 509e-6], ['8µV', 8e-6], ['4V', 4], ['25ns', 25e-9], ['-300ps', -3e-10],
  ['500us', 5e-4], ['1,5ms', 1.5e-3], ['2s', 2], ['21Hz', 21], ['1.2kHz', 1200], ['10MHz', 1e7], ['50%', 50],
])('parses %s as an SI or percentage value', (text, value) => {
  expect(parseQuantity(text)?.value).toBeCloseTo(value, 13);
  expect(parseQuantity('9?9Hz')).toBeNull();
});
