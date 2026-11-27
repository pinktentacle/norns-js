import { defineConfig } from "vitest/config";

// Cross-origin isolation is not optional and never will be: scsynth is built
// with pthreads and needs SharedArrayBuffer, which needs the document to be
// cross-origin isolated (E0-13, E0-19). Setting the headers here means the dev
// server behaves like the deployment target rather than like a friendlier
// environment that hides the constraint until the first deploy.
//
// E0-37 proved a service worker can supply these headers where a host cannot
// set them, with one condition: `sw.js` must sit at the ROOT of the deployed
// site, because a dedicated worker is scope-matched on its own script URL and
// sclang's pthreads load from a different directory. That is E7-05.
const COI_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  // E9-149 — so `?profile` works on localhost too. It permits the
  // browser's sampling profiler to be reached from script and starts
  // nothing; `public/_headers` carries the same line to Cloudflare.
  "Document-Policy": "js-profiling",
};

import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { RELAY_PREFIX, relayRelease } from "./tools/gh-release.mjs";
import { INFO_PREFIX, relayInfo } from "./tools/info-relay.mjs";

/**
 * E9-227 — the GitHub release relay on the dev and preview servers, so
 * `localhost` behaves like the deployment: the same module answers here as
 * on Cloudflare and in the desktop shell. See tools/gh-release.mjs.
 */
const releaseRelay = () => {
  const handle = (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    // E9-277 — and the info sheet's relay (tools/info-relay.mjs), the same way.
    const relay = path.startsWith(RELAY_PREFIX) ? relayRelease : path.startsWith(INFO_PREFIX) ? relayInfo : null;
    if (relay === null) return next();
    void (async () => {
      const r: Response = await relay(path, {
        fetch: (u: string, init: RequestInit) => fetch(u, init),
        method: req.method ?? "GET",
        site: req.headers["sec-fetch-site"] ?? null,
      });
      res.writeHead(r.status, Object.fromEntries(r.headers));
      if (r.body === null) res.end();
      else Readable.fromWeb(r.body as never).on("error", () => res.destroy()).pipe(res);
    })();
  };
  return {
    name: "norns-js:gh-release-relay",
    // Block bodies, not arrows that return: a function returned from these
    // hooks is taken by Vite as a middleware to add AFTER its own.
    configureServer(server: { middlewares: { use: (f: typeof handle) => unknown } }): void {
      server.middlewares.use(handle);
    },
    configurePreviewServer(server: { middlewares: { use: (f: typeof handle) => unknown } }): void {
      server.middlewares.use(handle);
    },
  };
};

/**
 * The browser sweep's results, kept on disk (tools/sweep/runner.js). The
 * page's storage can be wiped — in the app pane it lives in memory — so
 * the runner posts what it has after every batch and this writes it to
 * docs/measurements/browser-sweep.json. Dev server only: `vite preview`
 * and the deployment never have it.
 */
const sweepExport = () => {
  const handle = (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path !== "/__sweep/export" || req.method !== "POST") return next();
    // Only from this page: a cross-site form must not be able to write here.
    if ((req.headers["sec-fetch-site"] ?? "same-origin") !== "same-origin") {
      res.writeHead(403).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString("utf8");
        JSON.parse(body);
        writeFileSync(new URL("docs/measurements/browser-sweep.json", import.meta.url), body);
        res.writeHead(204).end();
      } catch (e) {
        res.writeHead(400).end(String(e));
      }
    });
  };
  return {
    name: "norns-js:sweep-export",
    configureServer(server: { middlewares: { use: (f: typeof handle) => unknown } }): void {
      server.middlewares.use(handle);
    },
  };
};

/**
 * E7-08 — a production build without a source URL is refused.
 *
 * norns-js is AGPL-3.0-or-later, and §13 is the clause that bites: software
 * interacted with over a network must OFFER its Corresponding Source to the
 * people using it. A page is always interacted with over a network. The app
 * shows the link in the gear, but it can only show what the build gave it —
 * so a build that was not given one is stopped here rather than deployed
 * and noticed later.
 *
 *   VITE_SOURCE_URL=https://…  npm run build
 *
 * The dev server does not require it: there is nobody to offer source to,
 * and the panel says it is unset, which is both true and the reminder.
 */
/** A stamp the running page can print: when it was built, and from what. */
function buildId(): string {
  const when = new Date().toISOString().slice(0, 16).replace("T", " ");
  let commit = "no git";
  try {
    commit = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
    const dirty = execSync("git status --porcelain", { encoding: "utf8" }).trim() !== "";
    if (dirty) commit += "+";
  } catch {
    // A copy unpacked from the archive is not a git checkout. Saying so is
    // better than failing the build over a missing stamp.
  }
  return `${when} UTC · ${commit}`;
}

const requireSourceUrl = (): { name: string; config: (c: unknown, env: { command: string }) => void } => ({
  name: "norns-js:agpl-source-url",
  config(_c, env) {
    if (env.command !== "build") return;
    const url = process.env["VITE_SOURCE_URL"]?.trim();
    if (!url) {
      throw new Error(
        [
          "VITE_SOURCE_URL is not set.",
          "",
          "norns-js is AGPL-3.0-or-later: anyone using a deployed copy must be",
          "offered its source. Set VITE_SOURCE_URL to the URL of this",
          "repository and build again.",
        ].join("\n"),
      );
    }
  },
});

export default defineConfig({
  plugins: [requireSourceUrl(), releaseRelay(), sweepExport()],
  // E9-118 — THERE IS NO `resolve.alias` ANY MORE, and that is the size of
  // what fengari cost. It was a Node-shaped CommonJS package: one alias
  // pointed `fengari` at the vendored copy carrying `patches/fengari.patch`,
  // and seven more pointed `os`, `path`, `fs`, `buffer`, `tmp`,
  // `readline-sync` and `constants` at hand-written shims under
  // `src/lua/shims/`, which threw rather than returning something plausible.
  // Lua 5.3 is a wasm module and reaches none of them: emscripten's glue
  // names `fs` and `path` only inside its `ENVIRONMENT_IS_NODE` branch, and
  // Vite externalises those on its own — MEASURED, by building with the
  // aliases deleted before deleting them.
  define: {
    // WHICH BUILD AM I LOOKING AT. Not a vanity string: a copy of this runs
    // on another machine, and "the button is not there" and "there is no
    // sound" are both what an OLD build looks like. Without a stamp the only
    // way to tell was to read a hashed filename out of the network tab. The
    // first line of the log now says it.
    __BUILD_ID__: JSON.stringify(buildId()),
  },
  optimizeDeps: {
    /**
     * E9-64 — scan THIS page, and not twelve upstream checkouts.
     *
     * Vite's dependency scanner crawls the HTML it can find under the root,
     * and `third_party/` is full of it: emsdk alone ships test pages that
     * import `loader.mjs`, which does not resolve. The scan then fails as a
     * whole and prints "Skipping dependency pre-bundling" — and without
     * pre-bundling, fengari is served as raw CommonJS and the page dies on
     * "does not provide an export named default".
     */
    entries: ["index.html"],
    // Fengari MUST be pre-bundled, not excluded. It is CommonJS, and Vite only
    // converts CJS to ESM during pre-bundling — excluding it serves the raw
    // source and the import fails with "does not provide an export named
    // default". The aliases above are applied by the optimizer, which is how
    // the browser shims reach it.
    include: ["fengari"],
  },
  server: {
    headers: COI_HEADERS,
    /**
     * E9-58 — the dev server does not watch the upstream checkouts.
     *
     * `third_party/` is twelve trees and the wasm build directory. Only
     * `third_party/norns/lua` is imported (by `import.meta.glob`), and
     * that one is read at startup. Everything else is build input: a
     * `cmake --build` writes thousands of files into `build-wasm`, and
     * cloning Eigen added 23 MB of headers, benchmarks and .html.
     *
     * Each write was a full page reload. Measured: after the Eigen clone
     * the page reloaded so often that sclang never finished starting —
     * "Spinning up sclang" thirty-seven times with no engine at the end,
     * which reads exactly like a build that broke the audio stack.
     */
    watch: {
      ignored: [
        "**/third_party/**/build-wasm/**",
        "**/third_party/eigen/**",
        "**/third_party/DaisySP/**",
        "**/third_party/supercollider/**",
        "**/third_party/sc3-plugins/**",
        "**/third_party/portedplugins/**",
        "**/third_party/mi-UGens/**",
      ],
    },
  },
  preview: { headers: COI_HEADERS },
  // E0-38a measured the class library at 2 MB; chunking so a browser can cache
  // it across deploys of the app code belongs with E4-02, when it is actually
  // loaded. Nothing is gained by guessing the split before then.
  build: {
    target: "es2022",
    /**
     * E9-153 — KEEP THE FUNCTION NAMES, so a profile can be read.
     *
     * `?profile` works and names what it finds; what it found on a Pixel
     * was `xa` at 25% and `key` at 22%, which are minified names and
     * answer nothing. Mapping them back needs the exact bundle the phone
     * ran, and the build id is baked into it — so the hash differs, the
     * line numbers shift, and the map is for a file nobody has.
     *
     * `keepNames` makes that whole problem not exist: the profile comes
     * back with the names the source uses, from any build, on anybody's
     * machine. It costs bytes in the bundle and nothing at runtime, and a
     * page whose own instruments cannot be read is a page that gets
     * guessed about.
     */
    minify: "oxc",
    rollupOptions: { output: { minify: { compress: true, mangle: { keepNames: true } } } },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // E9-117 — PUC Lua is wasm and has to be instantiated before any state
    // is made. See the file; it is one await for the whole suite.
    setupFiles: ["test/support/lua-up.ts"],
  },
});
