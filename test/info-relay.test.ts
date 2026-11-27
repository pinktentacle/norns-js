// E9-277 — the info sheet's relay (tools/info-relay.mjs): a lines topic and
// pictures from a short list, for the page this server serves, and nothing
// else.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { INFO_HEADER, infoTarget, relayInfo } from "../tools/info-relay.mjs";

const answer = (body: string | Uint8Array<ArrayBuffer>, type: string, url: string, status = 200): Response => {
  const r = new Response(body, { status, headers: { "Content-Type": type } });
  Object.defineProperty(r, "url", { value: url });
  return r;
};

describe("what the relay takes", () => {
  it("a lines topic by number, a page at a time", () => {
    expect(infoTarget("/info-relay/lines/53301/1.json")).toEqual({ kind: "lines", url: "https://llllllll.co/t/53301.json" });
    expect(infoTarget("/info-relay/lines/53301/3.json")).toEqual({ kind: "lines", url: "https://llllllll.co/t/53301.json?page=3" });
    expect(infoTarget("/info-relay/lines/53301/0.json")).toBeNull();
    expect(infoTarget("/info-relay/lines/abc/1.json")).toBeNull();
    expect(infoTarget("/info-relay/lines/53301/1.json/x")).toBeNull();
    expect(infoTarget("/info-relay/ping")).toEqual({ kind: "ping" });
  });

  it("a topic by its name, and a search of titles for the short links that lead nowhere", () => {
    expect(infoTarget("/info-relay/lines/s/bitters-norns/1.json")).toEqual({
      kind: "lines",
      url: "https://llllllll.co/t/bitters-norns.json",
    });
    expect(infoTarget("/info-relay/lines/q/cheat-codes-2.json")).toEqual({
      kind: "lines",
      url: "https://llllllll.co/search.json?q=cheat%20codes%202%20in%3Atitle",
    });
    expect(infoTarget("/info-relay/lines/s/Bad_Name/1.json")).toBeNull();
    expect(infoTarget("/info-relay/lines/q/a%20b.json")).toBeNull();
    expect(infoTarget("/info-relay/lines/q/x.json?q=other")).toBeNull();
  });

  it("pictures from the hosts on its list, by the paths they keep them under", () => {
    expect(infoTarget("/info-relay/img/user-images.githubusercontent.com/6550035/156637615-a.png")?.kind).toBe("img");
    expect(infoTarget("/info-relay/img/raw.githubusercontent.com/schollz/x/HEAD/docs/a.png")?.kind).toBe("img");
    expect(infoTarget("/info-relay/img/llllllll.co/uploads/default/original/3X/a/0/a0.png")?.kind).toBe("img");
    expect(infoTarget("/info-relay/img/llllllll.co/user_avatar/llllllll.co/x/90/1_2.png")?.kind).toBe("img");
    // A repository's blob page is the page; the file is ?raw=true.
    expect(infoTarget("/info-relay/img/github.com/schollz/x/blob/main/a.png")).toEqual({
      kind: "img",
      url: "https://github.com/schollz/x/blob/main/a.png?raw=true",
    });
  });

  it("and nothing else: other hosts, other paths, a way out of the path", () => {
    expect(infoTarget("/info-relay/img/example.com/a.png")).toBeNull();
    expect(infoTarget("/info-relay/img/llllllll.co/t/53301.json")).toBeNull();
    expect(infoTarget("/info-relay/img/llllllll.co/session/csrf")).toBeNull();
    expect(infoTarget("/info-relay/img/github.com/login")).toBeNull();
    expect(infoTarget("/info-relay/img/raw.githubusercontent.com/a/../../b.png")).toBeNull();
    expect(infoTarget("/info-relay/img/raw.githubusercontent.com/a/%2e%2e/b.png")).toBeNull();
    expect(infoTarget("/gh-release/x")).toBeNull();
  });
});

describe("how it answers", () => {
  it("passes a topic on as JSON, marked as the relay's, asking with no cookie", async () => {
    let asked: { url: string; init: RequestInit } | null = null;
    const r = await relayInfo("/info-relay/lines/53301/1.json", {
      fetch: async (url, init) => {
        asked = { url, init };
        return answer('{"title":"makebreakbeat"}', "application/json; charset=utf-8", "https://llllllll.co/t/53301.json");
      },
      site: "same-origin",
    });
    expect(r.status).toBe(200);
    expect(r.headers.get(INFO_HEADER)).toBe("1");
    expect(r.headers.get("Content-Type")).toMatch(/^application\/json/);
    expect(await r.text()).toBe('{"title":"makebreakbeat"}');
    expect(asked!.url).toBe("https://llllllll.co/t/53301.json");
    expect(JSON.stringify(asked!.init)).not.toMatch(/cookie/i);
  });

  it("refuses another site, a method that writes, and a path it does not take", async () => {
    const fetch = async (): Promise<Response> => answer("{}", "application/json", "https://llllllll.co/t/1.json");
    expect((await relayInfo("/info-relay/lines/1/1.json", { fetch, site: "cross-site" })).status).toBe(403);
    expect((await relayInfo("/info-relay/lines/1/1.json", { fetch, method: "POST" })).status).toBe(405);
    expect((await relayInfo("/info-relay/img/example.com/a.png", { fetch })).status).toBe(404);
    expect((await relayInfo("/info-relay/ping", { fetch, site: "same-origin" })).status).toBe(200);
  });

  it("refuses an answer of the wrong kind, or from somewhere else", async () => {
    const html = await relayInfo("/info-relay/img/user-images.githubusercontent.com/1/a.png", {
      fetch: async () => answer("<html>", "text/html", "https://user-images.githubusercontent.com/1/a.png"),
    });
    expect(html.status).toBe(502);
    const away = await relayInfo("/info-relay/img/github.com/u/r/raw/main/a.png", {
      fetch: async () => answer(new Uint8Array([1, 2]), "image/png", "https://evil.example/a.png"),
    });
    expect(away.status).toBe(502);
    const ok = await relayInfo("/info-relay/img/github.com/u/r/raw/main/a.png", {
      fetch: async () => answer(new Uint8Array([1, 2, 3]), "image/png", "https://raw.githubusercontent.com/u/r/main/a.png"),
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("Content-Security-Policy")).toMatch(/sandbox/);
    expect(new Uint8Array(await ok.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });
});

describe("every server this page is served from relays it", () => {
  const read = (p: string): string => readFileSync(join(__dirname, "..", p), "utf8");
  it("Cloudflare, the portable server, the desktop shell and the dev server all call the one module", () => {
    expect(read("functions/info-relay/[[path]].js")).toMatch(/import \{ relayInfo \} from "\.\.\/\.\.\/tools\/info-relay\.mjs"/);
    expect(read("tools/serve.mjs")).toMatch(/url\.pathname\.startsWith\(INFO_PREFIX\)[\s\S]{0,80}relayInfo\(/);
    expect(read("desktop/main.js")).toMatch(/url\.pathname\.startsWith\(INFO_PREFIX\)[\s\S]{0,40}return relayInfo\(url\.pathname, \{\s*fetch: \(u, init\) => net\.fetch\(u, init\)/);
    expect(read("vite.config.ts")).toMatch(/path\.startsWith\(INFO_PREFIX\) \? relayInfo/);
  });

  it("the module travels with the servers that import it", () => {
    expect(read("electron-builder.yml")).toMatch(/^ {2}- tools\/info-relay\.mjs$/m);
    expect(read("tools/build-portable.mjs")).toMatch(/cp\(join\(ROOT, "tools\/info-relay\.mjs"\), join\(OUT, "info-relay\.mjs"\)\)/);
  });
});
