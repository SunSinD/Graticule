import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { extractTraces, makeTimebase } from '../../src/core/extract.js';
import { rasterFonts } from '../../src/core/font/rasterFonts.js';
import { buildOverlayMask } from '../../src/core/mask.js';
import { readScopeMetadata } from '../../src/core/ocr.js';
import { analyzeCapture } from '../../src/core/pipeline.js';
import { decodePng } from '../../src/core/png.js';
import { detectProfile, getNativeProfile, makeGrid } from '../../src/core/profiles.js';
import type { ProfileDetection, RgbaImage } from '../../src/core/types.js';
import { bitmap, paint, pixel } from './fixtures.js';
import type { Rgb } from './fixtures.js';

function rasterCapture(id: 'keysight-dsox1000' | 'siglent-sds800x-hd') {
  const profile = getNativeProfile(id)!;
  const { left, right, top, hDivs, vDivs, variants } = profile.graticule;
  const variant = variants[0]!;
  const grid = makeGrid(left, top, right, variant.bottom, hDivs, vDivs, variant.id, false);
  const detection: ProfileDetection = { profileId: id, profileName: profile.name, grid,
    confidence: 1, matchedAnchors: [], fallbackReason: null, digitalOnly: false, warnings: [] };
  const image = bitmap(profile.width, profile.height);
  const read = () => readScopeMetadata(image, detection);
  const extract = (overrides = {}) => {
    const metadata = read();
    return extractTraces(image, detection, metadata, buildOverlayMask(image, grid, id), makeTimebase(metadata, overrides), overrides).traces;
  };
  return { image, read, extract, grid };
}

function paintText(image: RgbaImage, x: number, y: number, color: Rgb, text: string) {
  for (const char of text) {
    const glyph = Object.entries(rasterFonts['siglent-sds800x-hd'].glyphs).find(([, value]) => value === char)![0].split('/');
    for (const [row, ink] of glyph.entries()) {
      for (const [col, dot] of [...ink].entries()) if (dot === '#') pixel(image, x + col, y + row, color);
    }
    x += glyph[0]!.length + 1;
  }
}

test('keeps a Keysight channel with an unreadable scale and no visible zero marker', () => {
  const { image, read, extract, grid } = rasterCapture('keysight-dsox1000');
  paint(image, { x: 110, y: 24, width: 10, height: 6 }, [255, 255, 255]);
  paint(image, { x: 500, y: 24, width: 10, height: 6 }, [255, 255, 255]);
  paint(image, { x: grid.left, y: grid.top + 20, width: grid.width + 1, height: 1 }, [0, 210, 0]);
  const metadata = read();
  expect(metadata.cards.get('C2')).toMatchObject({ voltsPerDiv: null, rawScaleText: null });
  expect(metadata.rawTimebase).toBeNull();
  expect(extract()).toMatchObject([{ channel: 'C2', settings: { scaleSource: 'default', zeroSource: 'default' }, validCount: grid.width + 1 }]);
});

test('falls back from malformed Siglent probe text and filters unreadable offset text', () => {
  const { image, read } = rasterCapture('siglent-sds800x-hd');
  paintText(image, 9, 540, [255, 255, 0], 'C1');
  paintText(image, 4, 558, [255, 255, 255], '..X');
  paint(image, { x: 46, y: 575, width: 9, height: 6 }, [255, 255, 255]);
  expect(read().cards.get('C1')).toMatchObject({ probeAttenuation: 1, rawOffsetText: null });
  paint(image, { x: 4, y: 557, width: 40, height: 16 }, [0, 0, 0]);
  paintText(image, 4, 558, [255, 255, 255], '2.5X');
  expect(read().cards.get('C1')?.probeAttenuation).toBe(2.5);
});

test('keeps a Siglent waveform edge near the trigger lane and masks a real arrow shape', () => {
  const { image, extract, grid } = rasterCapture('siglent-sds800x-hd');
  const ink = [255, 255, 0] as const;
  const y = grid.top + 85;
  const base = grid.right - 1;
  const overrides = { channels: { C1: { enabled: true } } };
  paint(image, { x: grid.left, y, width: base - grid.left, height: 1 }, ink);
  paint(image, { x: base, y: y - 10, width: 1, height: 11 }, ink);
  pixel(image, grid.right, y - 10, ink);
  const edge = extract(overrides)[0]!;
  expect(edge.samples.slice(-9).every(sample => sample.status === 'ok')).toBe(true);

  paint(image, { x: grid.right - 12, y: y - 10, width: 13, height: 11 }, [0, 0, 0]);
  for (let dy = -7; dy <= 7; dy++) {
    const tip = base - 8 + Math.abs(dy);
    paint(image, { x: tip, y: y + dy, width: base - tip + 1, height: 1 }, ink);
  }
  const badge = extract(overrides)[0]!;
  expect(badge.samples[base - grid.left]?.status).toBe('masked_overlay');
  expect(badge.samples[grid.right - 9 - grid.left]?.status).toBe('masked_overlay');
});

const folder = process.env.GRATICULE_V11_SCOPE_FIXTURES;
const siglentTopic = 'https://www.eevblog.com/forum/testgear/sds800x-hd-review-demonstration-thread/';
const keysightTopic = 'https://www.eevblog.com/forum/beginners/show-ascii-for-i2c-on-keysight-dsox1204g/';
const attach = (topic: string, id: number) => topic + '?action=dlattach;attach=' + id + ';image';

// Save the original attachments under these filenames to run these tests offline.
const captures = [
  { file: 'siglent-pulse.png', url: attach(siglentTopic, 1989022), id: 'siglent-sds800x-hd',
    layout: 'measure-stats', bounds: [19, 49, 1019, 329], seconds: 20e-9, delay: 60e-9,
    channels: [['C3', 0.1, 189], ['C4', 0.1, 189]] },
  { file: '1989028.png', url: attach(siglentTopic, 1989028), id: 'siglent-sds800x-hd',
    layout: 'measure-stats', bounds: [19, 49, 1019, 329], seconds: 20e-9, delay: 60e-9,
    channels: [['C1', 0.1, 189], ['C2', 0.1, 189], ['C3', 0.1, 189], ['C4', 0.1, 189]] },
  { file: 'keysight-time.png', url: attach(keysightTopic, 1211383), id: 'keysight-dsox1000',
    layout: 'standard', bounds: [17, 42, 657, 442], seconds: 5e-3, delay: 3e-3,
    channels: [['C1', 2, 215], ['C4', 2, 415]] },
  { file: 'keysight-decode.png', url: attach(keysightTopic, 1211387), id: 'keysight-dsox1000',
    layout: 'decode-table', bounds: [17, 242, 657, 442], seconds: 5e-3, delay: 3e-3,
    channels: [['C1', 2, 328], ['C4', 2, 428]] },
] as const;

const unsupported = [
  { file: 'siglent-zoom.png', url: attach(siglentTopic, 1989016) },
  { file: 'siglent-fft.png', url: attach(siglentTopic, 1988992) },
  { file: 'siglent-four.png', url: attach(siglentTopic, 1989052) },
  { file: 'rigol-xy.png', url: 'https://raw.githubusercontent.com/lukasferreira1989/blacksmith-curvetracer/main/docs/images/mso5074-xy-screen.png' },
  { file: 'rigol-modal.png', url: attach('https://www.eevblog.com/forum/testgear/review-rigol-mso5000-tests-bugs-questions/', 765051) },
] as const;

describe.skipIf(!folder)('v1.1 instrument originals', () => {
  const load = ({ file, url }: { file: string; url: string }) => {
    try {
      return decodePng(readFileSync(join(folder!, file)));
    } catch (error) {
      throw new Error('Could not load ' + file + ' from ' + folder + ' (source ' + url + ')', { cause: error });
    }
  };

  test.each(captures)('calibrates $file using native metadata', fixture => {
    const { file, id, layout, bounds, seconds, delay, channels } = fixture;
    const image = load(fixture);
    const result = analyzeCapture(image, file);
    const { grid } = result.detection;
    expect(result.detection).toMatchObject({ profileId: id, grid: { layoutVariant: layout } });
    expect([grid.left, grid.top, grid.right, grid.bottom]).toEqual(bounds);
    expect(result.timebase).toMatchObject({ secPerDiv: expect.closeTo(seconds, 13), triggerOffsetSec: expect.closeTo(delay, 13), source: 'ocr' });
    expect(result.traces.map(({ channel, settings }) => [channel, settings.voltsPerDiv, settings.zeroY])).toEqual(channels);
    expect(result.traces.every(({ settings }) => settings.scaleSource === 'ocr')).toBe(true);
    expect(result.traces.at(-1)!.validCount).toBeGreaterThan(grid.width * 0.9);

    if (id === 'siglent-sds800x-hd') {
      const pulse = result.measurements.find(measurement => measurement.channel === 'C4')!;
      expect(pulse.frequencyHz).toBeGreaterThan(9.98e6);
      expect(pulse.frequencyHz).toBeLessThan(10.02e6);
      expect(pulse.riseTimeSec).toBeGreaterThan(1e-9);
      expect(pulse.vpp).toBeGreaterThan(0.55);
      if (file === 'siglent-pulse.png') {
        expect(result.measurements[0]?.vpp).toBeLessThan(0.005);
        expect(pulse.riseTimeSec).toBeLessThan(2.5e-9);
      }
    } else {
      expect(result.measurements.map(measurement => measurement.frequencyHz)).toEqual([null, null]);
    }

    const logo = getNativeProfile(id)!.anchors.logoRoi;
    paint(image, logo, [0, 0, 0]);
    expect(detectProfile(image).profileId).toBe('universal-fallback');
  });

  test.each(unsupported)('keeps $file outside the native profiles', fixture => {
    expect(detectProfile(load(fixture))).toMatchObject({ profileId: 'universal-fallback', matchedAnchors: [] });
  });
});
