// Types for events.js, which is plain JavaScript because it is concatenated
// into a classic AudioWorklet script as well as imported here. Same
// arrangement as src/clock/ring.d.ts and for the same reason.

export const EV_VU: number;
export const EV_TAPE_STATUS: number;
export const EV_TAPE_FILE: number;
export const EV_SOFTCUT_PHASE: number;
export const EV_SOFTCUT_POSITION: number;
export const EV_SOFTCUT_RENDER: number;
export const SLOTS: number;

export type CroneEvent =
  | { type: "vu"; levels: number[] }
  | {
      type: "tapeStatus";
      playState: number;
      playPos: number;
      playLen: number;
      recState: number;
      recPos: number;
      loop: number;
    }
  | { type: "tapeFile"; kind: number }
  | { type: "softcutPhase"; voice: number; value: number }
  | { type: "softcutPosition"; voice: number; value: number }
  | { type: "softcutRender"; channel: number; secPerSample: number; start: number; count: number };

/** `null` for a type this build does not know — a wasm/JS version skew. */
export function decodeRecord(r: Float32Array): CroneEvent | null;
export function decodeBatch(records: Float32Array): CroneEvent[];
