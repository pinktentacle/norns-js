// E9-271 — the server's control buses, as a Float32Array the language can read.
//
// On a norns `Bus:getSynchronous` reads scsynth's shared memory segment. Here
// scsynth's heap is a SharedArrayBuffer this page holds, and the world keeps
// its control buses at `world->mControlBus`; scsynth reports that offset and
// the count (`controlBusOffset` / `controlBusCount`, SC_WebAudio.cpp). sclang's
// `_NornsJsControlBusGet` / `_NornsJsControlBusSet` (SC_WasmClient.cpp) call
// `globalThis.__nornsJsControlBuses()` on the main thread and read or write
// through the view it returns, now, as the shm interface does.

export interface ScsynthBuses {
  readonly HEAPU8?: Uint8Array;
  controlBusOffset?: () => number;
  controlBusCount?: () => number;
}

/**
 * A function answering the control-bus view, or null while the world does not
 * exist yet (the offset is 0 until scsynth has booted) or when this build of
 * scsynth does not report it. The view is rebuilt when the heap's buffer is
 * replaced (memory growth) and otherwise reused.
 */
export function controlBusView(mod: ScsynthBuses): () => Float32Array | null {
  let view: Float32Array | null = null;
  return () => {
    const heap = mod.HEAPU8;
    if (heap === undefined || typeof mod.controlBusOffset !== "function" || typeof mod.controlBusCount !== "function") {
      return null;
    }
    if (view !== null && view.buffer === heap.buffer) return view;
    const offset = mod.controlBusOffset();
    const count = mod.controlBusCount();
    if (!offset || !count || offset % 4 !== 0 || offset + count * 4 > heap.buffer.byteLength) return null;
    view = new Float32Array(heap.buffer, offset, count);
    return view;
  };
}

/** Where sclang's primitives look for it. */
export function installControlBusView(mod: ScsynthBuses): void {
  (globalThis as { __nornsJsControlBuses?: () => Float32Array | null }).__nornsJsControlBuses = controlBusView(mod);
}
