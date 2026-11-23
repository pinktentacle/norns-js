// E9-203 — a `curl` whose output a script reads.
//
// Three catalogue scripts ask a public service something and play the
// answer: avonlea (open-meteo), ppm_norns (global-warming.org) and ufo
// (wheretheiss.at). All three services welcome a browser, checked with an
// Origin header. What was missing was a way to wait — and all three call
// from a clock coroutine, which can sleep.
//
// The last block runs the real thing: norns' own Lua, its own `clock.run`
// and `util.os_capture`, in the interpreter the page uses.

import { beforeEach, describe, expect, it } from "vitest";
import { createHost, boot, type Host } from "../src/lua/host.js";
import { loadNornsLua, loadConfig } from "../src/lua/host-node.js";
import { registerFs } from "../src/fs/register.js";
import { Vfs } from "../src/fs/vfs.js";
import { runShell } from "../src/fs/shell.js";
import { SAY_AGAIN_MS, createNetReplies, type NetReplies } from "../src/fs/net-replies.js";

interface Wire {
  net: NetReplies;
  asked: { url: string; init: RequestInit }[];
  lines: string[];
  t: number;
  /** Answer the oldest request still open. */
  answer(body: string, status?: number): Promise<void>;
  fail(): Promise<void>;
}

function wire(opts: { secure?: boolean; maxBytes?: number } = {}): Wire {
  const open: { ok: (r: Response) => void; no: (e: Error) => void }[] = [];
  const w: Wire = {
    asked: [],
    lines: [],
    t: 0,
    net: undefined as unknown as NetReplies,
    async answer(body, status = 200) {
      open.shift()!.ok(new Response(body, { status }));
      await new Promise((r) => setTimeout(r, 0));
    },
    async fail() {
      open.shift()!.no(new TypeError("Failed to fetch"));
      // Two turns: the refusal waits one for the browser's own policy event.
      await new Promise((r) => setTimeout(r, 5));
    },
  };
  w.net = createNetReplies({
    fetch: (url, init) => {
      w.asked.push({ url, init });
      return new Promise<Response>((ok, no) => {
        open.push({ ok, no });
        init.signal?.addEventListener("abort", () => no(new DOMException("aborted", "AbortError")));
      });
    },
    now: () => w.t,
    log: (l) => w.lines.push(l),
    secure: () => opts.secure ?? false,
    ...(opts.maxBytes === undefined ? {} : { maxBytes: opts.maxBytes }),
  });
  return w;
}

const REQ = { url: "https://api.example/x", headers: {}, timeoutMs: 30000 };

describe("what the shell makes of a curl", () => {
  const ask = (cmd: string) => runShell(new Vfs(), cmd);

  it("takes a curl with nowhere to put its output as a request to read it", () => {
    // ppm_norns and ufo, word for word.
    const r = ask("curl -s -m 30 -k https://global-warming.org/api/co2-api");
    expect(r.ok).toBe(false);
    expect(r.request).toEqual({ url: "https://global-warming.org/api/co2-api", headers: {}, timeoutMs: 30000 });
    expect(r.fetch).toBeUndefined();
  });

  it("finds a url that is quoted", () => {
    // avonlea. The pattern used to be run with the quote still on, and the
    // command "had no url".
    const r = ask(
      "curl -s --connect-timeout 5 --max-time 10 'https://api.open-meteo.com/v1/forecast?latitude=46.2&longitude=-63.1&current=weather_code'",
    );
    expect(r.request?.url).toBe(
      "https://api.open-meteo.com/v1/forecast?latitude=46.2&longitude=-63.1&current=weather_code",
    );
    expect(r.request?.timeoutMs).toBe(10000);
  });

  it("takes a bare host as curl does", () => {
    // pirate-radio's weather.
    const r = ask("curl -s wttr.in/?format=Current%20weather%20in%20%l");
    expect(r.request?.url).toBe("https://wttr.in/?format=Current%20weather%20in%20%l");
  });

  it("carries headers, and caps the wait at a minute", () => {
    const r = ask('curl -sS --max-time 600 -H "Accept: application/json" "https://api.example/q"');
    expect(r.request?.headers).toEqual({ Accept: "application/json" });
    expect(r.request?.timeoutMs).toBe(60000);
  });

  it("reads `wget -qO-` the same way", () => {
    expect(ask("wget -qO- https://api.example/t").request?.url).toBe("https://api.example/t");
    expect(ask("wget -q -O - https://api.example/t").request?.url).toBe("https://api.example/t");
  });

  it("refuses anything that is not a plain read", () => {
    // pirate-radio uploads a file; norns.online uploads a key.
    for (const cmd of [
      'curl -k -F file="@/tmp/a.ogg" https://coffer.example/upload',
      "curl -s -m 60 --upload-file /home/we/key.public https://example.org/share",
      "curl -s -X POST https://example.org/api",
      "curl -s -d a=1 https://example.org/api",
    ]) {
      const r = ask(cmd);
      expect(r.request, cmd).toBeUndefined();
      expect(r.refused, cmd).toMatch(/only a plain read/);
    }
  });

  it("still treats a destination as a download for next time", () => {
    expect(ask("curl -L https://example.org/a.bin -o /home/we/a.bin").fetch?.dest).toBe("/home/we/a.bin");
    expect(ask("curl -s https://api.example/t > /home/we/t.json").fetch?.dest).toBe("/home/we/t.json");
    expect(ask("curl -s https://api.example/t > /home/we/t.json").request).toBeUndefined();
    expect(ask("wget -q https://example.com/x.zip").request).toBeUndefined();
  });
});

describe("holding a reply until it is asked for", () => {
  let w: Wire;
  beforeEach(() => {
    w = wire();
  });

  it("is not done until the service has answered, and hands the body over once", async () => {
    const token = w.net.start("curl a", REQ);
    expect(w.net.poll(token)).toEqual({ done: false, body: "" });
    await w.answer('{"cycle":421.3}');
    expect(w.net.poll(token)).toEqual({ done: true, body: '{"cycle":421.3}' });
    // Handed over. A second poll must not hand it over again, and must not wait.
    expect(w.net.poll(token)).toEqual({ done: true, body: "" });
  });

  it("sends no cookies and does not reuse a cached answer", () => {
    w.net.start("curl a", { ...REQ, headers: { Accept: "application/json" } });
    expect(w.asked[0]!.url).toBe("https://api.example/x");
    expect(w.asked[0]!.init.credentials).toBe("omit");
    expect(w.asked[0]!.init.cache).toBe("no-store");
    expect(w.asked[0]!.init.method).toBe("GET");
    expect(w.asked[0]!.init.headers).toEqual({ Accept: "application/json" });
  });

  it("joins a request already in flight for the same command", () => {
    const a = w.net.start("curl a", REQ);
    const b = w.net.start("curl a", REQ);
    expect(b).toBe(a);
    expect(w.asked).toHaveLength(1);
    expect(w.net.start("curl b", REQ)).not.toBe(a);
    expect(w.asked).toHaveLength(2);
  });

  it("answers an empty string when the service cannot be read, and says why once", async () => {
    const token = w.net.start("curl a", REQ);
    await w.fail();
    expect(w.net.poll(token)).toEqual({ done: true, body: "" });
    expect(w.lines).toEqual([
      "curl: nothing could be read from api.example — it is unreachable, or it does not allow a page to read it",
    ]);
    // ufo asks every thirty seconds: the log is not a metronome.
    w.net.start("curl a", REQ);
    await w.fail();
    expect(w.lines).toHaveLength(1);
    w.t += SAY_AGAIN_MS + 1;
    w.net.start("curl a", REQ);
    await w.fail();
    expect(w.lines).toHaveLength(2);
  });

  it("says so when it was this application's own list that refused", async () => {
    // The desktop build allows a list of hosts. Blaming the service for
    // that would send somebody looking in the wrong place.
    const lines: string[] = [];
    const net = createNetReplies({
      fetch: () => Promise.reject(new TypeError("Failed to fetch")),
      now: () => 0,
      log: (l) => lines.push(l),
      refusedByPolicy: (host) => host === "api.example",
    });
    const token = net.start("curl a", REQ);
    await new Promise((r) => setTimeout(r, 5));
    expect(net.poll(token)).toEqual({ done: true, body: "" });
    expect(lines[0]).toContain("only lets a script reach the hosts on its own list");
  });

  it("gives up when the command's own time limit runs out", async () => {
    const token = w.net.start("curl a", { ...REQ, timeoutMs: 20 });
    await new Promise((r) => setTimeout(r, 60));
    expect(w.net.poll(token)).toEqual({ done: true, body: "" });
    expect(w.lines[0]).toContain("no reply within 0 s");
  });

  it("hands over the body whatever the status, as curl does", async () => {
    const token = w.net.start("curl a", REQ);
    await w.answer('{"error":"not found"}', 404);
    expect(w.net.poll(token).body).toBe('{"error":"not found"}');
    expect(w.lines[0]).toBe("curl: api.example answered, 21 bytes (HTTP 404)");
  });

  it("does not hand a script more than it should", async () => {
    const big = wire({ maxBytes: 10 });
    const token = big.net.start("curl a", REQ);
    await big.answer("x".repeat(11));
    expect(big.net.poll(token)).toEqual({ done: true, body: "" });
    expect(big.lines[0]).toContain("over what a script is handed here");
  });

  it("asks over https where the page itself is", () => {
    const s = wire({ secure: true });
    s.net.start("curl a", { ...REQ, url: "http://api.example/x" });
    expect(s.asked[0]!.url).toBe("https://api.example/x");
    w.net.start("curl a", { ...REQ, url: "http://api.example/x" });
    expect(w.asked[0]!.url).toBe("http://api.example/x");
  });

  it("keeps a reply nobody could wait for, for the next identical call", async () => {
    expect(w.net.take("curl a")).toBeNull();
    const token = w.net.start("curl a", REQ);
    w.net.leave(token);
    expect(w.lines[0]).toContain("outside a clock coroutine");
    expect(w.net.take("curl a"), "still in flight").toBeNull();
    await w.answer("later");
    expect(w.net.take("curl b")).toBeNull();
    expect(w.net.take("curl a")).toBe("later");
    expect(w.net.take("curl a"), "once").toBeNull();
  });

  it("does not hand a waiter's reply to somebody else, and forgets an old one", async () => {
    const waited = w.net.start("curl a", REQ);
    await w.answer("mine");
    expect(w.net.take("curl a"), "it is being waited on").toBeNull();
    expect(w.net.poll(waited).body).toBe("mine");

    const left = w.net.start("curl a", REQ);
    w.net.leave(left);
    await w.answer("stale");
    w.t += 6 * 60 * 1000;
    expect(w.net.take("curl a")).toBeNull();
  });

  it("runs a callback when the reply is in", async () => {
    const got: string[] = [];
    w.net.whenDone(w.net.start("curl a", REQ), (b) => got.push(b));
    expect(got).toEqual([]);
    await w.answer("weather");
    expect(got).toEqual(["weather"]);
    // And never leaves one waiting on a token that does not exist.
    w.net.whenDone(999, (b) => got.push(`[${b}]`));
    expect(got).toEqual(["weather", "[]"]);
  });
});

describe("a script reading a service, in norns' own Lua", () => {
  let host: Host;
  let w: Wire;

  const out = (code: string): string => {
    const before = host.output.length;
    const err = host.run(code);
    if (err) return `ERROR: ${err}`;
    return host.output.slice(before).join("").trim();
  };

  beforeEach(() => {
    const vfs = new Vfs();
    w = wire();
    host = createHost({ sources: loadNornsLua(), vfs, net: w.net });
    registerFs(host.registry, vfs, { net: w.net });
    const err = boot(host, loadConfig());
    if (err) throw new Error(`boot failed at ${err.step}: ${err.error}`);
  });

  it("puts the coroutine to sleep until the reply is in — util.os_capture", async () => {
    // ppm_norns' own shape.
    expect(
      out(`
        got, after = nil, nil
        id = clock.run(function()
          got = util.os_capture("curl -s -m 30 -k https://global-warming.org/api/co2-api")
          after = "ran on"
        end)
        print(tostring(got), coroutine.status(clock.threads[id]))`),
    ).toBe("nil\tsuspended");
    expect(w.asked.map((a) => a.url)).toEqual(["https://global-warming.org/api/co2-api"]);
    // Woken with nothing to read yet: it goes back to sleep.
    for (let i = 0; i < 3; i++) expect(out("clock.resume(id) print(tostring(got))")).toBe("nil");
    await w.answer('{"co2":[{"cycle":"421.3"}]}');
    expect(out("clock.resume(id) print(got, after)")).toBe('{"co2":[{"cycle":"421.3"}]}\tran on');
    expect(w.asked).toHaveLength(1);
  });

  it("sleeps across a pcall, which is how avonlea asks", async () => {
    out(`
      ok, res = nil, nil
      id = clock.run(function()
        ok, res = pcall(function()
          return util.os_capture("curl -s --max-time 10 'https://api.open-meteo.com/v1/forecast?current=weather_code'")
        end)
      end)`);
    expect(out("print(tostring(ok))")).toBe("nil");
    await w.answer('{"current":{"weather_code":3}}');
    expect(out("clock.resume(id) print(ok, res)")).toBe('true\t{"current":{"weather_code":3}}');
  });

  it("does the same for io.popen", async () => {
    out(`
      got = nil
      id = clock.run(function()
        local f = io.popen("curl -s https://api.wheretheiss.at/v1/satellites/25544")
        got = f:read("*a")
        f:close()
      end)`);
    await w.answer('{"latitude":12.5}');
    expect(out("clock.resume(id) print(got)")).toBe('{"latitude":12.5}');
  });

  it("gives the fallback its empty string when the service cannot be read", async () => {
    out(`
      got = nil
      id = clock.run(function() got = util.os_capture("curl -s https://api.example/x") end)`);
    await w.fail();
    expect(out('clock.resume(id) print("[" .. got .. "]")')).toBe("[]");
  });

  it("does not stop the page for a caller that cannot sleep, and has the reply next time", async () => {
    expect(out('print("[" .. util.os_capture("curl -s https://api.example/x") .. "]")')).toBe("[]");
    expect(w.lines.join("\n")).toContain("outside a clock coroutine");
    await w.answer("there now");
    expect(out('print(util.os_capture("curl -s https://api.example/x"))')).toBe("there now");
    expect(w.asked).toHaveLength(1);
  });

  it("runs system_cmd's callback with the reply — pirate-radio's weather", async () => {
    expect(
      out(`
        place = nil
        print(norns.system_cmd("curl -s wttr.in/?format=3", function(p) place = p end))`),
      "started, which is what it answers for any command it can run",
    ).toBe("true");
    expect(w.asked[0]!.url).toBe("https://wttr.in/?format=3");
    expect(out("print(tostring(place))")).toBe("nil");
    await w.answer("Paris: +12C");
    expect(out("print(place)")).toBe("Paris: +12C");
  });

  it("leaves every other command exactly as it was", () => {
    expect(out('print(util.os_capture("echo hello"))')).toBe("hello");
    expect(out('print(type(_norns.execute("ls /home/we")))')).toBe("string");
  });
});
