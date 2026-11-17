export const RECORD: number;
export const HEADER: number;
export const EV_METRO: number;
export const EV_CLOCK: number;
export const EV_STALL: number;
export function ringCapacity(records?: number): number;
export interface Ring { idx: Int32Array; data: Float64Array; records: number }
export function ringViews(sab: SharedArrayBuffer, records?: number): Ring;
export function ringPush(ring: Ring, type: number, a: number, b: number, c?: number): boolean;
export function ringDrain(ring: Ring, fn: (type: number, a: number, b: number, c: number) => void): number;
