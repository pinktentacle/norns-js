/**
 * E9-212 — scsynth's `sendOsc` IS NEVER ENTERED TWICE AT ONCE.
 *
 * The page froze for good — no frame, no CDP evaluate, the tab had to be
 * closed — when a script fired short synths while buffers were loading.
 * Paused in the debugger, the main thread was always in the same place:
 *
 *     buffers.read -> sendToServer -> scsynth.sendOsc
 *       -> ProcessOSCPacket       takes mDriverLock
 *       -> MsgFifo::Free -> free  the malloc lock is busy: wait
 *       -> _emscripten_yield      runs queued main-thread calls
 *       -> onOscReply -> onServerOsc -> pump -> forward
 *       -> scsynth.sendOsc
 *       -> ProcessOSCPacket       mDriverLock, held by the frame above
 *
 * The main thread cannot block, so emscripten makes it spin, and while it
 * spins it runs whatever the worker threads have queued for it — scsynth's
 * replies and sclang's packets, which is JavaScript, which sends OSC. A
 * second `sendOsc` then waits for a mutex that its own caller holds, and
 * waits for ever. `free` only waits when another scsynth thread holds the
 * allocator for longer than musl's short spin, so it takes many sends (a
 * buffer load is thousands of `/b_setn`), server threads busy allocating,
 * and a machine busy enough to preempt them. Reproduced with every core
 * loaded: 3 freezes in 4 runs before this, 0 in 8 after.
 *
 * `pump` is the path the debugger caught, but it is not the only one: a
 * reply relayed to sclang can run sclang's own queue the same way, and
 * that queue is full of packets for the server. So the fix is not at any
 * one caller. It is here: a send that arrives while one is in progress
 * waits in this queue and goes out, in order, as soon as the outer one
 * returns — still in the same task, so nothing is delayed by more than
 * the call it waited for.
 *
 * sclang's `sendOsc` needs none of this. It holds no lock of its own
 * across anything that can wait, so entering it twice is safe.
 */

export interface SerialisedSend<T> {
  (packet: T): void;
  /** Sends that arrived while another was in progress, and waited. */
  readonly deferred: number;
}

export function serialiseSend<T>(send: (packet: T) => void): SerialisedSend<T> {
  let busy = false;
  let deferred = 0;
  const waiting: T[] = [];

  const guarded = (packet: T): void => {
    if (busy) {
      waiting.push(packet);
      deferred++;
      return;
    }
    busy = true;
    try {
      // Anything left over from a send that threw goes first, so a failure
      // never reorders what follows it.
      if (waiting.length === 0) send(packet);
      else waiting.push(packet);
      while (waiting.length > 0) send(waiting.shift()!);
    } finally {
      busy = false;
    }
  };

  return Object.defineProperty(guarded, "deferred", { get: () => deferred }) as SerialisedSend<T>;
}
