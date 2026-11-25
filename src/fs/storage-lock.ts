// E9-216 — one tab saves at a time.
//
// THE STORE IS SHARED AND THE TREES ARE NOT. Every norns-js tab of one
// origin reads the same OPFS at boot into a Vfs of its own, and from then on
// mirrors ITS OWN changes back out. Two tabs therefore write one store from
// two pictures of it, and the older picture wins whatever it touches last:
// a folder it removes takes the files only the other tab wrote, and the
// sidecars — deletions, empty folders, copied references — are rewritten
// whole from whichever tab flushed most recently. Measured in an isolated
// profile in E9-212's session; on a phone, where an old tab of the page is
// easy to forget and Chrome brings it back, it is an ordinary afternoon.
//
// So one tab holds a Web Lock for as long as it saves. A tab that opens
// while another holds it ASKS for it rather than taking it: the holder
// flushes what it has, stops saving, says so on its own screen, and lets
// go — and only then does the new tab read the store, so it reads
// everything the old one wrote. A holder that does not answer (a frozen
// tab, which cannot run the code that would answer) has the lock taken
// from it after a wait.
//
// The NEWEST tab wins because it is the one in front of the user. The old
// one keeps playing whatever it was playing; it simply no longer writes.
//
// A browser without Web Locks gets what it had before: every tab saves.

export type Claim = "alone" | "handed-over" | "taken" | "unavailable";

/** The subset of `navigator.locks` used, so a test can supply it. */
export interface LocksLike {
  request(
    name: string,
    options: { ifAvailable?: boolean; steal?: boolean; signal?: AbortSignal },
    callback: (lock: unknown) => unknown,
  ): Promise<unknown>;
}

/** The subset of `BroadcastChannel` used. */
export interface ChannelLike {
  postMessage(message: unknown): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

export interface ClaimOptions {
  readonly name?: string;
  readonly locks?: LocksLike | null;
  readonly channel?: ChannelLike | null;
  /** How long a holder is given to flush and hand over before it is taken. */
  readonly waitMs?: number;
  /**
   * Another tab asked. Flush and stop saving; the lock is let go when
   * this resolves.
   */
  readonly onYield: () => Promise<void>;
  /** Another tab took the lock without asking: stop saving NOW. */
  readonly onLost: () => void;
  /** Said once the store turns out to be held, before the wait for it. */
  readonly onAsk?: () => void;
}

const NAME = "norns-js/storage";

function defaultLocks(): LocksLike | null {
  const nav = globalThis.navigator as unknown as { locks?: LocksLike } | undefined;
  return nav?.locks ?? null;
}

function defaultChannel(name: string): ChannelLike | null {
  try {
    return typeof BroadcastChannel === "function"
      ? (new BroadcastChannel(name) as unknown as ChannelLike)
      : null;
  } catch {
    return null;
  }
}

/** Resolves when this tab may read and write the store, saying how it got there. */
export async function claimStorage(opts: ClaimOptions): Promise<Claim> {
  const name = opts.name ?? NAME;
  const locks = opts.locks === undefined ? defaultLocks() : opts.locks;
  if (locks === null) return "unavailable";
  const channel = opts.channel === undefined ? defaultChannel(name) : opts.channel;
  const waitMs = opts.waitMs ?? 10_000;

  let holding = false;
  let release: () => void = () => {};
  const held = new Promise<void>((r) => (release = r));

  // A NEWER TAB ASKING. Answered only while this one holds the lock: a tab
  // still waiting for it has nothing to hand over.
  if (channel !== null) {
    channel.onmessage = (ev) => {
      const data = ev.data as { type?: unknown } | null;
      if (data?.type !== "yield" || !holding) return;
      holding = false;
      void opts
        .onYield()
        .catch(() => {
          /* a flush that fails must not keep the other tab waiting */
        })
        .finally(release);
    };
  }

  /**
   * Ask for the lock. `held` is returned from the callback, so the lock
   * stays ours until `release` — and if it is STOLEN the request's own
   * promise rejects, which is how a tab finds out it no longer saves.
   */
  const ask = (options: { ifAvailable?: boolean; steal?: boolean; signal?: AbortSignal }) =>
    new Promise<boolean>((resolve) => {
      let granted = false;
      locks
        .request(name, options, (lock) => {
          if (lock === null || lock === undefined) {
            resolve(false);
            return undefined;
          }
          granted = true;
          holding = true;
          resolve(true);
          return held;
        })
        .then(
          () => {
            holding = false;
          },
          () => {
            if (!granted) {
              resolve(false); // aborted while waiting
              return;
            }
            if (holding) {
              holding = false;
              opts.onLost();
            }
          },
        );
    });

  if (await ask({ ifAvailable: true })) return "alone";

  opts.onAsk?.();
  channel?.postMessage({ type: "yield" });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), waitMs);
  const handed = await ask({ signal: ac.signal });
  clearTimeout(timer);
  if (handed) return "handed-over";

  await ask({ steal: true });
  return "taken";
}
