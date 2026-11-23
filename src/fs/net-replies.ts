/**
 * E9-203 — THE REPLY TO A `curl` A SCRIPT WANTS TO READ.
 *
 * Three scripts in the catalogue ask a public service something and play
 * the answer — the weather, the CO2 at Mauna Loa, where the space station
 * is — with `util.os_capture("curl -s …")`. All three services welcome a
 * browser. What was missing was never the capability: it was that the call
 * is synchronous and a page cannot stop and wait.
 *
 * IT DOES NOT HAVE TO STOP. Every one of them makes the call from a clock
 * coroutine, and a coroutine can be put to sleep until the reply is in.
 * So this holds the request while it is in flight and hands the body over
 * when asked; the Lua side (`_njs_await_reply`) does the sleeping. Nothing
 * blocks — which the hardware cannot say, where matron stands still for as
 * long as curl takes.
 *
 * A CALLER THAT CANNOT SLEEP gets what a download gets (E9-37): nothing
 * this time, and the reply the next time it asks the same thing.
 *
 * WHAT IT WILL NOT DO. A service that does not send
 * `Access-Control-Allow-Origin` cannot be read by any page, and there is
 * no relay here to pretend otherwise. No cookies are ever sent.
 */

import type { ShellRequest } from "./shell.js";

export interface NetReplies {
  /**
   * A finished reply to this exact command, if one is waiting — handed
   * over once. Null when there is none.
   */
  take(command: string): string | null;
  /** Begin, or join the request already in flight for this command. */
  start(command: string, request: ShellRequest): number;
  /** Where a request stands. A finished one is handed over once. */
  poll(token: number): { readonly done: boolean; readonly body: string };
  /** The caller cannot wait: keep the reply for its next identical call. */
  leave(token: number): void;
  /** Run `then` with the body when it is in — for `system_cmd`'s callback. */
  whenDone(token: number, then: (body: string) => void): void;
}

export interface NetRepliesOptions {
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  readonly now: () => number;
  readonly log: (line: string) => void;
  /** Is this page served over https? Then a plain-http URL would be refused. */
  readonly secure?: () => boolean;
  /**
   * Did this application's OWN policy refuse that host? The desktop build
   * allows a list of hosts and nothing else, and a refusal that blamed the
   * service for it would send somebody looking in the wrong place.
   */
  readonly refusedByPolicy?: (host: string) => boolean;
  /** How long an unclaimed reply is kept. */
  readonly keepMs?: number;
  /** The largest body handed to Lua. */
  readonly maxBytes?: number;
}

interface Entry {
  readonly command: string;
  done: boolean;
  body: string;
  finishedAt: number;
  /** Nobody is waiting on it: it is for the next identical call. */
  left: boolean;
  waiters: ((body: string) => void)[];
}

export const KEEP_MS = 5 * 60 * 1000;
export const MAX_BYTES = 8 * 1024 * 1024;
/** The same refusal from the same host is said once in this long. */
export const SAY_AGAIN_MS = 5 * 60 * 1000;

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 60);
  }
};

export function createNetReplies(opts: NetRepliesOptions): NetReplies {
  const keepMs = opts.keepMs ?? KEEP_MS;
  const maxBytes = opts.maxBytes ?? MAX_BYTES;
  const byToken = new Map<number, Entry>();
  const byCommand = new Map<string, number>();
  const said = new Map<string, number>();
  let next = 1;

  const say = (key: string, line: string): void => {
    const now = opts.now();
    const last = said.get(key);
    if (last !== undefined && now - last < SAY_AGAIN_MS) return;
    said.set(key, now);
    opts.log(line);
  };

  const drop = (token: number): void => {
    const e = byToken.get(token);
    if (e === undefined) return;
    byToken.delete(token);
    if (byCommand.get(e.command) === token) byCommand.delete(e.command);
  };

  const sweep = (): void => {
    const now = opts.now();
    for (const [token, e] of byToken) if (e.done && now - e.finishedAt > keepMs) drop(token);
  };

  const finish = (token: number, body: string): void => {
    const e = byToken.get(token);
    if (e === undefined) return;
    e.done = true;
    e.body = body;
    e.finishedAt = opts.now();
    const waiters = e.waiters;
    e.waiters = [];
    if (waiters.length > 0) {
      drop(token);
      for (const w of waiters) w(body);
    }
  };

  return {
    take(command) {
      sweep();
      const token = byCommand.get(command);
      if (token === undefined) return null;
      const e = byToken.get(token);
      if (e === undefined || !e.done || !e.left) return null;
      drop(token);
      return e.body;
    },

    start(command, request) {
      const running = byCommand.get(command);
      if (running !== undefined && byToken.get(running)?.done === false) return running;
      if (running !== undefined) drop(running);
      const token = next++;
      byToken.set(token, { command, done: false, body: "", finishedAt: 0, left: false, waiters: [] });
      byCommand.set(command, token);

      // curl speaks plain http to a host with no scheme, and a page served
      // over https may not. The upgrade is a guess that is nearly always
      // right, and when it is wrong the refusal below says what was asked.
      const url =
        opts.secure?.() === true && request.url.startsWith("http://")
          ? `https://${request.url.slice("http://".length)}`
          : request.url;
      const host = hostOf(url);
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), request.timeoutMs);
      void (async () => {
        try {
          const res = await opts.fetch(url, {
            method: "GET",
            headers: { ...request.headers },
            credentials: "omit",
            cache: "no-store",
            redirect: "follow",
            signal: abort.signal,
          });
          const text = await res.text();
          if (text.length > maxBytes) {
            say(`big:${host}`, `curl: the reply from ${host} is ${(text.length / 1048576).toFixed(1)} MB, over what a script is handed here`);
            finish(token, "");
            return;
          }
          say(`ok:${host}`, `curl: ${host} answered, ${text.length} bytes${res.ok ? "" : ` (HTTP ${res.status})`}`);
          finish(token, text);
        } catch (e) {
          // The browser reports a policy refusal on its own event, a turn
          // after the fetch has failed.
          await new Promise((r) => setTimeout(r, 0));
          const why = abort.signal.aborted
            ? `no reply within ${(request.timeoutMs / 1000).toFixed(0)} s`
            : opts.refusedByPolicy?.(host) === true
              ? "this application only lets a script reach the hosts on its own list, and that is not one"
              : "it is unreachable, or it does not allow a page to read it";
          say(`no:${host}`, `curl: nothing could be read from ${host} — ${why}`);
          void e;
          finish(token, "");
        } finally {
          clearTimeout(timer);
        }
      })();
      return token;
    },

    poll(token) {
      const e = byToken.get(token);
      // Unknown is finished: a waiter must never be left asking for ever.
      if (e === undefined) return { done: true, body: "" };
      if (!e.done) return { done: false, body: "" };
      drop(token);
      return { done: true, body: e.body };
    },

    leave(token) {
      const e = byToken.get(token);
      if (e === undefined) return;
      e.left = true;
      say(
        "leave",
        "curl: asked from outside a clock coroutine, where nothing can wait — " +
          "the reply will be there the next time the same thing is asked",
      );
    },

    whenDone(token, then) {
      const e = byToken.get(token);
      if (e === undefined) return void then("");
      if (e.done) {
        drop(token);
        return void then(e.body);
      }
      e.waiters.push(then);
    },
  };
}
