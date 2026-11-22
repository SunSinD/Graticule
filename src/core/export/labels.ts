import type { GapStatus, Locale } from '../types.js';

export type MetricKey =
  | 'vpp'
  | 'vmax'
  | 'vmin'
  | 'vavg'
  | 'vrms'
  | 'amplitude'
  | 'period'
  | 'freq'
  | 'duty'
  | 'phase';

export const METRIC_UNITS: Readonly<Record<MetricKey, string>> = {
  vpp: 'V',
  vmax: 'V',
  vmin: 'V',
  vavg: 'V',
  vrms: 'V',
  amplitude: 'V',
  period: 's',
  freq: 'Hz',
  duty: '%',
  phase: '\u00b0',
};

export const METRIC_LABELS: Readonly<Record<Locale, Readonly<Record<MetricKey, string>>>> = {
  en: {
    vpp: 'Peak to peak voltage (Vpp)',
    vmax: 'Maximum voltage (Vmax)',
    vmin: 'Minimum voltage (Vmin)',
    vavg: 'Average (Vavg)',
    vrms: 'RMS value (Vrms)',
    amplitude: 'Amplitude',
    period: 'Period (T)',
    freq: 'Frequency (f)',
    duty: 'Duty cycle',
    phase: 'Phase',
  },
  fr: {
    vpp: 'Tension cr\u00eate \u00e0 cr\u00eate (Vpp)',
    vmax: 'Tension maximale (Vmax)',
    vmin: 'Tension minimale (Vmin)',
    vavg: 'Moyenne (Vavg)',
    vrms: 'Valeur efficace (Vrms)',
    amplitude: 'Amplitude',
    period: 'P\u00e9riode (T)',
    freq: 'Fr\u00e9quence (f)',
    duty: 'Rapport cyclique',
    phase: 'D\u00e9phasage',
  },
};

const METRIC_ALIASES: Readonly<Record<string, MetricKey>> = {
  vpp: 'vpp',
  pkpk: 'vpp',
  'pk-pk': 'vpp',
  '+duty': 'duty',
  '-duty': 'duty',
  f: 'freq',
  vmax: 'vmax',
  max: 'vmax',
  vmin: 'vmin',
  min: 'vmin',
  vavg: 'vavg',
  mean: 'vavg',
  avg: 'vavg',
  vrms: 'vrms',
  rms: 'vrms',
  amplitude: 'amplitude',
  ampl: 'amplitude',
  period: 'period',
  per: 'period',
  freq: 'freq',
  frequency: 'freq',
  duty: 'duty',
  phase: 'phase',
};

export function toMetricKey(metric: string): MetricKey | null {
  return METRIC_ALIASES[metric.trim().replace(/\(.*\)$/, '').trim().toLowerCase()] ?? null;
}

export function metricLabel(metric: string, locale: Locale): string {
  const key = toMetricKey(metric);
  return key ? METRIC_LABELS[locale][key] : metric;
}

export interface ExportText {
  readonly measurement: string;
  readonly measurementsCaption: string;
  readonly comparisonCaption: string;
  readonly channel: string;
  readonly scope: string;
  readonly graticule: string;
  readonly delta: string;
  readonly deltaPct: string;
  readonly clipped: string;
  readonly bodeCaption: string;
  readonly bodeSummaryCaption: string;
  readonly parameter: string;
  readonly value: string;
  readonly file: string;
  readonly frequency: string;
  readonly vin: string;
  readonly vout: string;
  readonly gain: string;
  readonly phase: string;
  readonly status: string;
  readonly reasons: string;
  readonly accepted: string;
  readonly rejected: string;
  readonly edited: string;
  readonly passbandGain: string;
  readonly cutoff: string;
  readonly cutoffTarget: string;
  readonly inputOutput: string;
  readonly pointCounts: string;
  readonly noCutoff: string;
  readonly colon: string;
}

export const EXPORT_TEXT: Readonly<Record<Locale, ExportText>> = {
  en: {
    measurement: 'Measurement',
    measurementsCaption: 'Measurements',
    comparisonCaption: 'Scope / Graticule / \u0394',
    channel: 'Channel',
    scope: 'Scope',
    graticule: 'Graticule',
    delta: '\u0394',
    deltaPct: '\u0394 %',
    clipped: 'clipped',
    bodeCaption: 'Bode points',
    bodeSummaryCaption: 'Bode summary',
    parameter: 'Parameter',
    value: 'Value',
    file: 'File',
    frequency: 'Frequency',
    vin: 'Vin (Vpp)',
    vout: 'Vout (Vpp)',
    gain: 'Gain (dB)',
    phase: 'Phase (\u00b0)',
    status: 'Status',
    reasons: 'Reasons',
    accepted: 'Accepted',
    rejected: 'Rejected',
    edited: 'edited',
    passbandGain: 'Passband gain',
    cutoff: 'Cutoff frequency (-3 dB)',
    cutoffTarget: 'Cutoff level',
    inputOutput: 'Input / output',
    pointCounts: 'Accepted / rejected',
    noCutoff: 'No -3 dB crossing found',
    colon: ': ',
  },
  fr: {
    measurement: 'Mesure',
    measurementsCaption: 'Mesures',
    comparisonCaption: 'Oscilloscope / Graticule / \u0394',
    channel: 'Canal',
    scope: 'Oscilloscope',
    graticule: 'Graticule',
    delta: '\u0394',
    deltaPct: '\u0394 %',
    clipped: '\u00e9cr\u00eat\u00e9',
    bodeCaption: 'Points de Bode',
    bodeSummaryCaption: 'R\u00e9sum\u00e9 Bode',
    parameter: 'Param\u00e8tre',
    value: 'Valeur',
    file: 'Fichier',
    frequency: 'Fr\u00e9quence',
    vin: 'Vin (Vpp)',
    vout: 'Vout (Vpp)',
    gain: 'Gain (dB)',
    phase: 'D\u00e9phasage (\u00b0)',
    status: 'Statut',
    reasons: 'Raisons',
    accepted: 'Accept\u00e9',
    rejected: 'Rejet\u00e9',
    edited: 'modifi\u00e9',
    passbandGain: 'Gain en bande passante',
    cutoff: 'Fr\u00e9quence de coupure (-3 dB)',
    cutoffTarget: 'Niveau de coupure',
    inputOutput: 'Entr\u00e9e / sortie',
    pointCounts: 'Accept\u00e9s / rejet\u00e9s',
    noCutoff: 'Aucun croisement \u00e0 -3 dB',
    colon: ' : ',
  },
};

export interface SvgText {
  readonly offset: string;
  readonly probe: string;
  readonly timePerDiv: string;
  readonly trigger: string;
  readonly gaps: string;
  readonly gapNote: string;
  readonly noChannels: string;
  readonly gainAxis: string;
  readonly phaseAxis: string;
  readonly frequencyAxis: string;
  readonly accepted: string;
  readonly rejected: string;
  readonly acceptedKey: string;
  readonly rejectedKey: string;
  readonly passband: string;
  readonly input: string;
  readonly output: string;
  readonly noPoints: string;
}

export const SVG_TEXT: Readonly<Record<Locale, SvgText>> = {
  en: {
    offset: 'offset',
    probe: 'probe',
    timePerDiv: 'Time/div',
    trigger: 'trigger',
    gaps: 'gaps',
    gapNote: 'Missing data is never joined. Dotted marks below the plot show clipped, masked or unresolved spans in legend order.',
    noChannels: 'No channel enabled',
    gainAxis: 'Gain (dB)',
    phaseAxis: 'Phase (\u00b0)',
    frequencyAxis: 'Frequency (Hz)',
    accepted: 'accepted',
    rejected: 'rejected',
    acceptedKey: 'accepted point, connected',
    rejectedKey: 'rejected point, not connected',
    passband: 'passband',
    input: 'in',
    output: 'out',
    noPoints: 'No point with a valid frequency',
  },
  fr: {
    offset: 'd\u00e9calage',
    probe: 'sonde',
    timePerDiv: 'Temps/div',
    trigger: 'd\u00e9clenchement',
    gaps: 'trous',
    gapNote: 'Les donn\u00e9es manquantes ne sont jamais reli\u00e9es. Les pointill\u00e9s sous le graphe montrent les zones \u00e9cr\u00eat\u00e9es, masqu\u00e9es ou non r\u00e9solues, dans l\u2019ordre de la l\u00e9gende.',
    noChannels: 'Aucun canal actif',
    gainAxis: 'Gain (dB)',
    phaseAxis: 'D\u00e9phasage (\u00b0)',
    frequencyAxis: 'Fr\u00e9quence (Hz)',
    accepted: 'accept\u00e9s',
    rejected: 'rejet\u00e9s',
    acceptedKey: 'point accept\u00e9, reli\u00e9',
    rejectedKey: 'point rejet\u00e9, non reli\u00e9',
    passband: 'bande passante',
    input: 'entr\u00e9e',
    output: 'sortie',
    noPoints: 'Aucun point avec une fr\u00e9quence valide',
  },
};

export const GAP_LABELS: Readonly<Record<Locale, Readonly<Record<GapStatus, string>>>> = {
  en: {
    ok: 'ok',
    clipped_high: 'clipped high',
    clipped_low: 'clipped low',
    masked_cursor: 'hidden by cursor',
    masked_overlay: 'hidden by overlay',
    overlap_ambiguous: 'traces overlap',
    unresolved: 'unresolved',
  },
  fr: {
    ok: 'ok',
    clipped_high: '\u00e9cr\u00eat\u00e9 en haut',
    clipped_low: '\u00e9cr\u00eat\u00e9 en bas',
    masked_cursor: 'cach\u00e9 par un curseur',
    masked_overlay: 'cach\u00e9 par un menu',
    overlap_ambiguous: 'traces superpos\u00e9es',
    unresolved: 'non r\u00e9solu',
  },
};

export const REASON_LABELS: Readonly<Record<Locale, Readonly<Record<string, string>>>> = {
  en: {
    missing_channels: 'input or output channel is missing',
    frequency_unconfirmed: 'frequency could not be confirmed',
    uncalibrated_timebase: 'time scale was not read from the screen',
    uncalibrated_channel_scale: 'volts per division was not read from the screen',
    clipped_channel: 'a trace is clipped off the screen',
    insufficient_cycles: 'not enough complete cycles',
    insufficient_cols_per_cycle: 'too few pixels per cycle',
    insufficient_peak_to_peak_px: 'trace is too small on screen',
    poor_sine_fit: 'trace does not look like a clean sine',
    manually_excluded: 'excluded by you',
    fewer_than_3_cycles: 'fewer than 3 cycles, less precise',
  },
  fr: {
    missing_channels: 'canal d’entrée ou de sortie manquant',
    frequency_unconfirmed: 'fréquence non confirmée',
    uncalibrated_timebase: 'base de temps non lue sur l’écran',
    uncalibrated_channel_scale: 'échelle volts par division non lue',
    clipped_channel: 'une trace est écrêtée',
    insufficient_cycles: 'pas assez de cycles complets',
    insufficient_cols_per_cycle: 'trop peu de pixels par cycle',
    insufficient_peak_to_peak_px: 'trace trop petite à l’écran',
    poor_sine_fit: 'la trace ne ressemble pas à un sinus propre',
    manually_excluded: 'exclu par vous',
    fewer_than_3_cycles: 'moins de 3 cycles, moins précis',
  },
};

export function reasonLabel(code: string, locale: Locale): string {
  return REASON_LABELS[locale][code] ?? code.replace(/_/g, ' ');
}
