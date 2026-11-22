import type { GapStatus, Locale } from '../core/types';
import {
  EMPTY_CELL,
  formatEng,
  formatFixed,
  formatPercent,
  localizeDecimal,
  parseEngineering,
  stepScale125,
} from '../core/export/format';
import { GAP_LABELS, METRIC_LABELS, reasonLabel } from '../core/export/labels';

export { EMPTY_CELL, formatEng, formatFixed, formatPercent, localizeDecimal, parseEngineering, stepScale125, reasonLabel, METRIC_LABELS };

const en = {
  mode: 'Mode',
  modeSingle: 'Single',
  modeBode: 'Bode Batch',
  open: 'Open',
  openTitle: 'Open a file (O)',
  themeToDark: 'Switch to dark theme',
  themeToLight: 'Switch to light theme',
  shortcuts: 'Keyboard shortcuts',
  close: 'Close',
  emptyDrop: 'Drop an oscilloscope screenshot, paste one, or open a file.',
  emptyTry: 'Try a sample:',
  emptyPrivacy: 'Runs in your browser. Files never leave your computer.',
  sampleSine: 'Sine and Schmitt trigger',
  sampleZener: 'Zener clipping',
  sampleSweep: 'Active filter sweep, 10 captures',
  files: 'Files',
  addFiles: 'Add files',
  addFolder: 'Add folder',
  samples: 'Samples',
  clear: 'Clear',
  dropHere: 'Drop to load',
  original: 'Original',
  cleanPlot: 'Clean Plot',
  overlay: '1:1 Overlay',
  crop: 'Crop',
  cropTitle: 'Set the graticule box by hand',
  applyCrop: 'Apply crop',
  cancel: 'Cancel',
  hDivs: 'H divs',
  vDivs: 'V divs',
  cropHint: 'Drag the corners onto the outer edge of the graticule.',
  bode: 'Bode',
  capture: 'Capture',
  backToBode: 'Back to Bode',
  profile: 'Profile',
  profileAuto: 'Auto',
  detected: 'Detected',
  confidence: 'confidence',
  timePerDiv: 'Time/div',
  decreaseTime: 'Decrease Time/div',
  increaseTime: 'Increase Time/div',
  channels: 'Channels',
  voltsPerDiv: 'V/div',
  offset: 'Offset (V)',
  enable: 'Enable',
  decreaseScale: (ch: string) => `Decrease ${ch} scale`,
  increaseScale: (ch: string) => `Increase ${ch} scale`,
  results: 'Extracted values',
  quantity: 'Quantity',
  phaseRow: 'Phase C1→C2',
  comparison: 'Scope / Graticule / Δ',
  comparisonNote: 'Scope values come from the MEASURE bar on the screenshot.',
  scope: 'Scope',
  graticule: 'Graticule',
  delta: 'Δ',
  export: 'Export',
  downloadSvg: 'SVG',
  downloadPng: '2x PNG',
  downloadCsv: 'CSV',
  copyTable: 'Copy table',
  copyWord: 'Word HTML',
  copyMarkdown: 'Markdown',
  copyTsv: 'TSV',
  copied: 'Copied',
  copyFailed: 'Copy failed',
  working: 'Working…',
  extractedSingle: (traces: number, ms: string) => `Extracted ${traces} ${traces === 1 ? 'trace' : 'traces'} in ${ms}`,
  extractedBode: (n: number, ms: string) => `Extracted ${n} captures in ${ms}`,
  error: 'Could not read this file',
  noResult: 'No capture loaded',
  gaps: 'Gaps',
  bodeSummary: 'Bode summary',
  inputChannel: 'Input',
  outputChannel: 'Output',
  passband: 'Passband gain',
  cutoff: '-3 dB cutoff',
  noCutoff: 'not found',
  acceptedCount: 'Accepted',
  rejectedCount: 'Rejected',
  colFile: 'File',
  colFreq: 'f',
  colVin: 'Vin pp',
  colVout: 'Vout pp',
  colGain: 'Gain dB',
  colPhase: 'Phase °',
  colUse: 'Use',
  colStatus: 'Status',
  accepted: 'accepted',
  rejected: 'rejected',
  edited: 'edited',
  inspect: 'Inspect',
  tableHint: 'Every cell is editable. Rejected rows stay visible and are never connected.',
  resetEdits: 'Reset edits',
  includePoint: 'Include this point',
  shortcutOpen: 'Open a file',
  shortcutPaste: 'Paste a screenshot',
  shortcutExport: 'Go to exports',
  shortcutOverlay: 'Toggle 1:1 overlay',
  shortcutHelp: 'Show or hide this list',
  warning: 'Note',
  fallback: {
    unsupported_resolution: 'Screen size not recognised, using the universal mode. Check the crop box.',
    native_anchors_mismatch: 'Scope layout not recognised, using the universal mode. Check the crop box.',
    manual_crop: 'Using your crop box.',
    manual_profile: 'Universal mode chosen by you.',
    digital_only: 'Only digital channels were found.',
  } as Record<string, string>,
  gapLabels: GAP_LABELS.en,
  scaleDefault: 'not read, check it',
  unsupportedFile: 'Only image files can be read.',
};

export type Dict = typeof en;

const fr: Dict = {
  mode: 'Mode',
  modeSingle: 'Simple',
  modeBode: 'Lot Bode',
  open: 'Ouvrir',
  openTitle: 'Ouvrir un fichier (O)',
  themeToDark: 'Passer au thème sombre',
  themeToLight: 'Passer au thème clair',
  shortcuts: 'Raccourcis clavier',
  close: 'Fermer',
  emptyDrop: 'Déposez une capture d’oscilloscope, collez‑en une, ou ouvrez un fichier.',
  emptyTry: 'Essayez un exemple :',
  emptyPrivacy: 'Tout se passe dans votre navigateur. Vos fichiers ne quittent jamais votre ordinateur.',
  sampleSine: 'Sinus et trigger de Schmitt',
  sampleZener: 'Écrêtage Zener',
  sampleSweep: 'Balayage de filtre actif, 10 captures',
  files: 'Fichiers',
  addFiles: 'Ajouter des fichiers',
  addFolder: 'Ajouter un dossier',
  samples: 'Exemples',
  clear: 'Vider',
  dropHere: 'Déposer pour charger',
  original: 'Original',
  cleanPlot: 'Tracé propre',
  overlay: '1:1 Overlay',
  crop: 'Recadrer',
  cropTitle: 'Placer le cadre de la grille à la main',
  applyCrop: 'Appliquer',
  cancel: 'Annuler',
  hDivs: 'Div H',
  vDivs: 'Div V',
  cropHint: 'Glissez les coins sur le bord extérieur de la grille.',
  bode: 'Bode',
  capture: 'Capture',
  backToBode: 'Retour au Bode',
  profile: 'Profil',
  profileAuto: 'Auto',
  detected: 'Détecté',
  confidence: 'confiance',
  timePerDiv: 'Temps/div',
  decreaseTime: 'Diminuer Temps/div',
  increaseTime: 'Augmenter Temps/div',
  channels: 'Canaux',
  voltsPerDiv: 'V/div',
  offset: 'Décalage (V)',
  enable: 'Activer',
  decreaseScale: (ch: string) => `Diminuer l’échelle ${ch}`,
  increaseScale: (ch: string) => `Augmenter l’échelle ${ch}`,
  results: 'Valeurs extraites',
  quantity: 'Grandeur',
  phaseRow: 'Déphasage C1→C2',
  comparison: 'Oscilloscope / Graticule / Δ',
  comparisonNote: 'Les valeurs de l’oscilloscope viennent de la barre MEASURE de la capture.',
  scope: 'Oscillo',
  graticule: 'Graticule',
  delta: 'Δ',
  export: 'Exporter',
  downloadSvg: 'SVG',
  downloadPng: 'PNG 2x',
  downloadCsv: 'CSV',
  copyTable: 'Copier le tableau',
  copyWord: 'HTML Word',
  copyMarkdown: 'Markdown',
  copyTsv: 'TSV',
  copied: 'Copié',
  copyFailed: 'Échec de la copie',
  working: 'Analyse…',
  extractedSingle: (traces: number, ms: string) => `${traces} ${traces === 1 ? 'trace extraite' : 'traces extraites'} en ${ms}`,
  extractedBode: (n: number, ms: string) => `${n} captures extraites en ${ms}`,
  error: 'Impossible de lire ce fichier',
  noResult: 'Aucune capture chargée',
  gaps: 'Trous',
  bodeSummary: 'Résumé Bode',
  inputChannel: 'Entrée',
  outputChannel: 'Sortie',
  passband: 'Gain en bande passante',
  cutoff: 'Coupure à -3 dB',
  noCutoff: 'introuvable',
  acceptedCount: 'Acceptés',
  rejectedCount: 'Rejetés',
  colFile: 'Fichier',
  colFreq: 'f',
  colVin: 'Vin cc',
  colVout: 'Vout cc',
  colGain: 'Gain dB',
  colPhase: 'Déph. °',
  colUse: 'Utiliser',
  colStatus: 'Statut',
  accepted: 'accepté',
  rejected: 'rejeté',
  edited: 'modifié',
  inspect: 'Voir',
  tableHint: 'Chaque cellule est modifiable. Les lignes rejetées restent visibles et ne sont jamais reliées.',
  resetEdits: 'Annuler les modifications',
  includePoint: 'Inclure ce point',
  shortcutOpen: 'Ouvrir un fichier',
  shortcutPaste: 'Coller une capture',
  shortcutExport: 'Aller aux exports',
  shortcutOverlay: 'Afficher ou cacher l’overlay 1:1',
  shortcutHelp: 'Afficher ou cacher cette liste',
  warning: 'Note',
  fallback: {
    unsupported_resolution: 'Taille d’écran inconnue, mode universel utilisé. Vérifiez le cadre.',
    native_anchors_mismatch: 'Mise en page non reconnue, mode universel utilisé. Vérifiez le cadre.',
    manual_crop: 'Votre cadre est utilisé.',
    manual_profile: 'Mode universel choisi par vous.',
    digital_only: 'Seulement des canaux numériques trouvés.',
  },
  gapLabels: GAP_LABELS.fr,
  scaleDefault: 'non lu, à vérifier',
  unsupportedFile: 'Seules les images peuvent être lues.',
};

export const DICTS: Readonly<Record<Locale, Dict>> = { en, fr };

export function t(locale: Locale): Dict {
  return DICTS[locale];
}

export function gapLabel(status: GapStatus, locale: Locale): string {
  return GAP_LABELS[locale][status];
}

export function formatDuration(ms: number, locale: Locale): string {
  if (!Number.isFinite(ms)) return EMPTY_CELL;
  return ms >= 1000 ? `${localizeDecimal((ms / 1000).toFixed(2), locale)} s` : `${Math.round(ms)} ms`;
}

export function formatVolts(value: number | null | undefined, locale: Locale): string {
  return formatEng(value, 'V', locale, { sig: 4 });
}

export function formatSeconds(value: number | null | undefined, locale: Locale): string {
  return formatEng(value, 's', locale, { sig: 4 });
}

export function formatHertz(value: number | null | undefined, locale: Locale): string {
  return formatEng(value, 'Hz', locale, { sig: 4 });
}

export function formatScale(value: number | null | undefined, unit: 'V' | 's', locale: Locale): string {
  return formatEng(value, unit, locale, { sig: 3, trim: true });
}

export function formatDb(value: number | null | undefined, locale: Locale): string {
  return formatFixed(value, 2, locale);
}

export function formatDeg(value: number | null | undefined, locale: Locale): string {
  return formatFixed(value, 1, locale);
}

export function parseNumber(text: string): number | null {
  return parseEngineering(text);
}
