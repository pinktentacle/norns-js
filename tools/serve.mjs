// A static server for a built norns-js, with the two headers it cannot run
// without. Zero dependencies; Node 18 or newer.
//
//   node serve.mjs [dir] [port]      # defaults: ./app 8080
//
// WHY A SERVER AT ALL, since it is "just a web page". Three independent
// reasons, and the first one is fatal on its own:
//
//   1. scsynth is compiled with pthreads and needs `SharedArrayBuffer`,
//      which a page only gets when it is CROSS-ORIGIN ISOLATED. That state
//      is granted by two response headers:
//
//          Cross-Origin-Opener-Policy: same-origin
//          Cross-Origin-Embedder-Policy: require-corp
//
//      A `file://` URL has no response headers at all, so there is nothing
//      that could grant it. No isolation, no SharedArrayBuffer, no audio.
//
//   2. The page is an ES module. Module scripts are fetched under CORS
//      rules, and a `file://` origin is opaque, so the browser refuses to
//      load them before any of the above matters.
//
//   3. The dust tree and the wasm are fetched. `fetch` on `file://` is
//      blocked for the same reason.
//
// So: any static server will do, as long as it sends those two headers.
// This one does, plus one thing it turned out to need: a DIRECTORY LISTING.
// norns-js is AGPL, so the running page offers its own source at `./source/`
// — and a folder with no index.html is a 404 on a server that maps paths to
// files and nothing more. The offer was measured, and it was broken. A
// listing is what makes it real.

// IT IS ALSO A MODULE, because the desktop shell needs the same server
// (D-01): a native window cannot load the page from `file://` either, for
// all three reasons above. `serve({ root, port, host })` is the same handler
// with nothing printed and nothing assumed about `process.argv`, and the CLI
// below is one call to it — so the thing the shell runs is the thing that
// was measured, rather than a second copy of it that drifts.
import { createServer } from "node:http";
import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { Readable } from "node:stream";
import { RELAY_PREFIX, relayRelease } from "./gh-release.mjs";

/**
 * Content types, because the browser refuses a module served as text/plain
 * and silently mis-decodes a wasm served as anything but its own type.
 */
const TYPES = new Map(
  Object.entries({
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".wasm": "application/wasm",
    ".data": "application/octet-stream",
    ".bin": "application/octet-stream",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".ico": "image/x-icon",
    ".ttf": "font/ttf",
    ".woff2": "font/woff2",
    ".wav": "audio/wav",
    ".aif": "audio/aiff",
    ".aiff": "audio/aiff",
    ".flac": "audio/flac",
    ".ogg": "audio/ogg",
    ".mp3": "audio/mpeg",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".lua": "text/plain; charset=utf-8",
    ".sc": "text/plain; charset=utf-8",
  }),
);

/** A folder, as a page. Enough to walk a source tree, and no more. */
async function listing(dir, urlPath) {
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort(
    (a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name),
  );
  const esc = (t) =>
    t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const rows = entries
    .map((e) => {
      const slash = e.isDirectory() ? "/" : "";
      return `<li><a href="${encodeURIComponent(e.name)}${slash}">${esc(e.name + slash)}</a></li>`;
    })
    .join("");
  const up = urlPath === "/" ? "" : '<li><a href="../">../</a></li>';
  return `<!doctype html><meta charset="utf-8"><title>${esc(urlPath)}</title>
<style>body{font:14px ui-monospace,monospace;background:#101014;color:#d8d8dc;padding:2rem}
a{color:#9ab;text-decoration:none}a:hover{text-decoration:underline}
ul{list-style:none;padding:0;line-height:1.7}h1{font-size:14px;font-weight:400;color:#777}</style>
<h1>${esc(urlPath)}</h1><ul>${up}${rows}</ul>`;
}

/**
 * Serve `root`, with the headers the page cannot run without.
 *
 * `port: 0` lets the OS pick a free one, which is what a desktop shell
 * wants: a fixed port is a port something else is already using.
 * Resolves once it is listening, with the server and the port it got.
 */
export function serve({ root = "app", port = 8080, host } = {}) {
  const ROOT = resolve(root);
  const server = createServer(handler(ROOT));
  return new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(port, host, () => ok({ server, port: server.address().port, root: ROOT }));
  });
}

/**
 * What this server would answer for one path, as plain data.
 *
 * TRANSPORT-AGNOSTIC ON PURPOSE. The desktop shell does not use a socket at
 * all — a loopback port has to be random, a random port is a different
 * ORIGIN every launch, and the dust tree lives in that origin's OPFS, so an
 * application on a random port forgets everything it was given (D-06). It
 * serves a custom scheme instead, and a custom scheme needs exactly this:
 * what to send for a path, with what headers. The HTTP server below is one
 * caller and `protocol.handle` in `desktop/main.js` is the other, so there
 * is one answer rather than two that drift.
 *
 * Returns `{ status, headers, body }`, where `body` is a Buffer, a string,
 * or null for a redirect (`headers.Location` then says where).
 */
export async function respond(root, pathname) {
  const ROOT = resolve(root);
  const path = decodeURIComponent(pathname);

  const headers = {
    // The two that make SharedArrayBuffer available. Without them the page
    // loads, draws, and has no audio engine at all.
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    // Same-origin by default under COEP, but said explicitly so a copy of
    // this file behind a proxy keeps working.
    "Cross-Origin-Resource-Policy": "same-origin",
    "Cache-Control": "no-cache",
  };

  // Nothing above the root is servable, however the path is spelled.
  const target = join(ROOT, normalize(path).replace(/^(\.\.(\/|\\|$))+/, ""));
  if (target !== ROOT && !target.startsWith(ROOT + sep)) {
    return { status: 403, headers: { ...headers, "Content-Type": TEXT }, body: "forbidden" };
  }

  try {
    let file = target;
    const info = await stat(target);
    if (info.isDirectory()) {
      if (!path.endsWith("/")) {
        return { status: 301, headers: { ...headers, Location: path + "/" }, body: null };
      }
      // THE ROOT IS THE APP; EVERY FOLDER BELOW IT LISTS. The source tree
      // carries the project's own index.html at its top, and serving that
      // as the page for `/source/` would answer the source offer with a
      // broken copy of the app. One rule, stated rather than guessed at.
      if (path !== "/") {
        return {
          status: 200,
          headers: { ...headers, "Content-Type": "text/html; charset=utf-8" },
          body: await listing(target, path),
        };
      }
      file = join(target, "index.html");
    }
    const body = await readFile(file);
    return {
      status: 200,
      headers: {
        ...headers,
        "Content-Type": TYPES.get(extname(file).toLowerCase()) ?? "application/octet-stream",
        "Content-Length": String(body.length),
      },
      body,
    };
  } catch {
    return { status: 404, headers: { ...headers, "Content-Type": TEXT }, body: `not found: ${path}` };
  }
}

const TEXT = "text/plain; charset=utf-8";

const handler = (ROOT) => async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  // E9-227 — a GitHub release file the page cannot fetch itself, fetched
  // here and streamed through. See gh-release.mjs.
  if (url.pathname.startsWith(RELAY_PREFIX)) {
    const r = await relayRelease(url.pathname, {
      fetch: (u, init) => fetch(u, init),
      method: req.method ?? "GET",
      site: req.headers["sec-fetch-site"] ?? null,
    });
    res.writeHead(r.status, Object.fromEntries(r.headers));
    if (r.body === null) res.end();
    else Readable.fromWeb(r.body).on("error", () => res.destroy()).pipe(res);
    return;
  }
  const { status, headers, body } = await respond(ROOT, url.pathname);
  res.writeHead(status, headers);
  res.end(body ?? undefined);
};

// Run directly: the command line this file has always had.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { root, port } = await serve({
    root: process.argv[2] ?? "app",
    port: Number(process.argv[3] ?? 8080),
  });
  process.stdout.write(`norns-js: serving ${root}\n  http://localhost:${port}/\n`);
  process.stdout.write("  cross-origin isolation headers are on; audio needs them.\n");
}
