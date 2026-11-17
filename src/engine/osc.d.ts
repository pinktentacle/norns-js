// The OSC 1.0 codec from E0-18, moved into the product unchanged.
//
// sclang-wasm exposes OSC as raw bytes — `sendOsc(Uint8Array)` in,
// `onOsc(Uint8Array)` out — because there is no socket. int32, float32 and
// string are the whole of what norns sends.
export interface OscMessage {
  address: string;
  args: Array<number | string | Uint8Array>;
}
export interface OscBundle {
  bundle: OscMessage[];
  timetag?: number;
}
export function encodeMessage(address: string, args?: ReadonlyArray<number | string | Uint8Array>): Uint8Array;
export function decode(bytes: Uint8Array): OscMessage | OscBundle;
