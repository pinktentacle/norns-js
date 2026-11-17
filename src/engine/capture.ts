// E4-01 — get hold of the AudioContext and the worklet node scsynth builds.
//
// `scsynth.getAudioContext()` and `getScsynthWorkletNode()` return emscripten
// WebAudio **handles** — plain integers — and this build does not export
// `emscriptenGetAudioObject` to resolve them. So the real objects are captured
// as they are constructed.
//
// THIS MODULE MUST BE IMPORTED BEFORE THE WASM MODULES. It patches globals at
// evaluation time, and a context constructed before the patch is invisible to
// it. `host.ts` imports it statically and loads the wasm dynamically, which is
// what keeps the order right.
//
// Patching `AudioNode.prototype.connect` is the decisive part. Constructor
// patching says a node EXISTS; only the connect patch says which node is
// actually feeding the speakers, and that is the one worth measuring.

export interface Captured {
  readonly ctxs: AudioContext[];
  readonly nodes: AudioWorkletNode[];
  /** Whatever was connected to a context's destination, in order. */
  readonly toDestination: AudioNode[];
}

export const captured: Captured = { ctxs: [], nodes: [], toDestination: [] };

let installed = false;

/** Idempotent: a second call does nothing rather than double-wrapping. */
export function installCapture(): void {
  if (installed) return;
  installed = true;

  const g = globalThis as unknown as Record<string, unknown>;
  const RealCtx = (g["AudioContext"] ?? g["webkitAudioContext"]) as typeof AudioContext | undefined;
  const RealNode = g["AudioWorkletNode"] as typeof AudioWorkletNode | undefined;

  if (RealCtx) {
    g["AudioContext"] = class extends RealCtx {
      constructor(...args: ConstructorParameters<typeof AudioContext>) {
        super(...args);
        (captured.ctxs as AudioContext[]).push(this);
      }
    };
  }
  if (RealNode) {
    g["AudioWorkletNode"] = class extends RealNode {
      constructor(...args: ConstructorParameters<typeof AudioWorkletNode>) {
        super(...args);
        (captured.nodes as AudioWorkletNode[]).push(this);
      }
    };
  }

  if (typeof AudioNode !== "undefined") {
    const realConnect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (this: AudioNode, dest: never, ...rest: never[]) {
      try {
        const d = dest as unknown as AudioNode;
        if (d && d === d.context?.destination) (captured.toDestination as AudioNode[]).push(this);
      } catch {
        /* not an AudioNode destination; a param or a number */
      }
      return realConnect.call(this, dest, ...rest);
    } as typeof AudioNode.prototype.connect;
  }
}
