import { describe, expect, test } from 'vitest';
import { measureChannel } from '../../src/core/measurements.js';
import type { ChannelTrace, TraceSample } from '../../src/core/types.js';

const dt = 1e-6;

function measure(values: readonly (number | TraceSample['status'])[]) {
  const samples: TraceSample[] = values.map((value, col) => ({
    col, xPx: col, timeSec: col * dt, voltage: typeof value === 'number' ? value : null,
    yPx: typeof value === 'number' ? 100 - value * 50 : null, status: typeof value === 'number' ? 'ok' : value,
  }));
  const trace: ChannelTrace = {
    channel: 'C1', settings: { channel: 'C1', enabled: true, zeroY: 100, voltsPerDiv: 1, probeAttenuation: 1,
      offsetVolts: 0, coupling: 'DC', scaleSource: 'manual', zeroSource: 'manual', rawScaleText: null, rawOffsetText: null },
    samples, validCount: samples.filter(s => s.status === 'ok').length, maskedCount: 0, overlapCount: 0,
    unresolvedCount: 0, clippedCount: samples.filter(s => s.status.startsWith('clipped')).length, medianThicknessPx: 1,
  };
  return measureChannel(trace, 50);
}

describe('period and pulse measurements', () => {
  test.each([1, 3, 5])('measures a repeating pulse with %i%% duty', duty => {
    const result = measure(Array.from({ length: 1001 }, (_, i) => i % 100 < duty ? 1 : 0));
    expect(result.frequencyHz).toBeCloseTo(10_000, 6);
    expect(result.dutyCyclePct).toBeCloseTo(duty, 6);
  });

  test.each(['masked_overlay', 'masked_cursor', 'unresolved', 'clipped_high'] as const)(
    'never derives a period from crossings across %s columns', gap => {
      const wave = (i: number) => Math.sin(i * Math.PI / 40);
      const alternating = measure(Array.from({ length: 801 }, (_, i) => i % 160 >= 76 && i % 160 <= 82 ? gap : wave(i)));
      expect(alternating.frequencyHz).toBeCloseTo(12_500, 5);
      const everyCycle = measure(Array.from({ length: 801 }, (_, i) => i % 80 === 0 ? gap : wave(i)));
      expect(everyCycle.frequencyHz).toBeNull();
      expect(everyCycle.clipped).toBe(gap === 'clipped_high');
    },
  );

  test('times visible falling edges when only one column at each rising edge is missing', () => {
    const result = measure(Array.from({ length: 601 }, (_, i) =>
      i % 100 === 0 ? 'unresolved' : i % 100 < 50 ? 1 : 0));
    expect(result.frequencyHz).toBeCloseTo(10_000, 6);
    expect(result.dutyCyclePct).toBeNull();
    expect(result.riseTimeSec).toBeNull();
  });
});

describe('step edge measurements', () => {
  test('uses the local levels for 10–90% rise, 90–10% fall and overshoot', () => {
    const signal = [
      ...Array.from({ length: 30 }, (_, i) => (i % 3 - 1) * 0.004),
      ...Array.from({ length: 10 }, (_, i) => (i + 1) / 10),
      1.2, 1.1, 1.03,
      ...Array.from({ length: 35 }, (_, i) => 1 + (i % 3 - 1) * 0.004),
      ...Array.from({ length: 20 }, (_, i) => (19 - i) / 20),
      ...Array<number>(30).fill(0),
    ];
    const result = measure(signal);
    expect(result.riseTimeSec).toBeCloseTo(8 * dt, 8);
    expect(result.fallTimeSec).toBeCloseTo(16 * dt, 8);
    expect(result.overshootPct).toBeCloseTo(20, 1);
    expect(result).toMatchObject({ riseLimited: false, fallLimited: false });
  });

  test('reports a two-column limit for instantaneous edges', () => {
    const result = measure([...Array<number>(24).fill(0), ...Array<number>(24).fill(1), ...Array<number>(24).fill(0)]);
    expect(result).toMatchObject({ riseTimeSec: 2 * dt, fallTimeSec: 2 * dt, riseLimited: true, fallLimited: true, overshootPct: 0 });
  });

  test('times both edges of a three-column high pulse', () => {
    const result = measure(Array.from({ length: 1000 }, (_, i) => i % 100 >= 25 && i % 100 < 28 ? 1 : 0));
    expect(result).toMatchObject({ riseTimeSec: 2 * dt, fallTimeSec: 2 * dt, overshootPct: 0 });
  });

  test('uses the settled voltage of a damped step to measure overshoot', () => {
    const damping = 0.2;
    const dampedFrequency = Math.sqrt(1 - damping ** 2);
    const response = Array.from({ length: 500 }, (_, i) => {
      const phase = i * Math.PI / 20;
      return 1 - Math.exp(-damping * phase / dampedFrequency)
        * (Math.cos(phase) + damping / dampedFrequency * Math.sin(phase));
    });
    const result = measure([...Array<number>(40).fill(0), ...response]);
    expect(result.overshootPct).toBeCloseTo(52.66, 2);
    expect(result.fallTimeSec).toBeNull();
  });

  test('interprets a flat overshoot lobe followed by settling as a single rising edge', () => {
    const result = measure([...Array<number>(30).fill(0), ...Array<number>(6).fill(1.4), ...Array<number>(30).fill(1)]);
    expect(result.overshootPct).toBeCloseTo(40, 8);
    expect(result.riseTimeSec).toBeCloseTo(2 * dt, 12);
    expect(result.fallTimeSec).toBeNull();
  });

  test('uses the settled voltage after flat overshoot and undershoot lobes', () => {
    const result = measure([
      ...Array<number>(30).fill(-12), ...Array<number>(6).fill(-5.6),
      ...Array<number>(4).fill(-9.4), ...Array<number>(40).fill(-8),
    ]);
    expect(result.overshootPct).toBeCloseTo(60, 10);
    expect(result.riseTimeSec).toBeCloseTo(2 * dt, 12);
    expect(result.fallTimeSec).toBeNull();
  });

  test.each([10, 20, 30, 151])('withholds edges for a five-pixel quantized cosine at %i columns per cycle', period => {
    const wave = Array.from({ length: period * 4 }, (_, i) => Math.round(2.5 * (1 + Math.cos(2 * Math.PI * i / period))) / 50);
    const result = measure(wave);
    expect(result.frequencyHz).toBeCloseTo(1 / (dt * period), 0);
    expect(result).toMatchObject({ riseTimeSec: null, fallTimeSec: null, overshootPct: null });
  });

  test.each([12, 80, 240])('rejects smooth cosine and triangle steps at %i columns per cycle', period => {
    const values = Array.from({ length: period * 4 }, (_, i) => i / period);
    for (const wave of [values.map(cycle => Math.cos(2 * Math.PI * cycle)),
      values.map(cycle => 4 * Math.abs(cycle % 1 - 0.5) - 1)]) {
      expect(measure(wave)).toMatchObject({ riseTimeSec: null, fallTimeSec: null, overshootPct: null });
    }
  });

  test.each([1e155, 1e308])('keeps RMS finite and rare extreme samples safe at %s V', voltage => {
    const result = measure(Array.from({ length: 300 }, (_, i) => i % 100 < 3 ? voltage : -voltage));
    expect(result.vrms).toBe(voltage);
    expect(result.vavg! / voltage).toBeCloseTo(-0.94, 12);
    expect(result.vpp).toBe(voltage === 1e308 ? null : 2 * voltage);
  });

  test('withholds step metrics for a smooth sine and an obscured transition', () => {
    const sine = measure(Array.from({ length: 600 }, (_, i) => Math.sin(2 * Math.PI * i / 151)));
    const masked = measure([...Array<number>(25).fill(0), 0.25, 'masked_overlay', 0.75, ...Array<number>(25).fill(1)]);
    const clipped = measure([...Array<number>(25).fill(0), 0.2, 0.8, 'clipped_high', ...Array<number>(25).fill(1)]);
    for (const result of [sine, masked, clipped]) {
      expect(result).toMatchObject({ riseTimeSec: null, fallTimeSec: null, overshootPct: null, riseLimited: false, fallLimited: false });
    }
    expect(clipped.clipped).toBe(true);
  });
});
