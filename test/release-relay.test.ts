// E9-227 — GitHub release files, relayed by the page's own server.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RELAY_HEADER, RELAY_PREFIX, relayRelease, releaseTarget } from "../tools/gh-release.mjs";
import * as page from "../src/fs/release-relay.js";

const MOON = "https://github.com/schollz/moonraker/releases/download/samplepack1/moonraker.zip";
const MOON_PATH = "/gh-release/schollz/moonraker/releases/download/samplepack1/moonraker.zip";
const ASSET = "https://release-assets.githubusercontent.com/github-production-release-asset/1/2?sig=x";

/** A stand-in for GitHub: records what it was asked and answers like a followed redirect. */
const github = (answer: { status?: number; body?: string; url?: string; headers?: Record<string, string> } = {}) => {
  const asked: Array<{ url: string; init: RequestInit }> = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    asked.push({ url, init });
    const res = new Response(answer.body ?? "PK-bytes", {
      status: answer.status ?? 200,
      headers: { "Content-Type": "application/octet-stream", "Content-Length": "8", ...answer.headers },
    });
    Object.defineProperty(res, "url", { value: answer.url ?? ASSET });
    return res;
  };
  return { asked, fetch };
};

describe("which paths the server relays", () => {
  it("both shapes of a release download, and nothing else", () => {
    expect(releaseTarget(MOON_PATH)).toBe(MOON);
    expect(releaseTarget("/gh-release/o/r/releases/latest/download/x.zip")).toBe("https://github.com/o/r/releases/latest/download/x.zip");
    expect(releaseTarget("/gh-release/o/r/releases/download/v1.0%2Bb/a%20b.zip")).toBe(
      "https://github.com/o/r/releases/download/v1.0%2Bb/a%20b.zip",
    );
    for (const bad of [
      "/gh-release/o/r/archive/refs/heads/main.zip",
      "/gh-release/o/r/releases/download/v1/x.zip/more",
      "/gh-release/o/r/releases/download/x.zip",
      "/gh-release/../r/releases/download/v1/x.zip",
      "/gh-release/o/r/releases/download/../x.zip",
      "/gh-release/o/r/releases/download/v1/%2E%2E",
      "/gh-release/o/r/releases/download/v1/a%2Fb",
      "/gh-release/o/r/releases/download/v1/a%5Cb",
      "/gh-release/o/r/releases/download/v1/%E0%A4%A",
      "/gh-release/o:x/r/releases/download/v1/x.zip",
      "/gh-release/o/r/releases/latest/x.zip/download",
      "/other/o/r/releases/download/v1/x.zip",
    ]) {
      expect(releaseTarget(bad), bad).toBeNull();
    }
  });

  it("the page and the server agree on every URL the page sends", () => {
    for (const url of [
      MOON,
      "https://github.com/schollz/mx.samples/releases/download/samples/ghost_piano.zip",
      "https://github.com/o/r/releases/latest/download/x.zip",
      "https://github.com/o/r/releases/download/v1.0%2Bb/a%20b.zip",
    ]) {
      const path = page.relayPath(url);
      expect(path, url).not.toBeNull();
      expect(path!.startsWith(RELAY_PREFIX)).toBe(true);
      expect(releaseTarget(path!), url).toBe(url);
    }
    expect(page.RELAY_PREFIX).toBe(RELAY_PREFIX);
    expect(page.RELAY_HEADER).toBe(RELAY_HEADER);
  });

  it("the page sends nothing else there", () => {
    for (const url of [
      "https://github.com/o/r",
      "https://github.com/o/r/archive/main.zip",
      "https://raw.githubusercontent.com/o/r/main/x.wav",
      "https://example.org/o/r/releases/download/v1/x.zip",
      "https://github.com/o/r/releases/download/v1/x.zip?token=1",
    ]) {
      expect(page.relayPath(url), url).toBeNull();
    }
  });
});

describe("what the server answers", () => {
  it("fetches the one GitHub URL, with nothing of the asker's, and streams it back marked", async () => {
    const gh = github();
    const r = await relayRelease(MOON_PATH, { fetch: gh.fetch, method: "GET", site: "same-origin" });
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("PK-bytes");
    expect(r.headers.get(RELAY_HEADER)).toBe("1");
    expect(r.headers.get("Content-Length")).toBe("8");
    expect(r.headers.get("Cache-Control")).toBe("no-store");
    expect(gh.asked).toHaveLength(1);
    expect(gh.asked[0]!.url).toBe(MOON);
    expect(gh.asked[0]!.init.redirect).toBe("follow");
    expect(Object.keys(gh.asked[0]!.init.headers as object).sort()).toEqual(["Accept", "User-Agent"]);
  });

  it("serves a request with no Sec-Fetch-Site (curl), refuses one from another site or the address bar", async () => {
    expect((await relayRelease(MOON_PATH, { fetch: github().fetch, site: null })).status).toBe(200);
    for (const site of ["cross-site", "same-site", "none"]) {
      const gh = github();
      const r = await relayRelease(MOON_PATH, { fetch: gh.fetch, site });
      expect(r.status, site).toBe(403);
      expect(gh.asked, "GitHub is not even asked").toHaveLength(0);
    }
  });

  it("refuses what is not a GET or a release download, without asking GitHub", async () => {
    const gh = github();
    expect((await relayRelease(MOON_PATH, { fetch: gh.fetch, method: "POST" })).status).toBe(405);
    expect((await relayRelease("/gh-release/o/r/archive/main.zip", { fetch: gh.fetch })).status).toBe(404);
    expect(gh.asked).toHaveLength(0);
    const head = await relayRelease(MOON_PATH, { fetch: gh.fetch, method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.body).toBeNull();
  });

  it("says what GitHub said when it is not the file, and refuses an answer from anywhere else", async () => {
    const missing = await relayRelease(MOON_PATH, { fetch: github({ status: 404, url: MOON }).fetch });
    expect(missing.status).toBe(404);
    expect(missing.headers.get(RELAY_HEADER)).toBe("1");
    expect((await relayRelease(MOON_PATH, { fetch: github({ status: 500 }).fetch })).status).toBe(502);
    const elsewhere = await relayRelease(MOON_PATH, { fetch: github({ url: "https://evil.example/x" }).fetch });
    expect(elsewhere.status).toBe(502);
    expect(await elsewhere.text()).toMatch(/evil\.example/);
    const down = await relayRelease(MOON_PATH, {
      fetch: () => Promise.reject(new TypeError("getaddrinfo ENOTFOUND")),
    });
    expect(down.status).toBe(502);
    expect(await down.text()).toMatch(/ENOTFOUND/);
  });

  it("passes no length for a body that was decoded on the way", async () => {
    const r = await relayRelease(MOON_PATH, { fetch: github({ headers: { "Content-Encoding": "gzip" } }).fetch });
    expect(r.headers.get("Content-Length")).toBeNull();
  });
});

describe("the page's fetch", () => {
  const answers = (table: Record<string, () => Response | Promise<Response>>) => {
    const asked: string[] = [];
    const fetch = async (url: string): Promise<Response> => {
      asked.push(url);
      const a = table[url];
      if (a === undefined) throw new TypeError("Failed to fetch");
      return a();
    };
    return { asked, fetch };
  };
  const relayed = (body: string, status = 200) =>
    new Response(body, { status, headers: { [RELAY_HEADER]: "1", "Content-Length": String(body.length) } });

  it("goes through the relay when the server has one", async () => {
    const f = answers({ [MOON_PATH]: () => relayed("zip!") });
    const got = await page.fetchFile(MOON, { fetch: f.fetch });
    expect(got).toMatchObject({ ok: true, relayed: true });
    expect(new TextDecoder().decode(got.bytes)).toBe("zip!");
    expect(f.asked).toEqual([MOON_PATH]);
  });

  it("takes a server's index.html for what it is — no relay — and fetches the URL as before", async () => {
    const f = answers({
      [MOON_PATH]: () => new Response("<!doctype html>", { status: 200, headers: { "Content-Type": "text/html" } }),
    });
    await expect(page.fetchFile(MOON, { fetch: f.fetch })).rejects.toThrow(/Failed to fetch/);
    expect(f.asked).toEqual([MOON_PATH, MOON]);
  });

  it("says the relay's refusal rather than trying the URL the browser will refuse anyway", async () => {
    const f = answers({ [MOON_PATH]: () => relayed("github answered 404", 404) });
    expect(await page.fetchFile(MOON, { fetch: f.fetch })).toMatchObject({ ok: false, status: 404, relayed: true });
    expect(f.asked).toEqual([MOON_PATH]);
  });

  it("fetches anything that is not a release as it always did", async () => {
    const url = "https://cors.example/a.wav";
    const f = answers({ [url]: () => new Response("riff") });
    expect(await page.fetchFile(url, { fetch: f.fetch })).toMatchObject({ ok: true, relayed: false });
    expect(f.asked).toEqual([url]);
  });

  it("reports progress by the quarter, and only for files worth waiting for", async () => {
    const said: string[] = [];
    const q = page.quarters((l) => said.push(l), "moonraker.zip");
    const total = 100 * 1048576;
    for (let got = 0; got <= total; got += 5 * 1048576) q(got, total);
    expect(said).toEqual([
      "fetch: moonraker.zip — 25 of 100 MB",
      "fetch: moonraker.zip — 50 of 100 MB",
      "fetch: moonraker.zip — 75 of 100 MB",
    ]);
    const small: string[] = [];
    const s = page.quarters((l) => small.push(l), "a.wav");
    s(1, 2);
    s(2, 2);
    s(1, null);
    expect(small).toEqual([]);
  });
});

describe("every server this page is served from relays", () => {
  const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

  it("Cloudflare, the portable server, the desktop shell and the dev server all call the one module", () => {
    expect(read("functions/gh-release/[[path]].js")).toMatch(/import \{ relayRelease \} from "\.\.\/\.\.\/tools\/gh-release\.mjs"/);
    expect(read("tools/serve.mjs")).toMatch(/url\.pathname\.startsWith\(RELAY_PREFIX\)[\s\S]{0,80}relayRelease\(/);
    expect(read("desktop/main.js")).toMatch(/url\.pathname\.startsWith\(RELAY_PREFIX\)[\s\S]{0,40}return relayRelease\(url\.pathname, \{\s*fetch: \(u, init\) => net\.fetch\(u, init\)/);
    expect(read("vite.config.ts")).toMatch(/plugins: \[requireSourceUrl\(\), releaseRelay\(\)\]/);
  });

  it("the module travels with the servers that import it", () => {
    expect(read("electron-builder.yml")).toMatch(/^ {2}- tools\/gh-release\.mjs$/m);
    expect(read("tools/build-portable.mjs")).toMatch(/cp\(join\(ROOT, "tools\/gh-release\.mjs"\), join\(OUT, "gh-release\.mjs"\)\)/);
  });
});
