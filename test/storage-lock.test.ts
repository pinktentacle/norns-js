// E9-216 — one tab saves at a time.
//
// The fakes below follow the Web Locks rules this code leans on: one holder
// at a time, `ifAvailable` answers null rather than waiting, a waiting
// request can be aborted, and `steal` takes the lock and REJECTS the old
// holder's request — which is the only way a tab learns it was taken from.

import { describe, expect, it } from "vitest";
import { claimStorage, type ChannelLike, type LocksLike } from "../src/fs/storage-lock.js";

class FakeLocks implements LocksLike {
  private holder: { fail: (e: unknown) => void } | null = null;
  private readonly queue: Array<() => void> = [];

  request(
    _name: string,
    options: { ifAvailable?: boolean; steal?: boolean; signal?: AbortSignal },
    callback: (lock: unknown) => unknown,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const grant = (): void => {
        let settled = false;
        const me = {
          fail: (e: unknown) => {
            if (!settled) {
              settled = true;
              reject(e);
            }
          },
        };
        this.holder = me;
        void Promise.resolve(callback({})).then((v) => {
          if (this.holder === me) {
            this.holder = null;
            this.queue.shift()?.();
          }
          if (!settled) {
            settled = true;
            resolve(v);
          }
        });
      };
      if (options.steal === true) {
        const old = this.holder;
        this.holder = null;
        old?.fail(new Error("stolen"));
        grant();
        return;
      }
      if (this.holder === null) return grant();
      if (options.ifAvailable === true) {
        void Promise.resolve(callback(null)).then(resolve, reject);
        return;
      }
      const entry = (): void => grant();
      this.queue.push(entry);
      options.signal?.addEventListener("abort", () => {
        const i = this.queue.indexOf(entry);
        if (i >= 0) {
          this.queue.splice(i, 1);
          reject(new Error("aborted"));
        }
      });
    });
  }
}

/** Channels that hear each other, as tabs of one origin do. */
function channelPair(): () => ChannelLike {
  const all: ChannelLike[] = [];
  return () => {
    const c: ChannelLike = {
      onmessage: null,
      postMessage(message) {
        for (const o of all) if (o !== c) queueMicrotask(() => o.onmessage?.({ data: message }));
      },
    };
    all.push(c);
    return c;
  };
}

describe("one tab saves at a time", () => {
  it("is alone when no other tab holds the store", async () => {
    const locks = new FakeLocks();
    const got = await claimStorage({
      locks,
      channel: null,
      onYield: async () => {},
      onLost: () => {},
    });
    expect(got).toBe("alone");
  });

  it("asks the tab already open to save and let go, and reads only after", async () => {
    const locks = new FakeLocks();
    const channel = channelPair();
    const events: string[] = [];
    const a = await claimStorage({
      locks,
      channel: channel(),
      onYield: async () => {
        await Promise.resolve();
        events.push("A flushed and stopped");
      },
      onLost: () => events.push("A lost it"),
    });
    expect(a).toBe("alone");

    const b = await claimStorage({
      locks,
      channel: channel(),
      onYield: async () => {},
      onLost: () => {},
    });
    events.push("B may read");
    expect(b).toBe("handed-over");
    expect(events, "the old tab saved BEFORE the new one read").toEqual([
      "A flushed and stopped",
      "B may read",
    ]);
  });

  it("takes it from a tab that does not answer, and that tab is told", async () => {
    const locks = new FakeLocks();
    let lost = false;
    // A frozen tab: it holds the lock and cannot hear anything.
    await claimStorage({ locks, channel: null, onYield: async () => {}, onLost: () => (lost = true) });
    const got = await claimStorage({
      locks,
      channel: channelPair()(),
      waitMs: 20,
      onYield: async () => {},
      onLost: () => {},
    });
    expect(got).toBe("taken");
    await Promise.resolve();
    expect(lost).toBe(true);
  });

  it("does nothing where the browser has no Web Locks: every tab saves, as before", async () => {
    const got = await claimStorage({ locks: null, onYield: async () => {}, onLost: () => {} });
    expect(got).toBe("unavailable");
  });
});
