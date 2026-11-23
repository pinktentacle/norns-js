// E9-208 — a script's picture, fetched once and kept.
//
// norns.community shows every project with a cover: a screenshot of the norns
// screen, 614x307, at `/covers/<project_name>.png`. They are tiny — `awake`
// is 783 bytes — and there are 355 of them, which is the whole reason a
// script browser can be looked at rather than read.
//
// FETCHED, NOT LINKED. This page is cross-origin isolated, and an `<img>`
// pointed at another origin has to be served with a header GitHub Pages does
// not send; the desktop application's policy allows images from itself and
// nothing else. A `fetch` is allowed in both (the site sends
// `Access-Control-Allow-Origin: *`, and norns.community is already on the
// desktop's short list because the catalogue comes from there), so the bytes
// are fetched and shown from a blob.
//
// KEPT, in the browser's Cache Storage, under the picture's own URL: the
// second time the browser is opened nothing is asked of the network at all.
// Where there is no Cache Storage the pictures are simply fetched again —
// they are a decoration, and a missing decoration must never be an error.
//
// A FEW AT A TIME. Scrolling the whole catalogue asks for hundreds; six in
// flight is what a browser gives one host anyway, and saying so here keeps
// the order: what scrolled into view first arrives first.
//
// E9-209 — AND THE REST BEHIND IT. Waiting for a card to scroll into view
// before asking for its picture is why a shelf scrolled sideways showed a
// row of names first. `warm` asks for a whole page's pictures ahead of
// time, three at a time at most and never in front of one that is being
// looked at: a picture somebody scrolls to while it is still waiting its
// turn is moved to the front. After the first visit they all come out of
// the cache and there is nothing left to wait for.
//
// AND WHAT THE SITE DOES NOT HAVE IS REMEMBERED TOO. A few projects have no
// cover, and asking for a whole page ahead of time would ask for each of
// them again at every opening — a 404 in the console apiece. The absence
// is kept, as an empty answer with the day on it, and asked about again
// after a week in case somebody has drawn one.

export interface CoverStore {
  /** An object URL for the picture, or null when the project has none. */
  url(name: string): Promise<string | null>;
  /** Already resolved, without asking: undefined when it has not been asked for yet. */
  peek(name: string): string | null | undefined;
  /** Fetch these behind whatever is being looked at, in this order. */
  warm(names: readonly string[]): void;
}

export interface CoverStoreOptions {
  /** Where the pictures are. No trailing slash. */
  readonly base?: string;
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** Cache Storage, or null to do without. */
  readonly caches?: Pick<CacheStorage, "open"> | null;
  readonly objectUrl?: (blob: Blob) => string;
  readonly parallel?: number;
  /** How many of those a warm-up may hold. The rest stay free for what is on screen. */
  readonly ahead?: number;
  readonly now?: () => number;
}

export const COVERS_BASE = "https://norns.community/covers";
/** Bumped if what is stored ever has to change shape. */
export const COVERS_CACHE = "norns-js-covers-1";
/** On a kept answer that says "there is none": when that was found out, in ms. */
export const ABSENT_HEADER = "x-norns-js-absent";
export const ABSENT_FOR_MS = 7 * 24 * 3600 * 1000;

export function coverAddress(name: string, base = COVERS_BASE): string {
  return `${base}/${encodeURIComponent(name)}.png`;
}

export function createCoverStore(opts: CoverStoreOptions = {}): CoverStore {
  const base = opts.base ?? COVERS_BASE;
  const doFetch = opts.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
  const storage = opts.caches === undefined ? (globalThis.caches ?? null) : opts.caches;
  const objectUrl = opts.objectUrl ?? ((b: Blob) => URL.createObjectURL(b));
  const parallel = opts.parallel ?? 6;
  const ahead = Math.min(parallel, opts.ahead ?? 3);
  const now = opts.now ?? (() => Date.now());

  const asked = new Map<string, Promise<string | null>>();
  const known = new Map<string, string | null>();
  let cache: Promise<Cache | null> | null = null;
  const opened = (): Promise<Cache | null> =>
    (cache ??= storage === null ? Promise.resolve(null) : storage.open(COVERS_CACHE).then((c) => c, () => null));

  // The queue: a slot is taken while a picture is being read. Two lines
  // for it — what is being looked at, and what is being fetched ahead —
  // and the second never holds more than `ahead` of the slots.
  interface Ticket {
    /** Fetched ahead of being looked at. Cleared when somebody looks. */
    idle: boolean;
    go: (() => void) | null;
    /** Holding a slot. */
    running: boolean;
  }
  let busy = 0;
  let busyAhead = 0;
  const wanted: Ticket[] = [];
  const later = new Map<string, Ticket>();
  const tickets = new Map<string, Ticket>();
  const start = (t: Ticket): void => {
    busy++;
    if (t.idle) busyAhead++;
    t.running = true;
    const go = t.go;
    t.go = null;
    go?.();
  };
  const pump = (): void => {
    while (busy < parallel) {
      const next = wanted.shift();
      if (next !== undefined) {
        start(next);
        continue;
      }
      if (busyAhead >= ahead) return;
      const first = later.entries().next();
      if (first.done === true) return;
      later.delete(first.value[0]);
      start(first.value[1]);
    }
  };
  const slot = (name: string, t: Ticket): Promise<void> =>
    new Promise<void>((go) => {
      t.go = go;
      if (t.idle) later.set(name, t);
      else wanted.push(t);
      pump();
    });
  const release = (t: Ticket): void => {
    busy--;
    if (t.idle) busyAhead--;
    t.running = false;
    pump();
  };
  /** Somebody is looking at it now: out of the second line, into the first. */
  const hurry = (name: string): void => {
    const t = tickets.get(name);
    if (t === undefined || !t.idle) return;
    if (later.delete(name)) {
      t.idle = false;
      wanted.push(t);
      pump();
    } else if (t.running) {
      // Already being fetched: it only stops counting as a warm-up.
      t.idle = false;
      busyAhead--;
      pump();
    } else {
      // Still asking the cache: if it has to fetch, it joins the first line.
      t.idle = false;
    }
  };

  const read = async (name: string, ticket: Ticket): Promise<string | null> => {
    const address = coverAddress(name, base);
    const store = await opened();
    try {
      const kept = await store?.match(address);
      if (kept !== undefined) {
        const absent = kept.headers.get(ABSENT_HEADER);
        if (absent === null) return objectUrl(await kept.blob());
        if (now() - Number(absent) < ABSENT_FOR_MS) return null;
      }
    } catch {
      /* a cache that will not answer is a cache that is not there */
    }
    await slot(name, ticket);
    try {
      const res = await doFetch(address, { mode: "cors", credentials: "omit" });
      if (res.status === 404 && store !== null && store !== undefined) {
        // Not there, which is an answer. Anything else — a 500, a 403 —
        // is the site having a bad minute and is asked again next time.
        try {
          await store.put(address, new Response(null, { headers: { [ABSENT_HEADER]: String(now()) } }));
        } catch {
          /* then it is asked again next time, as it always was */
        }
      }
      if (!res.ok) return null;
      const type = res.headers.get("content-type") ?? "";
      if (type !== "" && !type.startsWith("image/")) return null;
      if (store !== null && store !== undefined) {
        try {
          await store.put(address, res.clone());
        } catch {
          /* full, or refused: it is fetched again next time */
        }
      }
      return objectUrl(await res.blob());
    } catch {
      return null;
    } finally {
      release(ticket);
    }
  };

  const ask = (name: string, idle: boolean): Promise<string | null> => {
    let p = asked.get(name);
    if (p === undefined) {
      const ticket: Ticket = { idle, go: null, running: false };
      tickets.set(name, ticket);
      p = read(name, ticket).then((u) => {
        known.set(name, u);
        tickets.delete(name);
        return u;
      });
      asked.set(name, p);
    } else if (!idle) hurry(name);
    return p;
  };

  return {
    url: (name) => ask(name, false),
    peek: (name) => known.get(name),
    warm(names) {
      for (const n of names) void ask(n, true);
    },
  };
}
