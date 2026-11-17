export class ClockCore {
  constructor(sampleRate: number);
  sampleRate: number;
  frames: number;
  time: number;
  beat: number;
  tempo: number;
  running: boolean;
  readonly beatDuration: number;
  setTempo(bpm: number, now?: number): void;
  /** `clock_update_source_reference`: an external beat AND rate at once. */
  setSourceReference(beat: number, beatDuration: number, now?: number): void;
  beatAt(frame: number): number;
  start(): void;
  stop(): void;
  advance(frames: number, wall: number): number;
}
