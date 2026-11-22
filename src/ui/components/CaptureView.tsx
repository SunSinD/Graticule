import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Crop } from 'lucide-react';
import type { ExtractionOverrides, ExtractionResult, Locale, Rect } from '../../core/types';
import { renderOverlaySvg, renderWaveformSvg } from '../../core/export/svg';
import type { Dict } from '../i18n';
import { CropBox } from './CropBox';
import { svgRatio, useCtrlWheelZoom, ZoomControl } from './ZoomControl';

export type CaptureMode = 'original' | 'clean';

const ZOOM_MAX = 300;

interface Props {
  readonly tx: Dict;
  readonly locale: Locale;
  readonly dark: boolean;
  readonly url: string;
  readonly fileName: string;
  readonly result: ExtractionResult | null;
  readonly extracting: boolean;
  readonly view: CaptureMode;
  readonly overlay: boolean;
  readonly cropOpen: boolean;
  readonly canCrop: boolean;
  readonly overrides: ExtractionOverrides;
  readonly onExtract: (() => void) | null;
  readonly onView: (view: CaptureMode) => void;
  readonly onOverlay: () => void;
  readonly onCropOpen: (open: boolean) => void;
  readonly onApplyCrop: (crop: Rect, hDivs: number, vDivs: number) => void;
}

interface Size {
  readonly width: number;
  readonly height: number;
}

function initialRect(result: ExtractionResult | null, overrides: ExtractionOverrides, size: Size): Rect {
  if (overrides.manualCrop) return overrides.manualCrop;
  const g = result?.detection.grid;
  if (g && g.width > 4 && g.height > 4 && g.right <= size.width + 1 && g.bottom <= size.height + 1) {
    return { x: g.left, y: g.top, width: g.width, height: g.height };
  }
  return { x: 0, y: 0, width: size.width, height: size.height };
}

function intOr(text: string, fallback: number): number {
  const v = Number.parseInt(text, 10);
  return Number.isFinite(v) && v >= 1 && v <= 40 ? v : fallback;
}

export function CaptureView(props: Props) {
  const { tx, locale, dark, url, fileName, result, extracting, view, overlay, cropOpen, canCrop, overrides, onExtract } = props;
  const [size, setSize] = useState<Size | null>(
    result ? { width: result.imageWidth, height: result.imageHeight } : null,
  );
  const [rect, setRect] = useState<Rect | null>(null);
  const [hText, setHText] = useState('10');
  const [vText, setVText] = useState('8');
  const [zoom, setZoom] = useState(100);
  const viewport = useRef<HTMLDivElement>(null);
  useCtrlWheelZoom(viewport, zoom, ZOOM_MAX, setZoom);

  useEffect(() => {
    if (result) setSize({ width: result.imageWidth, height: result.imageHeight });
  }, [result]);

  useEffect(() => {
    if (!cropOpen || !size) {
      setRect(null);
      return;
    }
    setRect(initialRect(result, overrides, size));
    setHText(String(overrides.hDivs ?? result?.detection.grid.hDivs ?? 10));
    setVText(String(overrides.vDivs ?? result?.detection.grid.vDivs ?? 8));
  }, [cropOpen, url, size?.width, size?.height]);

  const overlaySvg = useMemo(() => (result && overlay ? renderOverlaySvg(result) : ''), [result, overlay]);
  const cleanSvg = useMemo(
    () => (result && view === 'clean' ? renderWaveformSvg(result, { locale, title: fileName, theme: dark ? 'dark' : 'light' }) : ''),
    [result, view, locale, fileName, dark],
  );

  const showClean = view === 'clean' && !cropOpen && result !== null;
  const ratio = size && size.width > 0 && size.height > 0 ? size.width / size.height : 5 / 3;
  const cleanRatio = svgRatio(cleanSvg, 5 / 3);
  const hDivs = intOr(hText, 10);
  const vDivs = intOr(vText, 8);
  const z = zoom / 100;

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
        <span className="grow" />
        <ZoomControl tx={tx} value={zoom} max={ZOOM_MAX} onChange={setZoom} />
      </div>

      {cropOpen && (
        <div className="toolbar crop-bar">
          <label className="inline">
            <span>{tx.hDivs}</span>
            <input type="text" inputMode="numeric" className="num tiny" value={hText} onChange={(e) => setHText(e.target.value)} />
          </label>
          <label className="inline">
            <span>{tx.vDivs}</span>
            <input type="text" inputMode="numeric" className="num tiny" value={vText} onChange={(e) => setVText(e.target.value)} />
          </label>
          <span className="muted small grow">{tx.cropHint}</span>
          <button type="button" className="btn" onClick={() => props.onCropOpen(false)}>
            {tx.cancel}
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={!rect}
            onClick={() => rect && props.onApplyCrop(rect, hDivs, vDivs)}
          >
            {tx.applyCrop}
          </button>
        </div>
      )}

      <div ref={viewport} className={`viewport${showClean ? ' paper' : ' stage-wrap'}`}>
        {showClean ? (
          <div
            className="canvas plot"
            style={{ '--ar': cleanRatio, '--z': z } as CSSProperties}
            dangerouslySetInnerHTML={{ __html: cleanSvg }}
          />
        ) : (
          <div className="canvas stage" style={{ '--ar': ratio, '--z': z } as CSSProperties}>
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
            {cropOpen && rect && size && (
              <CropBox rect={rect} imageWidth={size.width} imageHeight={size.height} hDivs={hDivs} vDivs={vDivs} onChange={setRect} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
