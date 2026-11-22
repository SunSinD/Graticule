import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Crop } from 'lucide-react';
import type { ExtractionOverrides, ExtractionResult, Locale, PlotCursors, Quad, Rect } from '../../core/types';
import { renderOverlaySvg, renderWaveformSvg, waveformFrame } from '../../core/export/svg';
import { validateQuad } from '../../core/deskew';
import type { Dict } from '../i18n';
import type { ChannelLabels } from '../history';
import { CropBox, QuadBox } from './CropBox';
import { CursorOverlay, CursorReadout } from './Cursors';
import { svgRatio, useCtrlWheelZoom, ZoomControl } from './ZoomControl';

export type CaptureMode = 'original' | 'clean';
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
  readonly overlay: boolean;
  readonly cropOpen: boolean;
  readonly canCrop: boolean;
  readonly isPhoto: boolean;
  readonly forceQuad: boolean;
  readonly overrides: ExtractionOverrides;
  readonly cursors: PlotCursors | null;
  readonly onExtract: (() => void) | null;
  readonly onView: (view: CaptureMode) => void;
  readonly onOverlay: () => void;
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
  const { tx, locale, dark, url, fileName, title, channelLabels, result, extracting, view, overlay, cropOpen, canCrop, overrides, onExtract } =
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

  const overlaySvg = useMemo(() => (result && overlay ? renderOverlaySvg(result) : ''), [result, overlay]);
  const cleanSvg = useMemo(
    () =>
      result && view === 'clean'
        ? renderWaveformSvg(result, { locale, title, theme: dark ? 'dark' : 'light', ...(channelLabels ? { channelLabels } : {}) })
        : '',
    [result, view, locale, title, dark, channelLabels],
  );
  const frame = useMemo(() => (result ? waveformFrame(result, { locale, title }) : null), [result, locale, title]);

  const showClean = view === 'clean' && !cropOpen && result !== null;
  const ratio = size && size.width > 0 && size.height > 0 ? size.width / size.height : 5 / 3;
  const cleanRatio = svgRatio(cleanSvg, 5 / 3);
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

  return (
    <div className="capture">
      <div className="toolbar">
        {onExtract && !result && (
          <button type="button" className="btn primary" disabled={extracting} onClick={onExtract}>
            {extracting ? tx.working : tx.extract}
          </button>
        )}
        <div className="seg" role="group" aria-label={tx.cleanPlot}>
          <button type="button" className="btn" aria-pressed={showClean} disabled={!result} onClick={() => props.onView('clean')}>
            {tx.cleanPlot}
          </button>
          <button type="button" className="btn" aria-pressed={!showClean} onClick={() => props.onView('original')}>
            {tx.original}
          </button>
        </div>
        <button
          type="button"
          className="btn"
          aria-pressed={overlay}
          aria-keyshortcuts="T"
          disabled={!result}
          onClick={props.onOverlay}
          title={`${tx.overlay} (T)`}
        >
          {tx.overlay}
        </button>
        {canCrop && (
          <button type="button" className="btn" aria-pressed={cropOpen} onClick={() => props.onCropOpen(!cropOpen)} title={tx.cropTitle}>
            <Crop size={16} aria-hidden="true" />
            <span>{tx.crop}</span>
          </button>
        )}
        {props.onCursors && (
          <button
            type="button"
            className="btn"
            aria-pressed={cursorsVisible}
            aria-keyshortcuts="C"
            disabled={!result || cropOpen}
            onClick={props.onCursors}
            title={tx.cursorsTitle}
          >
            {tx.cursors}
          </button>
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
          <span className="muted small grow" role={cropMode === 'quad' && !quadValid ? 'alert' : undefined}>
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

      <div ref={viewport} className={`viewport${showClean ? ' paper' : ' stage-wrap'}`}>
        {showClean ? (
          <div className="canvas plot" style={{ '--ar': cleanRatio, '--z': z } as CSSProperties}>
            <div className="plot-svg" dangerouslySetInnerHTML={{ __html: cleanSvg }} />
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
            {overlay && overlaySvg && !cropOpen && <div className="overlay" dangerouslySetInnerHTML={{ __html: overlaySvg }} />}
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
