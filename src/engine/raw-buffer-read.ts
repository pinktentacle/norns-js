// E9-260 — `/b_read` and friends, sent to the server by hand.
//
// sclang's `Buffer.read` family is redirected to the page (NornsJsBuffer-
// Override.sc → buffers.ts), because scsynth here has no libsndfile and its
// MEMFS is not the VFS. An engine that writes the OSC itself goes past
// that: twins loads its samples with
//
//     s.sendMsg("/b_readChannel", bl.bufnum, path, pos, next - pos, pos, 0, 0);
//
// into a buffer it allocated, a megaframe at a time, and scsynth answered
// "scsynth compiled without libsndfile" — the buffers stayed silent. So the
// four commands are recognised on their way to the server and done by the
// same loader instead. This file only reads them.

import { decode } from "./osc.js";

export interface RawBufferRead {
  /** The OSC address, for the `/done` reply. */
  readonly cmd: string;
  readonly bufnum: number;
  readonly path: string;
  /** First frame of the file. */
  readonly fileStart: number;
  /** -1 (or anything negative) is "to the end", as in scsynth. */
  readonly numFrames: number;
  /** First frame of the buffer written to; 0 for the alloc forms. */
  readonly bufStart: number;
  /** `/b_allocRead*` allocates; `/b_read*` writes into the buffer as it is. */
  readonly alloc: boolean;
  /** Channels to keep (the `*Channel` forms); empty is all of them. */
  readonly channels: readonly number[];
  /** The completion message, sent to the server when the read is done. */
  readonly completion: Uint8Array | null;
}

const CMDS = new Set(["/b_read", "/b_readChannel", "/b_allocRead", "/b_allocReadChannel"]);

/** The read a packet asks for, or null — for any packet, cheaply. */
export function rawBufferReadOf(bytes: Uint8Array): RawBufferRead | null {
  // "/b_" — every other packet is turned away on its first three bytes.
  if (bytes.length < 8 || bytes[0] !== 0x2f || bytes[1] !== 0x62 || bytes[2] !== 0x5f) return null;
  let m: ReturnType<typeof decode>;
  try {
    m = decode(bytes);
  } catch {
    return null;
  }
  if (!("address" in m) || !CMDS.has(m.address)) return null;
  const a = m.args ?? [];
  const last = a[a.length - 1];
  const completion = last instanceof Uint8Array ? last : null;
  const body = completion !== null ? a.slice(0, -1) : a;
  const num = (i: number, d: number): number => (typeof body[i] === "number" ? (body[i] as number) : d);
  const alloc = m.address.startsWith("/b_alloc");
  const rest = alloc ? body.slice(4) : body.slice(6);
  return {
    cmd: m.address,
    bufnum: num(0, -1),
    path: typeof body[1] === "string" ? body[1] : "",
    fileStart: num(2, 0),
    numFrames: num(3, -1),
    bufStart: alloc ? 0 : num(4, 0),
    alloc,
    channels: m.address.endsWith("Channel") ? rest.filter((x): x is number => typeof x === "number") : [],
    completion,
  };
}
