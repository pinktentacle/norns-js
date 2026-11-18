// E9-107 — several installs at once, and the two things that had to be true
// first.
//
// E9-21 chose a queue over parallel installs, and gave three reasons. Two of
// them were about the interface and have since been built (every row carries
// its own state, and `cancel all` speaks for the lot). The third was real and
// is the one these tests close:
//
//     two installs of the same name share `.installing/<name>`, and the
//     first to finish sweeps it while the second is still writing
//
// — which is the exact half-script the staging directory exists to prevent.
// The queue's own de-duplication never covered it, because the URL box runs
// outside the queue and a dependency is enqueued while the script that needs
// it is already running.
//
// The fourth concern was somebody else's CDN: eight files at a time per
// install, three installs at once, is twenty-four requests where there used
// to be eight. A single shared budget is what keeps that at twelve.
//
// Everything here runs against fake fetchers, so these are statements about
// the installer's own shape rather than about jsDelivr on the day.

import { describe, expect, it } from "vitest";
import { installFromRepo } from "../src/community/install.js";
import { Vfs } from "../src/fs/vfs.js";

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** A repository of `n` Lua files, which is what the listing endpoint returns. */
const listingOf = (n: number): unknown => ({
  files: Array.from({ length: n }, (_, i) => ({
    name: `/lib/f${i}.lua`,
    size: 10,
  })),
});

describe("installs that run at the same time", () => {
  it("never lets two of the SAME name overlap", async () => {
    const vfs = new Vfs();
    // Every fetch looks at the staging directory while it is in flight. If
    // two installs of one name ever ran together, one of them would see the
    // other's files there — and the loser's sweep would take them.
    let peak = 0;
    let open = 0;
    const seenTogether: string[] = [];
    const fetchBytes = async (): Promise<Uint8Array> => {
      open++;
      peak = Math.max(peak, open);
      await sleep(1);
      const staged = vfs.walk("/home/we/dust/.installing");
      // One install at a time means one staging directory at a time.
      const dirs = new Set(staged.map((p) => p.split("/")[5]));
      if (dirs.size > 1) seenTogether.push([...dirs].join("+"));
      open--;
      return new TextEncoder().encode("-- x");
    };

    const both = await Promise.all([
      installFromRepo(
        vfs,
        { owner: "a", repo: "same" },
        {
          name: "same",
          fetchJson: async () => listingOf(12),
          fetchBytes,
        },
      ),
      installFromRepo(
        vfs,
        { owner: "a", repo: "same" },
        {
          name: "same",
          fetchJson: async () => listingOf(12),
          fetchBytes,
        },
      ),
    ]);

    expect(seenTogether, "two installs shared the staging directory").toEqual(
      [],
    );
    // Both finish, and both report the whole script: the second waits and
    // then reinstalls over the first rather than being refused.
    expect(both.map((r) => r.files)).toEqual([12, 12]);
    expect(vfs.walk("/home/we/dust/code/same")).toHaveLength(12);
    // And nothing is left behind by either of them.
    expect(vfs.walk("/home/we/dust/.installing")).toEqual([]);
    expect(peak).toBeGreaterThan(1); // the pool inside one install still works
  });

  it("lets DIFFERENT names overlap, which is the whole point", async () => {
    const vfs = new Vfs();
    const live = new Set<string>();
    let bothAtOnce = false;
    const fetchFor = (who: string) => async (): Promise<Uint8Array> => {
      live.add(who);
      await sleep(2);
      if (live.size > 1) bothAtOnce = true;
      return new TextEncoder().encode("-- x");
    };

    await Promise.all(
      ["one", "two"].map((n) =>
        installFromRepo(
          vfs,
          { owner: "a", repo: n },
          {
            name: n,
            fetchJson: async () => listingOf(4),
            fetchBytes: fetchFor(n),
          },
        ),
      ),
    );

    expect(bothAtOnce, "the two installs did not overlap at all").toBe(true);
    expect(vfs.walk("/home/we/dust/code/one")).toHaveLength(4);
    expect(vfs.walk("/home/we/dust/code/two")).toHaveLength(4);
  });

  it("holds every install to ONE budget of requests, not one each", async () => {
    // Four installs of forty files each. Without a shared budget this is
    // four pools of eight — thirty-two requests on somebody else's CDN for
    // one person's click.
    const vfs = new Vfs();
    let open = 0;
    let peak = 0;
    const fetchBytes = async (): Promise<Uint8Array> => {
      open++;
      peak = Math.max(peak, open);
      await sleep(1);
      open--;
      return new TextEncoder().encode("-- x");
    };

    await Promise.all(
      ["a", "b", "c", "d"].map((n) =>
        installFromRepo(
          vfs,
          { owner: "o", repo: n },
          {
            name: n,
            fetchJson: async () => listingOf(40),
            fetchBytes,
          },
        ),
      ),
    );

    expect(peak).toBeLessThanOrEqual(12);
    // And it is actually using the budget rather than accidentally
    // serialising: a ceiling nobody reaches proves nothing.
    expect(peak).toBeGreaterThan(8);
    for (const n of ["a", "b", "c", "d"]) {
      expect(vfs.walk(`/home/we/dust/code/${n}`)).toHaveLength(40);
    }
  });

  it("gives up on one without taking the others down", async () => {
    const vfs = new Vfs();
    const ac = new AbortController();
    // The url carries the repository's name — `…/gh/o/doomed@main/lib/f0.lua`
    // — so one fetcher can serve both installs and give up on one of them.
    const slow = async (
      url: string,
      signal?: AbortSignal,
    ): Promise<Uint8Array> => {
      if (url.includes("/doomed@")) {
        ac.abort();
        await sleep(2);
        if (signal?.aborted === true)
          throw new DOMException("aborted", "AbortError");
      }
      await sleep(1);
      return new TextEncoder().encode("-- x");
    };

    const [doomed, fine] = await Promise.allSettled([
      installFromRepo(
        vfs,
        { owner: "o", repo: "doomed" },
        {
          name: "doomed",
          signal: ac.signal,
          fetchJson: async () => listingOf(8),
          fetchBytes: slow,
        },
      ),
      installFromRepo(
        vfs,
        { owner: "o", repo: "fine" },
        {
          name: "fine",
          fetchJson: async () => listingOf(8),
          fetchBytes: slow,
        },
      ),
    ]);

    expect(doomed.status).toBe("rejected");
    expect(fine.status).toBe("fulfilled");
    expect(vfs.walk("/home/we/dust/code/fine")).toHaveLength(8);
    // The cancelled one leaves NOTHING: not a folder in `code/`, which
    // SELECT would offer, and not a staging directory either.
    expect(vfs.walk("/home/we/dust/code/doomed")).toEqual([]);
    expect(vfs.walk("/home/we/dust/.installing")).toEqual([]);
  });
});
