// The OSC 1.0 codec from E0-18, moved into the product unchanged.
//
// sclang-wasm exposes OSC as raw bytes — `sendOsc(Uint8Array)` in,
// `onOsc(Uint8Array)` out — because there is no socket. int32, float32 and
// string are most of what norns sends; booleans and nil (T, F, N) are what
// matron's osc.send adds (E9-274).
export interface OscMessage {
  address: string;
  args: Array<number | string | Uint8Array | boolean | null>;
}
export interface OscBundle {
  bundle: OscMessage[];
  timetag?: number;
}
/** A number written as an OSC float even when it is whole, as matron's osc.send writes every number. */
export class OscFloat {
  constructor(value: number);
  readonly value: number;
}
export function encodeMessage(
  address: string,
  args?: ReadonlyArray<number | string | Uint8Array | boolean | null | OscFloat>,
): Uint8Array;
export function decode(bytes: Uint8Array): OscMessage | OscBundle;
