// Types for the dependency-free JS the worklet shares with the tests.
export const FLT_EPSILON: number;
export function fmax(a: number, b: number): number;
export function nextClockBeat(clockBeat: number, syncBeat: number, offset?: number): number;
export const NUM_CLOCK_EVENTS: number;
export const MAX_NUM_METROS: number;
export const EVENT_SYNC: number;
export const EVENT_SLEEP: number;
export const FIRED_METRO: number;
export const FIRED_CLOCK: number;
export class ClockScheduler {
  findEvent(threadId: number): unknown;
  scheduleSync(threadId: number, clockBeat: number, syncBeat: number, offset?: number): number | false;
  scheduleSleep(threadId: number, clockTime: number, seconds: number): number | false;
  findEventBeat(threadId: number): number;
  clear(threadId: number): void;
  rescheduleSyncEvents(clockBeat: number): void;
  resetSyncEvents(): void;
  tick(clockBeat: number, clockTime: number, out: number[]): void;
}
export class MetroTable {
  slots: Array<{ running: boolean; seconds: number; count: number; stage: number; next: number }>;
  start(idx: number, seconds: number, count: number, stage: number, now: number): boolean;
  stop(idx: number): boolean;
  setTime(idx: number, seconds: number): boolean;
  tick(now: number, out: number[]): void;
}
