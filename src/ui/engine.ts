import type { BodeGateOptions, BodePointOverride, BodeResult, ExtractionOverrides, ExtractionResult } from '../core/types';
import type { WorkerRequest, WorkerResponse } from '../worker/extract.worker';

export interface BodeItem {
  readonly fileName: string;
  readonly bytes: Uint8Array;
  readonly overrides?: ExtractionOverrides;
}

type PointOverrides = Readonly<Record<string, BodePointOverride>>;

interface Pending {
  readonly resolve: (value: ExtractionResult | BodeResult) => void;
  readonly reject: (error: Error) => void;
  readonly request: WorkerRequest;
}

type Pipeline = typeof import('../core/pipeline');

let pipelinePromise: Promise<Pipeline> | null = null;
function pipeline(): Promise<Pipeline> {
  pipelinePromise ??= import('../core/pipeline').catch((e: unknown) => {
    // A failed chunk load is retried on the next call instead of failing for the whole session.
    pipelinePromise = null;
    throw e;
  });
  return pipelinePromise;
}

let worker: Worker | null = null;
let workerBroken = false;
let nextId = 1;
const pending = new Map<number, Pending>();

function runDirect(request: WorkerRequest): Promise<ExtractionResult | BodeResult> {
  return pipeline().then((p) => {
    if (request.type === 'analyze-single') return p.analyzePngBytes(request.bytes, request.fileName, request.overrides);
    return p.analyzeBodeBatch(request.captures, request.options, request.overrides);
  });
}

function failOver(): void {
  workerBroken = true;
  worker?.terminate();
  worker = null;
  const waiting = [...pending.values()];
  pending.clear();
  for (const p of waiting) runDirect(p.request).then(p.resolve, (e: unknown) => p.reject(toError(e)));
}

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

function getWorker(): Worker | null {
  if (workerBroken || typeof Worker === 'undefined') return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL('../worker/extract.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    workerBroken = true;
    return null;
  }
  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const msg = event.data;
    const id = typeof msg.id === 'number' ? msg.id : Number(msg.id);
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error));
  };
  worker.onerror = (event) => {
    event.preventDefault();
    failOver();
  };
  worker.onmessageerror = () => failOver();
  return worker;
}

function send(request: WorkerRequest): Promise<ExtractionResult | BodeResult> {
  const w = getWorker();
  if (!w) return runDirect(request);
  return new Promise((resolve, reject) => {
    const id = typeof request.id === 'number' ? request.id : Number(request.id);
    pending.set(id, { resolve, reject, request });
    try {
      w.postMessage(request);
    } catch {
      failOver();
    }
  });
}

export function analyzeSingle(bytes: Uint8Array, fileName: string, overrides: ExtractionOverrides): Promise<ExtractionResult> {
  const request: WorkerRequest = { type: 'analyze-single', id: nextId++, bytes: bytes.slice(), fileName, overrides };
  return send(request) as Promise<ExtractionResult>;
}

export function analyzeBode(items: readonly BodeItem[], gate: BodeGateOptions, overrides: PointOverrides): Promise<BodeResult> {
  const captures = items.map((i) => ({ fileName: i.fileName, bytes: i.bytes.slice(), ...(i.overrides ? { overrides: i.overrides } : {}) }));
  const request: WorkerRequest = { type: 'analyze-bode', id: nextId++, captures, options: gate, overrides };
  return send(request) as Promise<BodeResult>;
}

export async function recomputeBode(result: BodeResult, gate: BodeGateOptions, overrides: PointOverrides): Promise<BodeResult> {
  const p = await pipeline();
  return p.recomputeBodeResult(result, overrides, gate);
}
