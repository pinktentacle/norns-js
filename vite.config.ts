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
  plugins: [requireSourceUrl()],
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
