import sampleDataUrl from './assets/sine_schmitt.png?inline';

export const SAMPLE_NAME = 'sine_schmitt.png';

/** Decodes the bundled sample without fetch, so it works offline, over file:// and under a strict CSP. */
export function sampleFile(): File {
  const comma = sampleDataUrl.indexOf(',');
  const binary = atob(sampleDataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], SAMPLE_NAME, { type: 'image/png' });
}
