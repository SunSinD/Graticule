import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { ArrowLeftRight, Crop } from 'lucide-react';
import type { ExtractionOverrides, ExtractionResult, Locale, MathTraceResult, PlotCursors, Quad, Rect, XyAxisId } from '../../core/types';
import type { SpectrumWindow } from '../../core/spectrum';
import { renderOverlaySvg, renderWaveformSvg, waveformFrame } from '../../core/export/svg';
import { validateQuad } from '../../core/deskew';
import type { Dict } from '../i18n';
import type { ChannelLabels } from '../history';
import { CropBox, QuadBox } from './CropBox';
import { CursorOverlay, CursorReadout } from './Cursors';
import { svgRatio, useCtrlWheelZoom, ZoomControl } from './ZoomControl';

export type CaptureMode = 'original' | 'overlay' | 'clean' | 'xy' | 'fft';
export type SpectrumScale = 'dbv' | 'linear';

export interface AxisOption {
  readonly id: XyAxisId;
  readonly label: string;
}

export interface XyControls {
  readonly axes: readonly AxisOption[];
  readonly x: XyAxisId;
  readonly y: XyAxisId;
  readonly svg: string;
  readonly onAxes: (x: XyAxisId, y: XyAxisId) => void;
}

export interface FftControls {
  readonly axes: readonly AxisOption[];
  readonly channel: XyAxisId;
  readonly window: SpectrumWindow;
  readonly scale: SpectrumScale;
  readonly svg: string;
  readonly onChannel: (channel: XyAxisId) => void;
  readonly onWindow: (window: SpectrumWindow) => void;
  readonly onScale: (scale: SpectrumScale) => void;
}

const WINDOWS: readonly SpectrumWindow[] = ['hann', 'rect', 'flattop', 'blackman'];
export type CropMode = 'rect' | 'quad';

const ZOOM_MAX = 300;

interface Props {
  readonly tx: Dict;
  readonly locale: Locale;
  readonly dark: boolean;
  readonly url: string;
  readonly fileName: string;
  readonly title: string;
  readonly channelLabels: ChannelLabels | undefined;
  readonly result: ExtractionResult | null;
  readonly extracting: boolean;
  readonly view: CaptureMode;
  readonly math: MathTraceResult | null;
  readonly xy: XyControls | null;
  readonly fft: FftControls | null;
  readonly cropOpen: boolean;
  readonly canCrop: boolean;
  readonly isPhoto: boolean;
  readonly forceQuad: boolean;
  readonly overrides: ExtractionOverrides;
  readonly cursors: PlotCursors | null;
  readonly onExtract: (() => void) | null;
  readonly onView: (view: CaptureMode) => void;
  readonly onCursors: (() => void) | null;
  readonly onCursorsChange: (cursors: PlotCursors) => void;
  readonly onCropOpen: (open: boolean) => void;
  readonly onApplyCrop: (crop: Rect, hDivs: number, vDivs: number) => void;
  readonly onApplyQuad: (quad: Quad, hDivs: number, vDivs: number) => void;
}

interface Size {
  readonly width: number;
  readonly height: number;
}

function sourceSize(result: ExtractionResult): Size {
  return { width: result.sourceWidth ?? result.imageWidth, height: result.sourceHeight ?? result.imageHeight };
}

function initialRect(result: ExtractionResult | null, overrides: ExtractionOverrides, size: Size): Rect {
  if (overrides.manualCrop) return overrides.manualCrop;
  const quad = result?.sourceQuad ?? overrides.manualQuad;
  if (quad) {
    const xs = quad.map((p) => p.x);
    const ys = quad.map((p) => p.y);
    const x = Math.max(0, Math.round(Math.min(...xs)));
    const y = Math.max(0, Math.round(Math.min(...ys)));
    return {
      x,
      y,
      width: Math.max(4, Math.min(size.width, Math.round(Math.max(...xs))) - x),
      height: Math.max(4, Math.min(size.height, Math.round(Math.max(...ys))) - y),
    };
  }
  const g = result?.detection.grid;
  if (g && g.width > 4 && g.height > 4 && g.right <= size.width + 1 && g.bottom <= size.height + 1) {
    return { x: g.left, y: g.top, width: g.width, height: g.height };
  }
  return { x: 0, y: 0, width: size.width, height: size.height };
}

function initialQuad(result: ExtractionResult | null, overrides: ExtractionOverrides, size: Size): Quad {
  if (overrides.manualQuad && validateQuad(overrides.manualQuad, size.width, size.height)) return overrides.manualQuad;
  if (result?.sourceQuad && validateQuad(result.sourceQuad, size.width, size.height)) return result.sourceQuad;
  let r = initialRect(result, overrides, size);
  if (r.x === 0 && r.y === 0 && r.width === size.width && r.height === size.height) {
    const mx = Math.round(size.width * 0.08);
    const my = Math.round(size.height * 0.08);
    r = { x: mx, y: my, width: size.width - 2 * mx, height: size.height - 2 * my };
  }
  return [
    { x: r.x, y: r.y },
    { x: r.x + r.width, y: r.y },
    { x: r.x + r.width, y: r.y + r.height },
    { x: r.x, y: r.y + r.height },
  ];
}

function intOr(text: string, fallback: number): number {
  const v = Number.parseInt(text, 10);
  return Number.isFinite(v) && v >= 1 && v <= 40 ? v : fallback;
}

export function CaptureView(props: Props) {
  const { tx, locale, dark, url, fileName, title, channelLabels, result, extracting, view, math, xy, fft, cropOpen, canCrop, overrides, onExtract } =
    props;
  const [size, setSize] = useState<Size | null>(result ? sourceSize(result) : null);
  const [rect, setRect] = useState<Rect | null>(null);
  const [quad, setQuad] = useState<Quad | null>(null);
  const [cropMode, setCropMode] = useState<CropMode>('rect');
  const [hText, setHText] = useState('10');
  const [vText, setVText] = useState('8');
  const [zoom, setZoom] = useState(100);
  const viewport = useRef<HTMLDivElement>(null);
  const edited = useRef(false);
  useCtrlWheelZoom(viewport, zoom, ZOOM_MAX, setZoom);

  useEffect(() => {
    if (result) setSize(sourceSize(result));
  }, [result]);

  useEffect(() => {
    edited.current = false;
    if (!cropOpen || !size) {
      setRect(null);
      setQuad(null);
      return;
    }
    setRect(initialRect(result, overrides, size));
    setQuad(initialQuad(result, overrides, size));
    setCropMode(
      props.forceQuad || overrides.manualQuad ? 'quad' : overrides.manualCrop ? 'rect' : props.isPhoto ? 'quad' : 'rect',
    );
    setHText(String(overrides.hDivs ?? result?.detection.grid.hDivs ?? 10));
    setVText(String(overrides.vDivs ?? result?.detection.grid.vDivs ?? 8));
  }, [cropOpen, url, size?.width, size?.height, props.forceQuad]);

  useEffect(() => {
    if (!cropOpen || !result || edited.current) return;
    const s = sourceSize(result);
    setRect(initialRect(result, overrides, s));
    setQuad(initialQuad(result, overrides, s));
    setHText(String(overrides.hDivs ?? result.detection.grid.hDivs ?? 10));
    setVText(String(overrides.vDivs ?? result.detection.grid.vDivs ?? 8));
  }, [result]);

  const editRect = (r: Rect): void => {
    edited.current = true;
    setRect(r);
  };
  const editQuad = (q: Quad): void => {
    edited.current = true;
    setQuad(q);
  };

  const shown: CaptureMode = !result ? 'original' : cropOpen ? (view === 'overlay' ? 'overlay' : 'original') : view;
  const overlaySvg = useMemo(() => (result && shown === 'overlay' ? renderOverlaySvg(result) : ''), [result, shown]);
  const cleanSvg = useMemo(
    () =>
      result && shown === 'clean'
        ? renderWaveformSvg(result, {
            locale,
            title,
            theme: dark ? 'dark' : 'light',
            math,
            ...(channelLabels ? { channelLabels } : {}),
          })
        : '',
    [result, shown, locale, title, dark, channelLabels, math],
  );
  const frame = useMemo(() => (result ? waveformFrame(result, { locale, title, math }) : null), [result, locale, title, math]);

  const plotSvg = shown === 'clean' ? cleanSvg : shown === 'xy' ? xy?.svg ?? '' : shown === 'fft' ? fft?.svg ?? '' : '';
  const showPlot = shown !== 'original' && shown !== 'overlay' && plotSvg !== '';
  const showClean = shown === 'clean' && showPlot;
  const plotPending = (shown === 'xy' || shown === 'fft') && plotSvg === '';
  const ratio = size && size.width > 0 && size.height > 0 ? size.width / size.height : 5 / 3;
  const plotRatio = svgRatio(plotSvg, 5 / 3);
  const hDivs = intOr(hText, 10);
  const vDivs = intOr(vText, 8);
  const z = zoom / 100;
  const quadValid = quad !== null && size !== null && validateQuad(quad, size.width, size.height);
  const canApply = cropMode === 'quad' ? quadValid : rect !== null;
  const cursorsVisible = showClean && props.cursors !== null && frame !== null && result !== null;

  const apply = (): void => {
    if (cropMode === 'quad') {
      if (quad && quadValid) props.onApplyQuad(quad, hDivs, vDivs);
    } else if (rect) {
      props.onApplyCrop(rect, hDivs, vDivs);
    }
  };
  const cancel = (): void => props.onCropOpen(false);
  type Tab = readonly [CaptureMode, string, string, Record<string, string>];
  const tabs: Tab[] = [
    ['original', tx.original, '1', {}],
    ['overlay', tx.tabOverlay, '2 T', { title: `${tx.overlay} (T)` }],
    ['clean', tx.tabClean, '3', { 'aria-label': tx.cleanPlot }],
  ];
  if (xy) tabs.push(['xy', tx.tabXy, '4', {}]);
  if (fft) tabs.push(['fft', tx.tabFft, '5', {}]);

  return (
    <div className="capture">
      <div className="toolbar">
        {onExtract && !result && (
          <button type="button" className="btn primary" disabled={extracting} onClick={onExtract}>
            {extracting ? tx.working : tx.extract}
          </button>
        )}
        {result && (
          <div className="seg tabs" role="group" aria-label={tx.view}>
            {tabs.map(([mode, label, key, extra]) => (
              <button
                key={mode}
                type="button"
                className="btn"
                aria-pressed={shown === mode}
                aria-keyshortcuts={key}
                onClick={() => props.onView(mode)}
                {...extra}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        {(shown === 'original' || shown === 'overlay') && canCrop && (
          <button type="button" className="btn" aria-pressed={cropOpen} onClick={() => props.onCropOpen(!cropOpen)} title={tx.cropTitle}>
            <Crop size={16} aria-hidden="true" />
            <span>{tx.crop}</span>
          </button>
        )}
        {shown === 'clean' && props.onCursors && (
          <button
            type="button"
            className="btn"
            aria-pressed={cursorsVisible}
            aria-keyshortcuts="C"
            onClick={props.onCursors}
            title={tx.cursorsTitle}
          >
            {tx.cursors}
          </button>
        )}
        {shown === 'xy' && xy && (
          <>
            <AxisSelect label={tx.xAxis} aria={tx.xAxisLabel} axes={xy.axes} value={xy.x} onChange={(x) => xy.onAxes(x, x === xy.y ? xy.x : xy.y)} />
            <AxisSelect label={tx.yAxis} aria={tx.yAxisLabel} axes={xy.axes} value={xy.y} onChange={(y) => xy.onAxes(y === xy.x ? xy.y : xy.x, y)} />
            <button type="button" className="btn" onClick={() => xy.onAxes(xy.y, xy.x)} title={tx.swapAxesTitle}>
              <ArrowLeftRight size={16} aria-hidden="true" />
              <span>{tx.swapAxes}</span>
            </button>
          </>
        )}
        {shown === 'fft' && fft && (
          <>
            <AxisSelect label={tx.fftChannel} aria={tx.fftChannelLabel} axes={fft.axes} value={fft.channel} onChange={fft.onChannel} />
            <label className="ctl">
              <span>{tx.fftWindow}</span>
              <select aria-label={tx.fftWindowLabel} value={fft.window} onChange={(e) => fft.onWindow(e.target.value as SpectrumWindow)}>
                {WINDOWS.map((w) => (
                  <option key={w} value={w}>
                    {tx.windows[w] ?? w}
                  </option>
                ))}
              </select>
            </label>
            <div className="seg" role="group" aria-label={tx.fftScale}>
              <button type="button" className="btn" aria-pressed={fft.scale === 'dbv'} onClick={() => fft.onScale('dbv')}>
                {tx.scaleDbv}
              </button>
              <button type="button" className="btn" aria-pressed={fft.scale === 'linear'} onClick={() => fft.onScale('linear')}>
                {tx.scaleLin}
              </button>
            </div>
          </>
        )}
        <span className="grow" />
        <ZoomControl tx={tx} value={zoom} max={ZOOM_MAX} onChange={setZoom} />
      </div>

      {cropOpen && (
        <div className="toolbar crop-bar">
          <div className="seg" role="group" aria-label={tx.cropShape}>
            <button type="button" className="btn" aria-pressed={cropMode === 'rect'} onClick={() => setCropMode('rect')}>
              {tx.cropRect}
            </button>
            <button type="button" className="btn" aria-pressed={cropMode === 'quad'} onClick={() => setCropMode('quad')}>
              {tx.cropQuad}
            </button>
          </div>
          <label className="inline">
            <span>{tx.hDivs}</span>
            <input
              type="text"
              inputMode="numeric"
              className="num tiny"
              value={hText}
              onChange={(e) => {
                edited.current = true;
                setHText(e.target.value);
              }}
            />
          </label>
          <label className="inline">
            <span>{tx.vDivs}</span>
            <input
              type="text"
              inputMode="numeric"
              className="num tiny"
              value={vText}
              onChange={(e) => {
                edited.current = true;
                setVText(e.target.value);
              }}
            />
          </label>
          <span className="muted small grow crop-hint" role={cropMode === 'quad' && !quadValid ? 'alert' : undefined}>
            {cropMode === 'quad' ? (quadValid ? tx.cropQuadHint : tx.quadInvalid) : tx.cropHint}
          </span>
          <button type="button" className="btn" onClick={cancel}>
            {tx.cancel}
          </button>
          <button type="button" className="btn primary" disabled={!canApply} onClick={apply}>
            {tx.applyCrop}
          </button>
        </div>
      )}

      {cursorsVisible && props.cursors && frame && result && (
        <CursorReadout
          tx={tx}
          locale={locale}
          result={result}
          frame={frame}
          cursors={props.cursors}
          labels={channelLabels}
          onChange={props.onCursorsChange}
        />
      )}

      <div ref={viewport} className={`viewport${showPlot || plotPending ? ' paper' : ' stage-wrap'}`}>
        {plotPending ? (
          <p className="plot-pending muted small" role="status" data-testid={`${shown}-pending`}>
            {tx.working}
          </p>
        ) : showPlot ? (
          <div className="canvas plot" style={{ '--ar': plotRatio, '--z': z } as CSSProperties}>
            <div className="plot-svg" data-testid={`${shown}-plot`} dangerouslySetInnerHTML={{ __html: plotSvg }} />
            {cursorsVisible && props.cursors && frame && (
              <CursorOverlay tx={tx} frame={frame} cursors={props.cursors} onChange={props.onCursorsChange} />
            )}
          </div>
        ) : (
          <div className={`canvas stage${zoom > 100 ? ' pixel' : ''}`} style={{ '--ar': ratio, '--z': z } as CSSProperties}>
            <img
              src={url}
              alt={fileName}
              draggable={false}
              onLoad={(e) => {
                const img = e.currentTarget;
                setSize({ width: img.naturalWidth, height: img.naturalHeight });
              }}
            />
            {overlaySvg && !cropOpen && <div className="overlay" dangerouslySetInnerHTML={{ __html: overlaySvg }} />}
            {cropOpen && cropMode === 'rect' && rect && size && (
              <CropBox
                tx={tx}
                rect={rect}
                imageWidth={size.width}
                imageHeight={size.height}
                hDivs={hDivs}
                vDivs={vDivs}
                onChange={editRect}
                onApply={apply}
                onCancel={cancel}
              />
            )}
            {cropOpen && cropMode === 'quad' && quad && size && (
              <QuadBox
                tx={tx}
                quad={quad}
                valid={quadValid}
                imageWidth={size.width}
                imageHeight={size.height}
                hDivs={hDivs}
                vDivs={vDivs}
                onChange={editQuad}
                onApply={apply}
                onCancel={cancel}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

interface AxisSelectProps {
  readonly label: string;
  readonly aria: string;
  readonly axes: readonly AxisOption[];
  readonly value: XyAxisId;
  readonly onChange: (axis: XyAxisId) => void;
}

function AxisSelect({ label, aria, axes, value, onChange }: AxisSelectProps) {
  return (
    <label className="ctl">
      <span>{label}</span>
      <select aria-label={aria} value={value} onChange={(e) => onChange(e.target.value as XyAxisId)}>
        {axes.map((a) => (
          <option key={a.id} value={a.id}>
            {a.label}
          </option>
        ))}
      </select>
    </label>
  );
}
