// E9-217 — ask the browser to keep what is installed, when something is.
//
// An origin that has not called `navigator.storage.persist()` is
// BEST-EFFORT: the browser may clear all of it when the device runs short of
// space, and Android does — a script collection gone between two sessions,
// with nothing said (E9-137). The boot only REPORTS which of the two kinds
// of storage the page stands on, because Firefox answers `persist()` with a
// prompt and a prompt on page load is not ours to spend.
//
// An install is the moment it is ours to spend: somebody has just asked the
// page to keep something. So the first install of a session asks, once.
// Chrome never prompts — it grants or declines on its own (an installed
// app, a bookmarked or much-used site) — and Firefox asks the person, who
// has just pressed install and knows why.
//
// CALLED FROM THE CLICK, BEFORE ANY AWAIT. A browser that wants a user
// gesture for this counts only the synchronous part of the handler, so the
// request is made first and its answer read afterwards. `persist()` on an
// origin already kept answers true without asking anything, so there is no
// `persisted()` check in front of it to spend the gesture on.

export interface StorageLike {
  persist?(): Promise<boolean>;
}

export interface KeepStorageOptions {
  /** `navigator.storage` unless given; null for a browser without it. */
  readonly storage?: StorageLike | null;
  readonly log?: (line: string) => void;
}

/** Returns the function to call at the start of every install. */
export function createKeepStorage(opts: KeepStorageOptions = {}): () => void {
  let asked = false;
  return () => {
    if (asked) return;
    asked = true;
    const storage =
      opts.storage === undefined
        ? ((globalThis.navigator as unknown as { storage?: StorageLike } | undefined)?.storage ?? null)
        : opts.storage;
    if (typeof storage?.persist !== "function") return;
    let answer: Promise<boolean>;
    try {
      answer = storage.persist();
    } catch {
      return; // a browser that throws here is a browser that keeps nothing more
    }
    void answer.then(
      (kept) =>
        opts.log?.(
          kept
            ? "storage: persistent now — the browser will not clear installed scripts to make room"
            : "storage: the browser declined to keep it for good; it stays best-effort",
        ),
      () => {
        /* no answer is the answer it already had */
      },
    );
  };
}
