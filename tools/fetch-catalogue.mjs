// Cache the whole norns community catalogue to disk, once.
//
// Listings come from data.jsdelivr.com (flat), files from cdn.jsdelivr.net —
// the same two endpoints the installer uses, so nothing new is being trusted.
// Everything lands under ./files/<owner>/<repo>/<path>, so a later scan is a
// plain grep over a directory instead of 2500 network calls.

import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

const HERE = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
// E9-203 — a repository the catalogue still points at and GitHub no longer
// forwards. The installer reads the same file; the cache keeps the
// catalogue's key, so everything downstream goes on finding it by name.
const MOVED = JSON.parse(
  await readFile(new URL("../src/community/moved.json", import.meta.url), "utf8"),
).moved;
const whereNow = (key) => MOVED[key]?.to ?? key;
const CATALOG = "https://raw.githubusercontent.com/monome/norns-community/main/community.json";

async function getJson(url) {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

async function pool(items, n, worker) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      for (;;) {
        const k = i++;
        if (k >= items.length) return;
        try {
          out[k] = await worker(items[k], k);
        } catch (e) {
          out[k] = { error: String(e) };
        }
      }
    }),
  );
  return out;
}

function parseRepo(url) {
  const m = /github\.com\/([^/]+)\/([^/#?]+)/.exec(url ?? "");
  if (!m) return null;
  return { owner: m[1], repo: m[2].replace(/\.git$/, "") };
}

/**
 * What a scan of this cache needs to be able to read.
 *
 * `.sh` was added in E9-45b, and its absence had cost real time: nine
 * catalogue scripts run a shell script by name, and `amenbreak`'s endless
 * "please restart norns" could not be explained from the cache at all —
 * the `install.sh` that holds the answer had to be fetched from the CDN by
 * hand. A scan cannot find what the cache never kept.
 */
const WANT = /\.(lua|sc|scd|json|md|sh)$/i;

async function main() {
  await mkdir(join(HERE, "files"), { recursive: true });

  const cat = await getJson(CATALOG);
  const entries = cat.entries ?? cat;
  console.log(`catalogue: ${entries.length} entries`);

  const repos = [];
  for (const e of entries) {
    const r = parseRepo(e.project_url ?? e.url ?? "");
    if (r) repos.push({ ...r, name: e.project_name ?? r.repo });
  }
  console.log(`repos: ${repos.length}`);

  // --- listings -----------------------------------------------------------
  const listPath = join(HERE, "listings.json");
  let listings;
  try {
    listings = JSON.parse(await readFile(listPath, "utf8"));
    console.log(`listings: cached (${Object.keys(listings).length})`);
  } catch {
    listings = {};
  }

  // A listing that FAILED is asked for again: `semiconductor` sat here as
  // "will not list" for as long as nobody looked, and the answer changed.
  const todo = repos.filter((r) => {
    const l = listings[`${r.owner}/${r.repo}`];
    return !l || l.failed === true;
  });
  console.log(`listings to fetch: ${todo.length}`);
  let done = 0;
  await pool(todo, 8, async (r) => {
    const key = `${r.owner}/${r.repo}`;
    const now = whereNow(key);
    const from = now === key ? {} : { from: now };
    for (const branch of ["main", "master"]) {
      try {
        const j = await getJson(
          `https://data.jsdelivr.com/v1/packages/gh/${now}@${branch}?structure=flat`,
        );
        const files = (j.files ?? []).map((f) => f.name.replace(/^\//, ""));
        listings[key] = { branch, name: r.name, files, ...from };
        if (++done % 25 === 0) console.log(`  ${done}/${todo.length}`);
        return;
      } catch {
        /* try the next branch */
      }
    }
    // E9-73 — ASK GITHUB BEFORE GIVING UP, which is what the INSTALLER
    // does and this sweep did not.
    //
    // `listFiles` tries GitHub's tree API first and falls through to
    // jsDelivr; here it is the other way round, because 60 anonymous
    // requests an hour is nowhere near 355 and is ample for the handful
    // jsDelivr will not answer for.
    //
    // And it will not answer for two of them. `schollz/kolor` is a 52 MB
    // repository and the listing API says so in as many words — "Package
    // size exceeded the configured limit of 50 MB" — while the CDN serves
    // its files perfectly well; `monome-community/nc01-drone` is 111 MB
    // and the same. Both are on GitHub, neither is renamed or private, and
    // both install. The table called them "renamed, private or gone" for
    // weeks because this loop asked one service and reported its answer as
    // the repository's condition.
    for (const branch of ["main", "master"]) {
      try {
        const j = await getJson(
          `https://api.github.com/repos/${now}/git/trees/${branch}?recursive=1`,
        );
        if (j.truncated === true) continue;
        const files = (j.tree ?? [])
          .filter((e) => e.type === "blob" && typeof e.path === "string")
          .map((e) => e.path);
        if (files.length === 0) continue;
        listings[key] = { branch, name: r.name, files, via: "github", ...from };
        done++;
        return;
      } catch {
        /* try the next branch, then give up */
      }
    }
    listings[key] = { branch: null, name: r.name, files: [], failed: true };
    done++;
  });
  await writeFile(listPath, JSON.stringify(listings, null, 1));
  const failed = Object.entries(listings).filter(([, v]) => v.failed);
  console.log(`listings done; ${failed.length} failed: ${failed.map(([k]) => k).join(", ")}`);

  // --- files --------------------------------------------------------------
  const wanted = [];
  for (const [key, v] of Object.entries(listings)) {
    for (const p of v.files ?? []) {
      if (WANT.test(p) && !/node_modules/.test(p)) {
        wanted.push({ key, from: v.from ?? key, branch: v.branch, path: p });
      }
    }
  }
  console.log(`files wanted: ${wanted.length}`);

  let got = 0;
  let skipped = 0;
  let bad = 0;
  await pool(wanted, 12, async (f) => {
    const local = join(HERE, "files", f.key, f.path);
    try {
      await stat(local);
      skipped++;
      return;
    } catch {
      /* not cached */
    }
    const url = `https://cdn.jsdelivr.net/gh/${f.from}@${f.branch}/${f.path}`;
    const r = await fetch(url);
    if (!r.ok) {
      bad++;
      return;
    }
    const body = await r.text();
    await mkdir(dirname(local), { recursive: true });
    await writeFile(local, body);
    if (++got % 200 === 0) console.log(`  files ${got + skipped}/${wanted.length}`);
  });
  console.log(`files: ${got} fetched, ${skipped} already cached, ${bad} failed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
