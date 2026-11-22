import { analyzeBodeBatch, analyzePngBytes } from '../core/pipeline.js';
import type { BodeCaptureInput, BodeOverrides } from '../core/pipeline.js';
import type { BodeGateOptions, BodeResult, ExtractionOverrides, ExtractionResult } from '../core/types.js';

type RequestId = number | string;

export type WorkerRequest =
  | { readonly type: 'analyze-single'; readonly id: RequestId; readonly bytes: Uint8Array;
      readonly fileName: string; readonly overrides?: ExtractionOverrides }
  | { readonly type: 'analyze-bode'; readonly id: RequestId; readonly captures: readonly BodeCaptureInput[];
      readonly options?: BodeGateOptions; readonly overrides?: BodeOverrides };

export type WorkerResponse =
  | { readonly type: 'analyze-single'; readonly id: RequestId; readonly ok: true; readonly result: ExtractionResult }
  | { readonly type: 'analyze-bode'; readonly id: RequestId; readonly ok: true; readonly result: BodeResult }
  | { readonly type: WorkerRequest['type']; readonly id: RequestId; readonly ok: false; readonly error: string };

const worker = self as unknown as DedicatedWorkerGlobalScope;

worker.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  let response: WorkerResponse;
  try {
    response = request.type === 'analyze-single'
      ? { type: request.type, id: request.id, ok: true, result: analyzePngBytes(request.bytes, request.fileName, request.overrides) }
      : { type: request.type, id: request.id, ok: true, result: analyzeBodeBatch(request.captures, request.options, request.overrides) };
  } catch (error) {
    response = { type: request.type, id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  worker.postMessage(response);
};
