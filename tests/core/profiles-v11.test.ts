import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { analyzeCapture } from '../../src/core/pipeline.js';
import { decodePng } from '../../src/core/png.js';
import { detectProfile, getNativeProfile } from '../../src/core/profiles.js';
import { paint } from './fixtures.js';

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
