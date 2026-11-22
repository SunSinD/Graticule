export interface Point {
  readonly x: number;
  readonly y: number;
}

/** Corners in top-left, top-right, bottom-right, bottom-left order. */
export type Quad = readonly [Point, Point, Point, Point];

export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  /** Row-major RGBA bytes, length === width * height * 4 */
  readonly data: Uint8ClampedArray;
}

export type ProfileId = 'siglent-sds2000x-plus' | 'rigol-ds1054z' | 'siglent-sds1000x-e'
  | 'rigol-dho924' | 'rohde-schwarz-rtb2004' | 'tektronix-dpo7104c'
  | 'siglent-sds800x-hd' | 'keysight-dsox1000' | 'universal-fallback';

export type ChannelId = 'C1' | 'C2' | 'C3' | 'C4';

export type LayoutVariant = 'no-measure' | 'measure-1row' | 'measure-2row' | 'measure-3row'
  | 'measure-stats' | 'decode-table' | 'standard' | 'fft' | 'manual';

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface GridGeometry {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
  readonly hDivs: number;
  readonly vDivs: number;
  readonly pxPerHDiv: number;
  readonly pxPerVDiv: number;
  readonly centerX: number;
  readonly centerY: number;
  readonly vLines: readonly number[];
  readonly hLines: readonly number[];
  readonly layoutVariant: LayoutVariant;
  readonly inverted: boolean;
  readonly fitErrorPx: number;
}

export interface ProfileDetection {
  readonly profileId: ProfileId;
  readonly profileName: string;
  readonly matchedAnchors: readonly string[];
  readonly confidence: number;
  readonly fallbackReason: string | null;
  readonly grid: GridGeometry;
  readonly digitalOnly: boolean;
  readonly warnings: readonly string[];
}

export interface ChannelSettings {
  readonly channel: ChannelId;
  readonly enabled: boolean;
  readonly voltsPerDiv: number;
  readonly offsetVolts: number;
  readonly zeroY: number;
  readonly probeAttenuation: number;
  readonly coupling: 'DC' | 'AC' | 'GND' | 'UNKNOWN';
  readonly scaleSource: 'ocr' | 'manual' | 'default';
  readonly zeroSource: 'card-offset' | 'marker' | 'manual' | 'default';
  readonly rawScaleText: string | null;
  readonly rawOffsetText: string | null;
}

export interface TimebaseSettings {
  readonly secPerDiv: number;
  readonly triggerOffsetSec: number;
  readonly source: 'ocr' | 'manual' | 'default';
  readonly rawText: string | null;
}

export type GapStatus =
  | 'ok'
  | 'clipped_high'
  | 'clipped_low'
  | 'masked_cursor'
  | 'masked_overlay'
  | 'overlap_ambiguous'
  | 'unresolved';

export interface TraceSample {
  readonly col: number;
  readonly xPx: number;
  readonly yPx: number | null;
  readonly timeSec: number;
  readonly voltage: number | null;
  readonly status: GapStatus;
}

export interface ChannelTrace {
  readonly channel: ChannelId;
  readonly settings: ChannelSettings;
  readonly samples: readonly TraceSample[];
  readonly validCount: number;
  readonly clippedCount: number;
  readonly maskedCount: number;
  readonly overlapCount: number;
  readonly unresolvedCount: number;
  readonly medianThicknessPx: number;
}

export interface ScopeMeasureReading {
  readonly label: string;
  readonly metric: 'vpp' | 'vmax' | 'vmin' | 'vavg' | 'vrms' | 'amplitude' | 'freq' | 'period' | 'duty' | 'other';
  readonly channel: ChannelId | null;
  readonly value: number | null;
  readonly unit: string;
  readonly rawText: string;
}

export interface ChannelMeasurements {
  readonly channel: ChannelId;
  readonly vpp: number | null;
  readonly vmax: number | null;
  readonly vmin: number | null;
  readonly vavg: number | null;
  readonly vrms: number | null;
  readonly periodSec: number | null;
  readonly frequencyHz: number | null;
  readonly dutyCyclePct: number | null;
  readonly completeCycles: number;
  readonly clipped: boolean;
  readonly riseTimeSec?: number | null;
  readonly fallTimeSec?: number | null;
  readonly overshootPct?: number | null;
  readonly riseLimited?: boolean;
  readonly fallLimited?: boolean;
}

export interface ScopeComparisonRow {
  readonly channel: ChannelId | null;
  readonly metric: string;
  readonly unit: string;
  readonly scopeValue: number;
  readonly graticuleValue: number | null;
  readonly delta: number | null;
  readonly deltaPct: number | null;
}

export interface PhaseMeasurement {
  readonly refChannel: ChannelId;
  readonly targetChannel: ChannelId;
  readonly phaseDeg: number | null;
  readonly frequencyHz: number | null;
  readonly r2Ref: number | null;
  readonly r2Target: number | null;
  readonly completeCycles: number;
  readonly reason: string | null;
}

export interface ExtractionOverrides {
  readonly profileId?: ProfileId;
  readonly manualCrop?: Rect;
  readonly manualQuad?: Quad;
  readonly hDivs?: number;
  readonly vDivs?: number;
  readonly secPerDiv?: number;
  readonly triggerOffsetSec?: number;
  readonly channels?: Partial<Record<ChannelId, {
    readonly enabled?: boolean;
    readonly voltsPerDiv?: number;
    readonly offsetVolts?: number;
    readonly zeroY?: number;
  }>>;
}

export interface ExtractionResult {
  readonly fileName: string;
  readonly imageWidth: number;
  readonly imageHeight: number;
  readonly sourceWidth?: number;
  readonly sourceHeight?: number;
  readonly sourceQuad?: Quad;
  readonly detection: ProfileDetection;
  readonly timebase: TimebaseSettings;
  readonly topFrequencyHz: number | null;
  readonly topFrequencyRaw: string | null;
  readonly traces: readonly ChannelTrace[];
  readonly measurements: readonly ChannelMeasurements[];
  readonly phaseC1ToC2: PhaseMeasurement | null;
  readonly scopeReadings: readonly ScopeMeasureReading[];
  readonly comparisons: readonly ScopeComparisonRow[];
  readonly maskCoveragePct: number;
  readonly elapsedMs: number;
}

export interface BodeGateOptions {
  readonly inputChannel?: ChannelId;
  readonly outputChannel?: ChannelId;
  readonly minCycles?: number;
  readonly minColsPerCycle?: number;
  readonly minPeakToPeakPx?: number;
  readonly minR2?: number;
  readonly preferManualFrequency?: boolean;
}

export interface BodeRejectedCapture {
  readonly fileName: string;
  readonly rejectionReason: string;
}

export interface BodePointOverride {
  readonly frequencyHz?: number;
  readonly vinVpp?: number;
  readonly voutVpp?: number;
  readonly gainDb?: number;
  readonly phaseDeg?: number;
  readonly excluded?: boolean;
}

export interface BodePoint {
  readonly id: string;
  readonly fileName: string;
  readonly frequencyHz: number | null;
  readonly frequencySource: 'scope' | 'waveform' | 'filename' | 'manual' | 'none';
  readonly vinVpp: number | null;
  readonly voutVpp: number | null;
  readonly gainDb: number | null;
  readonly phaseDeg: number | null;
  readonly cycles: number;
  readonly colsPerCycle: number;
  readonly vinPx: number;
  readonly voutPx: number;
  readonly r2In: number | null;
  readonly r2Out: number | null;
  readonly accepted: boolean;
  readonly rejectionReasons: readonly string[];
  readonly warnings: readonly string[];
  readonly edited: boolean;
  readonly override?: BodePointOverride;
  readonly preferManualFrequency?: boolean;
  readonly baseReason?: string;
  readonly extraction: ExtractionResult | null;
}

export interface BodeResult {
  readonly inputChannel: ChannelId;
  readonly outputChannel: ChannelId;
  readonly points: readonly BodePoint[];
  readonly passbandGainDb: number | null;
  readonly cutoffHz: number | null;
  readonly cutoffLowHz?: number | null;
  readonly cutoffHighHz?: number | null;
  readonly cutoffTargetDb: number | null;
  readonly acceptedCount: number;
  readonly rejectedCount: number;
  readonly elapsedMs: number;
  readonly gateOptions?: BodeGateOptions;
}

export type Locale = 'en' | 'fr';

export type PlotTheme = 'light' | 'dark';

/** Fractions measured from the left and top edges of the plot. */
export interface PlotCursors {
  readonly x1: number;
  readonly x2: number;
  readonly y1: number;
  readonly y2: number;
  readonly channel: ChannelId;
}

export interface SvgExportOptions {
  readonly title?: string;
  readonly locale?: Locale;
  readonly width?: number;
  readonly height?: number;
  readonly showGrid?: boolean;
  readonly showLegend?: boolean;
  readonly theme?: PlotTheme;
  readonly cursors?: PlotCursors;
  readonly channelLabels?: Partial<Record<ChannelId, string>>;
}
