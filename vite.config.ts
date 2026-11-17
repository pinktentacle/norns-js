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
};

import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

// Fengari is a Node-shaped CommonJS package and reaches four builtins, each
// from one or two lines. These aliases hand it browser versions that fail
// loudly rather than plausibly. See src/lua/shims/README.md for why this
// rather than the authors' `fengari-web` bundle.
const shim = (name: string) =>
  fileURLToPath(new URL(`./src/lua/shims/${name}.ts`, import.meta.url));

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
  resolve: {
    alias: {
      /**
       * E9-64 — the Lua runtime is the VENDORED fengari, not the published
       * one.
       *
       * norns' integers are 64-bit and fengari's were 32-bit, which is not
       * a detail: `1000000 * 1000000` came back as -727379968 and nothing
       * said so, and `fibonacci` built an eighteen-digit number in a loop
       * that could therefore never end. `third_party/fengari` is the npm
       * package with `patches/fengari.patch` applied — BigInt integers
       * inside the VM, JS numbers across the C API. See
       * `spike/lua64/README.md` for what it costs and what it fixes.
       *
       * It is a DIRECTORY with the package's own package.json, not the
       * `src/` inside it, so the module id resolves exactly as the npm one
       * did and `optimizeDeps` still sees a CommonJS package to convert.
       */
      fengari: fileURLToPath(new URL("./third_party/fengari", import.meta.url)),
      os: shim("os"),
      path: shim("path"),
      fs: shim("fs"),
      buffer: shim("buffer"),
      // Two Node-only packages fengari pulls in for features norns never
      // uses: `tmp` for os.tmpname and `readline-sync` for debug.debug().
      // Replacing them here keeps the legacy `constants` module, which `tmp`
      // reads, out of the browser bundle entirely.
      tmp: shim("tmp"),
      "readline-sync": shim("readline-sync"),
      constants: shim("constants"),
    },
  },
  define: {
    // Fengari refers to the Node global object by name. `globalThis` is the
    // standard spelling and exists in both environments, so this is a rename
    // rather than a polyfill.
    global: "globalThis",
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
  build: { target: "es2022" },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
