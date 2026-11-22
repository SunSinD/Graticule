import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeBodeBatch, analyzePngBytes } from '../../src/core/pipeline.js';

interface AuditFile {
  readonly singleCaptures: {
    readonly sine_schmitt: {
      readonly fileName: string;
      readonly channels: Record<string, { readonly expected: { readonly vpp: number; readonly frequencyHz: number; readonly dutyCyclePct?: number } }>;
    };
    readonly zener_clip: {
      readonly fileName: string;
      readonly channels: Record<string, { readonly expected: { readonly vpp: number; readonly frequencyHz: number; readonly vmax: number; readonly vmin: number } }>;
    };
    readonly cursor_overlay: {
      readonly fileName: string;
      readonly channels: Record<string, { readonly expected: { readonly vpp: number; readonly vrms: number; readonly frequencyHz: number; readonly dutyCyclePct: number } }>;
    };
  };
  readonly bodeSweep: {
    readonly summary: {
      readonly passbandGainDbSineFit: number;
      readonly cutoffHzSineFitMinus3Db: number;
    };
    readonly points: ReadonlyArray<{
      readonly fileName: string;
      readonly nominalFrequencyHz: number;
      readonly vinVppSineFit: number;
      readonly voutVppSineFit: number;
      readonly gainDbSineFit: number;
      readonly phaseDeg: number;
    }>;
  };
}

const root = resolve(process.cwd());
const audit = JSON.parse(readFileSync(resolve(root, 'tests/fixtures/manual-audit.json'), 'utf8')) as AuditFile;
const cursorPath = process.env.GRATICULE_CURSOR_PNG;

function relError(actual: number, expected: number): number {
  return Math.abs(actual - expected) / Math.max(Math.abs(expected), 1e-9);
}

describe('independent manual graticule audit agreement (<= 3%)', () => {
  it('matches sine_schmitt.png manual graticule values within 3%', () => {
    const bytes = new Uint8Array(readFileSync(resolve(root, 'public/samples/sine_schmitt.png')));
    const res = analyzePngBytes(bytes, 'sine_schmitt.png');
    for (const ch of ['C1', 'C2'] as const) {
      const m = res.measurements.find((x) => x.channel === ch);
      const exp = audit.singleCaptures.sine_schmitt.channels[ch]!.expected;
      expect(m?.vpp).not.toBeNull();
      expect(m?.frequencyHz).not.toBeNull();
      expect(relError(m!.vpp!, exp.vpp)).toBeLessThanOrEqual(0.03);
      expect(relError(m!.frequencyHz!, exp.frequencyHz)).toBeLessThanOrEqual(0.03);
    }
    const c2 = res.measurements.find((x) => x.channel === 'C2');
    expect(Math.abs(c2!.dutyCyclePct! - audit.singleCaptures.sine_schmitt.channels.C2!.expected.dutyCyclePct!)).toBeLessThanOrEqual(2.0);
  });

  it('matches zener_clip.png manual graticule values within 3%', () => {
    const bytes = new Uint8Array(readFileSync(resolve(root, 'public/samples/zener_clip.png')));
    const res = analyzePngBytes(bytes, 'zener_clip.png');
    const c1 = res.measurements.find((x) => x.channel === 'C1');
    const c2 = res.measurements.find((x) => x.channel === 'C2');
    const exp1 = audit.singleCaptures.zener_clip.channels.C1!.expected;
    const exp2 = audit.singleCaptures.zener_clip.channels.C2!.expected;
    expect(relError(c1!.vpp!, exp1.vpp)).toBeLessThanOrEqual(0.03);
    expect(relError(c2!.vpp!, exp2.vpp)).toBeLessThanOrEqual(0.03);
    expect(relError(c2!.frequencyHz!, exp2.frequencyHz)).toBeLessThanOrEqual(0.03);
  });

  it('matches all 10 sweep captures gain, phase, passband, and -3 dB cutoff within 3%', () => {
    const inputs = audit.bodeSweep.points.map((p) => ({
      fileName: p.fileName,
      bytes: new Uint8Array(readFileSync(resolve(root, 'public/samples', p.fileName))),
    }));
    const bode = analyzeBodeBatch(inputs);
    expect(bode.acceptedCount).toBe(10);
    expect(bode.rejectedCount).toBe(0);
    expect(Math.abs(bode.passbandGainDb! - audit.bodeSweep.summary.passbandGainDbSineFit)).toBeLessThanOrEqual(0.15);
    expect(relError(bode.cutoffHz!, audit.bodeSweep.summary.cutoffHzSineFitMinus3Db)).toBeLessThanOrEqual(0.03);

    for (const exp of audit.bodeSweep.points) {
      const pt = bode.points.find((p) => p.fileName === exp.fileName);
      expect(pt?.accepted).toBe(true);
      expect(relError(pt!.vinVpp!, exp.vinVppSineFit)).toBeLessThanOrEqual(0.03);
      expect(relError(pt!.voutVpp!, exp.voutVppSineFit)).toBeLessThanOrEqual(0.03);
      expect(Math.abs(pt!.gainDb! - exp.gainDbSineFit)).toBeLessThanOrEqual(0.25);
      expect(Math.abs(pt!.phaseDeg! - exp.phaseDeg)).toBeLessThanOrEqual(2.0);
    }
  });

  it.skipIf(!cursorPath || !existsSync(cursorPath))('matches cursor-overlay local capture after cursor masking', () => {
    const bytes = new Uint8Array(readFileSync(cursorPath!));
    const res = analyzePngBytes(bytes, 'SDS2104X_Plus_PNG_10.png');
    for (const ch of ['C1', 'C2'] as const) {
      const m = res.measurements.find((x) => x.channel === ch);
      const exp = audit.singleCaptures.cursor_overlay.channels[ch]!.expected;
      expect(relError(m!.vrms!, exp.vrms)).toBeLessThanOrEqual(0.01);
      expect(relError(m!.frequencyHz!, exp.frequencyHz)).toBeLessThanOrEqual(0.01);
      expect(relError(m!.vpp!, exp.vpp)).toBeLessThanOrEqual(0.06);
    }
  });
});
