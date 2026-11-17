// E6-11 — installing a script from its repository, without a zip.
//
// WHY NOT A ZIP, which would have been the obvious route and is the one
// `src/fs/transfer.ts` already has. Measured from the running page, which is
// cross-origin isolated and so may only read cross-origin responses that
// carry CORS:
//
//     https://codeload.github.com/<o>/<r>/zip/refs/heads/main   Failed to fetch
//     https://api.github.com/repos/<o>/<r>/zipball/main         Failed to fetch
//     https://data.jsdelivr.com/v1/packages/gh/<o>/<r>@main     200, cors
//     https://cdn.jsdelivr.net/gh/<o>/<r>@main/<path>           200, cors
//     https://raw.githubusercontent.com/<o>/<r>/main/<path>     200, cors
//
// GitHub will not let a page download a repository as an archive. It will
// let a page read the files one at a time, and jsDelivr will list them in a
// single request. So an install is: one listing, then one fetch per file
// worth having — which for a norns script is a dozen or two.
//
// WHAT IS WORTH HAVING, and why this filters rather than taking everything:
// a repository carries documentation images, screenshots, release archives
// and sometimes a sample library. A norns script is Lua, SuperCollider
// classes, a few data files and its licence. Everything else is left on the
// server, where it can stay.
//
// THE LICENCE FILE IS ALWAYS TAKEN. It costs nothing, it is the one file
// that says what the user may do with the rest, and leaving it behind is how
// a tidy filter turns into a compliance problem (E7-13 found exactly that in
// our own build).

import type { Vfs } from "../fs/vfs.js";
import limits from "./limits.json";

export interface Repo {
  readonly owner: string;
  readonly repo: string;
}

/** `https://github.com/owner/repo(.git)(/tree/branch)` → the two names. */
export function parseRepoUrl(url: string): Repo | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.hostname !== "github.com" && u.hostname !== "www.github.com") return null;
  const parts = u.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0]!;
  const repo = parts[1]!.replace(/\.git$/i, "");
  if (owner === "" || repo === "") return null;
  return { owner, repo };
}

/**
 * What a norns script is made of. Mirrors `tools/build-dust.mjs`.
 *
 * `.sh` IS PART OF A SCRIPT, and leaving it out was never a decision —
 * this is an allowlist and it simply was not on it, while the skip said
 * `.sh is not part of a script` about a file the script calls by name.
 * Measured on the catalogue: 15 repositories ship one, 28 files in all,
 * and NINE scripts execute one — amenbreak, graintopia, makebreakbeat,
 * norns.online, pirate-radio, sampswap, zxcvbn, warmreload, terrarium.
 *
 * Taking it does not make most of them work: they launch Go binaries,
 * compile C, or download a GitHub release asset the browser may not
 * fetch. What it buys is a diagnosis that can be made from inside the
 * app. `amenbreak`'s endless restart could only be explained by going
 * to the CDN to read an `install.sh` that was never installed; now the
 * shell reads it and names the line it cannot run.
 *
 * The same argument as the sound files below, which were left out on a
 * reasoning that measurement then contradicted.
 */
const TEXT_EXT = new Set([".lua", ".sc", ".scd", ".txt", ".md", ".toml", ".sh"]);
/**
 * Never part of a script: compiled for another machine, or a document.
 *
 * `.so` is the ARM build of a UGen or a Lua C module (`pitter-patter` ships
 * `lib/cjson.so`); the extensions this build does have arrive through
 * `extensions.ts`, not through a script's repository.
 */
const NOT_A_SCRIPT = new Set([
  ".so", ".o", ".a", ".dylib", ".dll", ".exe", ".bin", ".deb", ".whl",
  ".zip", ".tar", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar",
  ".mp4", ".mov", ".avi", ".webm", ".mkv",
  ".pdf", ".psd", ".ai", ".sketch", ".jpg", ".jpeg", ".gif", ".svg", ".webp",
  // E9-67 — an image EDITOR'S document, which is not an image a script
  // draws. `splnkr` keeps `images/logo/splnkr.xcf`, 2.96 MB of GIMP, and
  // an unknown extension counts as data, so the installer fetched it —
  // and jsDelivr, which does not serve it, took the whole install down
  // with it. `.psd`, `.ai` and `.sketch` were already here; these are
  // the same thing under other tools.
  ".xcf", ".kra", ".blend", ".afdesign", ".afphoto", ".eps", ".fig",
]);
/** Small binaries a script actually draws. */
const BIN_EXT = new Set([".png"]);
/**
 * A script's own sound files, which ARE part of the script.
 *
 * They were left out at first, on the reasoning that a repository's audio is
 * a sample library and belongs on the server. Measured against what that
 * does: installing `amen` gave a script whose samples/ folder was empty, so
 * its own start-up copy had nothing to copy and crone reported
 *
 *     crone: no such file /home/we/dust/audio/amen/amenbreak_bpm136.wav
 *     s| Buffer UGen: no buffer data
 *
 * — a sampler installed silent, with nothing in the dialogue to say why.
 * A sample a script ships is no more optional than its Lua.
 */
const AUDIO_EXT = new Set([".wav", ".aif", ".aiff", ".flac", ".ogg", ".mp3"]);
const LICENCE_FILE = /^(licen[sc]e|copying|notice|authors)(\.(md|txt))?$/i;
/**
 * Never part of a script, and often the biggest thing in the repository.
 *
 * `img`, `images` and `assets` USED to be on this list and are not any
 * more. They are where a script keeps the art it draws, not only the
 * screenshot for its thread: `Ygg.lua:1172` is
 *
 *     tree = screen.load_png(CODE_DIR .. "img/tree.png")
 *     assert(tree, "tree.png failed to load")
 *
 * and the 8 KB PNG beside it was skipped because of the folder's name, so
 * the script asserted its way out of `init` every time. The cost of the
 * other direction -- fetching a screenshot nobody draws -- is bounded by
 * MAX_BIN and MAX_BIN_TOTAL below and is paid in kilobytes; the cost of
 * this direction was a script that cannot start.
 */
const SKIP_DIR = new Set([".git", ".github", "screenshots", "doc", "docs", "node_modules"]);
/** One text file this big is a mistake, not a script. */
const MAX_TEXT = 512 * 1024;
const MAX_BIN = 2 * 1024 * 1024;
/**
 * The images a script draws are small; a folder of them is still bounded.
 *
 * Now that `img/` and `assets/` are fetched (see SKIP_DIR), a repository
 * that keeps a gallery in one of them cannot run away with the install.
 * `pirate-radio` draws 190 PNGs and comes to well under this, because a
 * 128×64 one-bit picture is a few kilobytes.
 */
const MAX_BIN_TOTAL = 16 * 1024 * 1024;
/**
 * A script's DATA, which is not prose and is not bounded like prose.
 *
 * `.json` and `.csv` used to be in TEXT_EXT, under a 512 KB cap meant for
 * "one text file this big is a mistake, not a script". For a script's data
 * that is simply wrong: `overwintering` ships four bird recordings as JSON,
 * 1.4 to 2.9 MB each, and `Trove.get_bird` returned nil for every one of
 * them because all four were skipped. The script died at
 * `lib/sequencer.lua:430` indexing that nil, with nothing in the log about
 * a file.
 *
 * An UNKNOWN extension is data too. The old rule skipped anything it did
 * not recognise and called it "not a file this build can use", which was a
 * guess dressed as a fact: `internorns` keeps its patches in
 * `data/default.mtpreset`, 18 KB, and died in `io.lines` on a file that was
 * never fetched. A file in a script's own repository, small enough to be
 * data, IS data until something says otherwise — and what says otherwise
 * is NOT_A_SCRIPT, not the absence of a name from an allowlist.
 *
 * 8 MB a file takes `overwintering`'s largest bird (2.9 MB) with room to
 * spare; the running total stops a repository that keeps a corpus.
 */
const MAX_DATA = 8 * 1024 * 1024;
const MAX_DATA_TOTAL = 32 * 1024 * 1024;
/**
 * Sound is allowed to be big, but not unbounded.
 *
 * 16 MB a file matches what the dust packer allows (tools/build-dust.mjs),
 * and amen's two samples — 1.2 MB and 9.3 MB — both fit. The running total
 * is what stops a repository that is a sample library: past it, the rest is
 * skipped and SAID, rather than quietly downloading half a gigabyte into
 * somebody's browser storage.
 */
const MAX_AUDIO = 16 * 1024 * 1024;
const MAX_AUDIO_TOTAL = 64 * 1024 * 1024;
/**
 * How many files an install will take before it refuses.
 *
 * E9-72 — A NUMBER SOMEBODY CAN CHANGE, and a different number than it
 * was. 400 was a guess about what "a sample library wearing a script's
 * hat" looks like, and measuring it against the catalogue showed what the
 * guess cost: of the 351 repositories that list, exactly ONE is over 400,
 * and it is `mosaic` at 1209 files. The next largest is `pirate-radio` at
 * 239. So the limit refused one script in 355 and protected nobody from
 * anything — what actually stops a repository that is a sample library is
 * MAX_AUDIO_TOTAL above, which counts BYTES.
 *
 * The default lives in `limits.json` because three things need the same
 * number: here, SETTINGS > FILES, and `tools/build-blockers.mjs`, which
 * decides from it whether a repository gets a note. Three copies of a
 * number is how a note comes to describe a limit that is no longer there.
 */
export const DEFAULT_MAX_FILES: number = limits.installMaxFiles;

export interface Candidate {
  readonly path: string;
  readonly size: number;
}

export function wanted(files: readonly Candidate[]): {
  take: Candidate[];
  skip: Array<{ path: string; why: string }>;
} {
  const take: Candidate[] = [];
  const skip: Array<{ path: string; why: string }> = [];
  let audio = 0;
  let bin = 0;
  let data = 0;
  for (const f of files) {
    const path = f.path.replace(/^\//, "");
    if (path === "") continue;
    const segments = path.split("/");
    const base = segments[segments.length - 1]!;
    const dot = base.lastIndexOf(".");
    const ext = dot > 0 ? base.slice(dot).toLowerCase() : "";

    if (LICENCE_FILE.test(base)) {
      // Always, wherever it sits. See the header.
      take.push({ path, size: f.size });
      continue;
    }
    const dir = segments.slice(0, -1).find((s) => SKIP_DIR.has(s.toLowerCase()));
    if (dir !== undefined) {
      skip.push({ path, why: `in ${dir}/` });
      continue;
    }
    if (TEXT_EXT.has(ext)) {
      if (f.size > MAX_TEXT) skip.push({ path, why: "larger than 512 KB" });
      else take.push({ path, size: f.size });
      continue;
    }
    if (BIN_EXT.has(ext)) {
      if (f.size > MAX_BIN) {
        skip.push({ path, why: "larger than 2 MB" });
      } else if (bin + f.size > MAX_BIN_TOTAL) {
        skip.push({ path, why: `past ${MAX_BIN_TOTAL / 1024 / 1024} MB of images in one install` });
      } else {
        bin += f.size;
        take.push({ path, size: f.size });
      }
      continue;
    }
    if (AUDIO_EXT.has(ext)) {
      if (f.size > MAX_AUDIO) {
        skip.push({ path, why: `larger than ${MAX_AUDIO / 1024 / 1024} MB of audio` });
      } else if (audio + f.size > MAX_AUDIO_TOTAL) {
        skip.push({ path, why: `past ${MAX_AUDIO_TOTAL / 1024 / 1024} MB of audio in one install` });
      } else {
        audio += f.size;
        take.push({ path, size: f.size });
      }
      continue;
    }
    if (ext === "" || NOT_A_SCRIPT.has(ext)) {
      skip.push({
        path,
        why: ext === "" ? "no extension" : `${ext} is not a file this build can use`,
      });
      continue;
    }
    // `.json`, `.csv`, and anything else small enough to be a script's own
    // data. See DATA_EXT: the reason this is not an allowlist is that the
    // allowlist was wrong about `.mtpreset` and would have been wrong again
    // about the next one.
    if (f.size > MAX_DATA) {
      skip.push({ path, why: `larger than ${MAX_DATA / 1024 / 1024} MB of data` });
    } else if (data + f.size > MAX_DATA_TOTAL) {
      skip.push({ path, why: `past ${MAX_DATA_TOTAL / 1024 / 1024} MB of data in one install` });
    } else {
      data += f.size;
      take.push({ path, size: f.size });
    }
  }
  return { take, skip };
}

interface JsDelivrFile {
  name?: unknown;
  size?: unknown;
}

/**
 * List a repository's files at a branch, in one request.
 *
 * `main` then `master`: jsDelivr takes a branch where a version would go,
 * and most norns scripts have no tagged release at all.
 */
export async function listFiles(
  repo: Repo,
  fetchJson: (url: string) => Promise<unknown> = defaultJson,
  /**
   * An exact commit to list instead of probing for a branch.
   *
   * jsDelivr takes a commit id where a version would go — measured against
   * `andr-ew/patcher@82d1cb71…`, which answers 200 with the two files that
   * commit had. That is how a submodule is fetched at the commit its parent
   * pinned rather than at whatever the library's branch has become.
   */
  ref?: string,
): Promise<{ branch: string; files: Candidate[] }> {
  const errors: string[] = [];
  for (const branch of ref ? [ref] : ["main", "master"]) {
    // GitHub FIRST, because jsDelivr's index can be older than jsDelivr's
    // own files. See `gitTree`.
    const tree = await gitTree(repo, branch, fetchJson, errors);
    if (tree !== null) return { branch, files: tree };
    try {
      const body = (await fetchJson(
        `https://data.jsdelivr.com/v1/packages/gh/${repo.owner}/${repo.repo}@${branch}?structure=flat`,
      )) as { files?: unknown };
      const raw = Array.isArray(body.files) ? (body.files as JsDelivrFile[]) : [];
      if (raw.length === 0) {
        errors.push(`${branch}: no files`);
        continue;
      }
      const files = raw
        .filter((f) => typeof f.name === "string")
        .map((f) => ({ path: String(f.name), size: typeof f.size === "number" ? f.size : 0 }));
      return { branch, files };
    } catch (err) {
      errors.push(`${branch}: ${String((err as Error)?.message ?? err)}`);
    }
  }
  throw new Error(`could not list ${repo.owner}/${repo.repo} (${errors.join("; ")})`);
}

/**
 * E9-56 — the file list, from the repository rather than from a cache.
 *
 * jsDelivr's listing and jsDelivr's FILES can come from different commits,
 * and when they do the install is a tree that never existed:
 *
 *     carlosedp/terrarium@main, 2026-11-16
 *       jsDelivr lists  lib/installer.lua   — deleted from the repository
 *       jsDelivr omits  lib/needs.lua       — 6 KB, on main, pushed the 13th
 *       jsDelivr serves terrarium.lua       — the CURRENT one, line 26 of
 *                                             which is include 'lib/needs'
 *
 *     ### MISSING INCLUDE: lib/needs
 *
 * E9-53 read that message and concluded the repository did not publish the
 * file. It does. The listing was three days stale, and nothing about a
 * missing include says whether the file is absent upstream or merely absent
 * from the index we walked — which is the whole reason this now asks the
 * place that cannot be stale.
 *
 * GitHub's tree API answers path, type and size for a whole repository in
 * one request, and marks a submodule `commit` rather than silently omitting
 * it. It is rate limited to 60 an hour for an anonymous caller, which is
 * ample for somebody installing a script and nowhere near enough for a
 * 354-repository sweep — so a failure of any kind falls through to
 * jsDelivr, which is what this always used. Null means "could not answer",
 * never "the repository is empty".
 *
 * `truncated` is a refusal too: GitHub caps a recursive tree, and half a
 * listing is the bug above wearing a different hat.
 */
async function gitTree(
  repo: Repo,
  ref: string,
  fetchJson: (url: string) => Promise<unknown>,
  errors: string[],
): Promise<Candidate[] | null> {
  try {
    const body = (await fetchJson(
      `https://api.github.com/repos/${repo.owner}/${repo.repo}/git/trees/${ref}?recursive=1`,
    )) as { tree?: unknown; truncated?: unknown };
    if (!Array.isArray(body.tree)) return null;
    if (body.truncated === true) {
      errors.push(`${ref}: github tree truncated`);
      return null;
    }
    const files = (body.tree as Array<{ path?: unknown; type?: unknown; size?: unknown }>)
      .filter((e) => e.type === "blob" && typeof e.path === "string")
      .map((e) => ({ path: String(e.path), size: typeof e.size === "number" ? e.size : 0 }));
    return files.length > 0 ? files : null;
  } catch (err) {
    errors.push(`${ref}: github ${String((err as Error)?.message ?? err)}`);
    return null;
  }
}

async function defaultJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

/**
 * E9-27 — a submodule is a POINTER, and a listing does not follow pointers.
 *
 * jsDelivr serves a repository's own tree. Where a submodule sits, git
 * stores a gitlink — a commit id, not a directory — so `?structure=flat`
 * returns not one file of it, the installer walks a listing that is already
 * missing them, and the script lands looking complete.
 *
 * MEASURED, because that symptom is worth knowing exactly. Installing
 * `schollz/pitter-patter` writes 54 files and reports success with nothing
 * skipped. Loading it:
 *
 *     ### MISSING INCLUDE: lib/nb/lib/nb
 *     ### SCRIPT ERROR: load fail
 *     /home/we/dust/code/pitter-patter/pitter-patter.lua:25: ...
 *
 * Across the catalogue: **19 of 354 repositories carry a `.gitmodules`**,
 * pointing at 12 distinct libraries. `sixolet/nb` alone is wanted by eight
 * scripts (cheat_codes_2, forge, hs010, mosaic, n.kria, pitter-patter,
 * tetra, thorns); `andr-ew`'s nest, crops, cartographer, patcher, produce
 * and tune carry the rest, and `ndls` needs six of them at once.
 *
 * Every one of those twelve is a GitHub repository, which is the thing this
 * file already knows how to fetch. So the fix is a recursion, not a new
 * capability.
 *
 * THE PINNED COMMIT IS RECOVERED, and it has to be. `ndls` carries
 * `andr-ew/patcher` TWICE, at `lib/patcher` and `lib/patcher2`, pinned to
 * two different commits — and `include("lib/patcher/ui")` wants a `ui.lua`
 * that the library's `main` no longer has. Measured: at `main` that
 * repository is three files and ndls dies on line 68; at the pinned
 * `82d1cb71…` it is `patcher.lua` and `ui.lua`, and ndls runs. A branch
 * head would have been the wrong file for a third of the nineteen.
 *
 * Where the commit comes from, measured from the page: the GitHub contents
 * API answers cross-origin, and reports a gitlink as a `type: "file"` entry
 * whose `sha` is the commit. One request per directory that holds
 * submodules — ndls needs one — against sixty an hour for a page with no
 * token. When it refuses, the branch head is used instead and the install
 * still happens; that is a library a few commits newer than the author
 * tested, which is a far better failure than no library at all.
 */
export function parseGitmodules(text: string): Array<{ path: string; repo: Repo }> {
  const out: Array<{ path: string; repo: Repo }> = [];
  let path: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[submodule/.test(line)) {
      path = null;
      continue;
    }
    const p = /^\s*path\s*=\s*(.+?)\s*$/.exec(line);
    if (p) {
      path = p[1]!.replace(/^\.?\//, "").replace(/\/$/, "");
      continue;
    }
    const u = /^\s*url\s*=\s*(.+?)\s*$/.exec(line);
    if (!u || path === null) continue;
    // `https://github.com/o/r.git`, `git@github.com:o/r.git` and a bare
    // `../../o/r` relative url all appear in the catalogue's nineteen.
    const raw = u[1]!;
    const m = /github\.com[/:]+([^/]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(raw) ??
      /^\.{1,2}\/(?:\.{2}\/)*([^/]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(raw);
    if (m && path !== "") out.push({ path, repo: { owner: m[1]!, repo: m[2]! } });
    path = null;
  }
  return out;
}

/** One place files are read from: a repository, at a branch, under a prefix. */
interface Source {
  readonly repo: Repo;
  readonly branch: string;
  /** `""` for the script itself, `"lib/nb/"` for a submodule. */
  readonly prefix: string;
  readonly files: Candidate[];
}

/**
 * The commit each submodule path is pinned to, where GitHub will say.
 *
 * One request per directory holding submodules, and never more than four —
 * past that the rate limit is worth more than the precision, and the caller
 * falls back to the branch head for the rest. Any failure is silent on
 * purpose: this is an improvement on a path that already works without it.
 */
async function pinnedCommits(
  repo: Repo,
  branch: string,
  paths: readonly string[],
  fetchJson: (url: string) => Promise<unknown> = defaultJson,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const dirs = new Map<string, string[]>();
  for (const p of paths) {
    const cut = p.lastIndexOf("/");
    const dir = cut < 0 ? "" : p.slice(0, cut);
    if (!dirs.has(dir)) dirs.set(dir, []);
    dirs.get(dir)!.push(p);
  }
  for (const [dir, members] of [...dirs].slice(0, 4)) {
    try {
      const body = (await fetchJson(
        `https://api.github.com/repos/${repo.owner}/${repo.repo}/contents/${dir}?ref=${branch}`,
      )) as Array<{ name?: unknown; sha?: unknown }>;
      if (!Array.isArray(body)) continue;
      for (const p of members) {
        const base = p.slice(dir === "" ? 0 : dir.length + 1);
        const hit = body.find((e) => e.name === base);
        // A gitlink is 40 hex characters and is reported as a "file".
        if (hit && typeof hit.sha === "string" && /^[0-9a-f]{40}$/.test(hit.sha)) {
          out.set(p, hit.sha);
        }
      }
    } catch {
      /* rate limited, offline, or a private repository: use the branch */
    }
  }
  return out;
}

/**
 * The script's own listing, then one per submodule it declares.
 *
 * A submodule that will not list is SKIPPED, not fatal: a dead pointer in
 * somebody's repository should cost the user the library, not the script.
 * The reason comes back in `skipped` so the dialogue can say which.
 *
 * Depth is capped at two. `nb` and nest carry none of their own today, but
 * a cycle here would be an install that never ends.
 *
 * THE CYCLE GUARD IS THE CHAIN, NOT A GLOBAL SET, and the difference is not
 * academic: `ndls` points at `andr-ew/patcher` from two paths at once. A set
 * keyed on the repository drops the second one and ndls fails exactly as it
 * did before. What must not repeat is a repository appearing inside itself,
 * so the guard is the ancestors of this node.
 */
async function collectSources(
  repo: Repo,
  branch: string,
  files: Candidate[],
  opts: {
    fetchJson?: (url: string) => Promise<unknown>;
    fetchBytes?: (url: string, signal?: AbortSignal) => Promise<Uint8Array>;
    signal?: AbortSignal;
  },
  skipped: Array<{ path: string; why: string }>,
  depth = 0,
  chain: readonly string[] = [],
): Promise<Source[]> {
  const out: Source[] = [{ repo, branch, prefix: "", files }];
  if (depth >= 2) return out;
  if (!files.some((f) => f.path.replace(/^\//, "") === ".gitmodules")) return out;

  const getBytes = opts.fetchBytes ?? defaultBytes;
  let text: string;
  try {
    const data = await getBytes(
      `https://cdn.jsdelivr.net/gh/${repo.owner}/${repo.repo}@${branch}/.gitmodules`,
      opts.signal,
    );
    text = new TextDecoder().decode(data);
  } catch {
    return out;
  }

  const mods = parseGitmodules(text);
  if (mods.length === 0) return out;
  const pins = await pinnedCommits(
    repo,
    branch,
    mods.map((m) => m.path),
    opts.fetchJson,
  );

  const here = [...chain, `${repo.owner}/${repo.repo}`.toLowerCase()];
  for (const mod of mods) {
    const key = `${mod.repo.owner}/${mod.repo.repo}`.toLowerCase();
    if (here.includes(key)) continue;
    try {
      const sub = await listFiles(mod.repo, opts.fetchJson, pins.get(mod.path));
      const nested = await collectSources(
        mod.repo,
        sub.branch,
        sub.files,
        opts,
        skipped,
        depth + 1,
        here,
      );
      for (const s of nested) {
        out.push({ ...s, prefix: `${mod.path}/${s.prefix}` });
      }
    } catch (e) {
      skipped.push({
        path: mod.path,
        why: `submodule ${key} would not list: ${String((e as Error)?.message ?? e)}`,
      });
    }
  }
  return out;
}

export interface InstallProgress {
  readonly done: number;
  readonly total: number;
  readonly path: string;
}

export interface CommunityInstall {
  readonly name: string;
  readonly branch: string;
  readonly files: number;
  readonly bytes: number;
  readonly skipped: Array<{ path: string; why: string }>;
  /**
   * The script brings SuperCollider classes, and they are NOT live.
   *
   * Engine classes are injected into sclang's filesystem once, at boot, by
   * scanning `~/dust/code` — so a class installed into a running page is on
   * disk but was never compiled, and the script fails with `missing <Name>`.
   * Measured, on the first script installed this way. A reload fixes it,
   * because OPFS brings the files back before the scan runs. Reported so
   * the dialogue can say that instead of letting the user find out.
   */
  readonly needsReload: boolean;
}

/**
 * Install a repository into `code/<name>/`.
 *
 * The name is the repository's, lower-cased, because that is what SELECT
 * will show and what `norns.state.shortname` becomes. A caller that knows
 * the catalogue's name for it passes that instead.
 */
export async function installFromRepo(
  vfs: Vfs,
  repo: Repo,
  opts: {
    name?: string;
    root?: string;
    onProgress?: (p: InstallProgress) => void;
    fetchJson?: (url: string) => Promise<unknown>;
    fetchBytes?: (url: string, signal?: AbortSignal) => Promise<Uint8Array>;
    /**
     * Give up part way through.
     *
     * An install is dozens of CDN requests and some scripts carry ten
     * megabytes of samples; on a slow line that is a long time to be told
     * only that something is happening. Aborting leaves NOTHING behind, see
     * the staging directory below.
     */
    signal?: AbortSignal;
    /**
     * E9-72 — how many files this install may take, from SETTINGS > FILES.
     *
     * Counted on the LISTING, before `wanted` has dropped anything: the
     * question it answers is "is this a script-sized repository", and that
     * has to be answerable before a thousand requests have been made, not
     * after.
     */
    maxFiles?: number;
  } = {},
): Promise<CommunityInstall> {
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const { branch, files } = await listFiles(repo, opts.fetchJson);
  if (files.length > maxFiles) {
    throw new Error(
      `${repo.owner}/${repo.repo} has ${files.length} files, over the limit of ${maxFiles} — ` +
        "raise it in SETTINGS > FILES, or download it yourself and use import.",
    );
  }

  // E9-27. The script's listing, plus one per library it carries as a git
  // submodule — which the listing does not mention at all. See
  // `parseGitmodules`.
  const subSkips: Array<{ path: string; why: string }> = [];
  const sources = await collectSources(repo, branch, files, opts, subSkips);

  /**
   * One candidate list over every source, not one per source.
   *
   * `wanted` carries a running audio budget and takes the licence file
   * wherever it finds one; both of those are properties of the INSTALL, so
   * they have to see the whole thing at once. The prefix is applied first,
   * so a submodule's own `README.md` is skipped under its real path and the
   * message names it.
   */
  const urlFor = new Map<string, string[]>();
  const all: Candidate[] = [];
  for (const s of sources) {
    for (const f of s.files) {
      const bare = f.path.replace(/^\//, "");
      const p = s.prefix + bare;
      if (urlFor.has(p)) continue;
      all.push({ path: p, size: f.size });
      // E9-53 — THREE SOURCES, because one 404 is not the same as absent.
      // Measured on the three scripts the sweep could not install at all:
      //
      //   Ygg/lib/migration2.lua       jsdelivr@main 404, raw@main 200
      //   terrarium/lib/installer.lua  jsdelivr@main 404, raw 404,
      //                                jsdelivr with NO ref 200
      //
      // The listing that named both files came from jsDelivr itself, so
      // the CDN is disagreeing with its own index. A `.lua` that cannot be
      // fetched still stops the install -- a script missing one of its own
      // files is worse than one not installed -- so the way to save these
      // is to ask the other sources before giving up, not to let it pass.
      const gh = `${s.repo.owner}/${s.repo.repo}`;
      urlFor.set(p, [
        `https://cdn.jsdelivr.net/gh/${gh}@${s.branch}/${bare}`,
        `https://cdn.jsdelivr.net/gh/${gh}/${bare}`,
        `https://raw.githubusercontent.com/${gh}/${s.branch}/${bare}`,
      ]);
    }
  }
  if (all.length > maxFiles) {
    throw new Error(
      `${repo.owner}/${repo.repo} and its ${sources.length - 1} submodule(s) have ` +
        `${all.length} files, over the limit of ${maxFiles} — ` +
        "raise it in SETTINGS > FILES, or download it yourself and use import.",
    );
  }

  const { take, skip: ownSkip } = wanted(all);
  const skip = [...ownSkip, ...subSkips];
  if (take.length === 0) throw new Error("nothing in that repository looks like a norns script");

  // E9-37: THE CALLER'S SPELLING WINS, and only the default is folded.
  //
  // The dialogue passes the catalogue's name already lower-cased, so
  // nothing changes there. What changed is a destination somebody else
  // chose: `taweeet` runs
  //
  //     git clone https://github.com/skibu/nornsLib.git ~/dust/code/nornsLib
  //
  // and folding that to `nornslib` puts the library somewhere the script
  // did not ask for. The include would still find it — E9-31 added a
  // case-insensitive last resort — but a script's own `util.file_exists`
  // on the path it chose would not.
  const name = opts.name ?? repo.repo.toLowerCase();
  const dust = opts.root ?? "/home/we/dust";
  const root = `${dust}/code/${name}`;
  /**
   * WHERE THE FILES LAND FIRST, and why there is a second directory at all.
   *
   * Writing straight into `code/<name>` makes the script EXIST from its
   * first file: the folder is there, so the project activity lists it as
   * installed and SELECT offers it — a script that is one `.lua` and no
   * `lib/` yet, which loads and fails. Reported exactly that way: "quand un
   * script est en cours d'install il apparaît déjà dans installed alors
   * qu'il n'est pas terminé".
   *
   * It also makes cancelling impossible to do cleanly: half a script would
   * be left in the tree with nothing to say which half.
   *
   * So the download lands OUTSIDE `code/` and is moved in when it is whole.
   * `find ~/dust/code/ -mindepth 2` never sees it, which is what SELECT
   * runs, and `installed()` lists `code/` and does not either.
   */
  const staging = `${dust}/.installing/${name}`;
  const getBytes = opts.fetchBytes ?? defaultBytes;
  let bytes = 0;
  let done = 0;
  /** Shrinks when a file the CDN would not serve is given up on. */
  let total = take.length;
  /** Files the listing promised and the CDN did not hand over. */
  const lostFiles: Array<{ path: string; why: string }> = [];

  /** Leave nothing behind, on an abort or on a failure half way through. */
  const sweep = (): void => {
    for (const p of vfs.walk(staging)) vfs.remove(p);
    vfs.remove(staging);
  };

  // EIGHT AT A TIME, AND EIGHT IS MEASURED. This fetched its files one
  // after another, which is where an install's time actually went: 105
  // files at a third of a second of latency each is half a minute of
  // waiting on a script that is three megabytes.
  //
  // Against `cdn.jsdelivr.net`, the same sixteen files, three runs each,
  // median: 1 at a time 117 ms, 4 → 42, 6 → 33, 8 → 29, 12 → 25. The knee
  // is at eight; past it another half as much load on somebody else's CDN
  // buys a fifth. (Those are warm-edge numbers, so the ratios are the
  // measurement and not the absolutes — cold, the same files took 339 ms
  // each one at a time.)
  //
  // The files are independent: each writes its own path, and `done` and
  // `bytes` are only ever touched between awaits on one thread.
  const POOL = 8;
  let next = 0;
  let failure: unknown = null;
  const cancelled = (): boolean => opts.signal?.aborted === true;

  const worker = async (): Promise<void> => {
    for (;;) {
      // A failure in ANY worker stops the others: the install is going to
      // be swept anyway, and twenty more requests for a repository that is
      // not answering is just noise on somebody else's CDN.
      if (failure !== null || cancelled()) return;
      const i = next++;
      if (i >= take.length) return;
      const file = take[i]!;
      try {
        // The signal goes to `fetch` so a ten-megabyte sample stops
        // mid-download rather than at the end of it, and `cancelled()` is
        // checked here as well because a caller's own `fetchBytes` need not
        // honour one.
        const urls = urlFor.get(file.path)!;
        const data = await fetchWithRetry(getBytes, urls, opts.signal, cancelled);
        if (cancelled()) return;
        const target = `${staging}/${file.path}`;
        const dir = target.slice(0, target.lastIndexOf("/"));
        if (dir) vfs.mkdir(dir);
        vfs.write(target, data);
        bytes += data.length;
        done++;
        opts.onProgress?.({ done, total, path: file.path });
      } catch (e) {
        if (cancelled()) return;
        // E9-27. A FILE THAT IS NOT CODE DOES NOT COST THE USER THE SCRIPT.
        //
        // Measured: `juhavaaraniemi/giro` is four files, and one run of its
        // install died on
        //
        //     giro.png: 404
        //
        // for a file the listing had just declared and which serves 200 on
        // every request since. A CDN edge that has not caught up, or a
        // throttle wearing a 404 — either way the script was lost over a
        // screenshot.
        //
        // Code is different: a script missing one `.lua` is a script that
        // loads and fails somewhere else, which is worse than not being
        // installed. So those still stop the install, and everything else
        // is skipped and SAID.
        if (CODE_FILE.test(file.path)) {
          failure ??= e;
          return;
        }
        lostFiles.push({
          path: file.path,
          why: `not served: ${String((e as Error)?.message ?? e)}`,
        });
        total--;
        opts.onProgress?.({ done, total, path: file.path });
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(POOL, take.length) }, () => worker()));
  if (failure !== null || cancelled()) {
    sweep();
    throw failure ?? new DOMException("install cancelled", "AbortError");
  }

  // WHOLE, SO IT MAY BE SEEN. An update replaces what is there: the old
  // tree goes first, or a file the new version dropped would survive as a
  // ghost that `include` still finds.
  for (const p of vfs.walk(root)) vfs.remove(p);
  for (const p of vfs.walk(staging)) {
    const data = vfs.read(p);
    if (data === null) continue;
    vfs.write(root + p.slice(staging.length), data);
  }
  sweep();

  const needsReload = take.some((f) => /\.(sc|scd)$/i.test(f.path));
  return { name, branch, files: done, bytes, skipped: [...skip, ...lostFiles], needsReload };
}

/**
 * What an install cannot do without. Everything else is decoration.
 *
 * A script missing one `.lua` is a script that loads and fails somewhere
 * else, which is worse for the user than not being installed at all.
 */
const CODE_FILE = /\.(lua|sc|scd)$/i;

/**
 * Ask twice before believing a CDN.
 *
 * `juhavaaraniemi/giro` is four files, and one run of its install died on a
 * 404 for `giro.png` — a file the listing had just declared, and which has
 * answered 200 on every request since. An edge that has not caught up, or a
 * throttle wearing a 404. One retry costs a few hundred milliseconds on a
 * failure and nothing at all on success.
 *
 * An abort is not retried: the user asked for it to stop.
 */
/**
 * Twice from the first source, then once from each of the others.
 *
 * The retry is for a throttle wearing a 404; the alternates are for a CDN
 * that disagrees with its own index. Both were measured -- see where the
 * urls are built.
 */
async function fetchWithRetry(
  get: (url: string, signal?: AbortSignal) => Promise<Uint8Array>,
  urls: string[],
  signal: AbortSignal | undefined,
  cancelled: () => boolean,
): Promise<Uint8Array> {
  let last: unknown;
  for (let u = 0; u < urls.length; u++) {
    const tries = u === 0 ? 2 : 1;
    for (let attempt = 0; attempt < tries; attempt++) {
      if (cancelled()) throw new DOMException("install cancelled", "AbortError");
      try {
        return await get(urls[u]!, signal);
      } catch (e) {
        // E9-67 — ONLY THE CALLER'S ABORT ENDS THIS.
        //
        // It used to end on any AbortError, which meant the stall deadline
        // below ended the whole install instead of moving to the next
        // source. The two are told apart by `cancelled()`, which reads the
        // caller's signal and nothing else.
        if (cancelled()) throw new DOMException("install cancelled", "AbortError");
        last = e;
        if (attempt === 0 && tries > 1) await new Promise((r) => setTimeout(r, 250));
      }
    }
  }
  throw last;
}

/**
 * How long a download may say NOTHING before it is abandoned.
 *
 * Not how long it may take. A 16 MB sample on a slow line is a long
 * download and a healthy one; what is not healthy is a connection that
 * delivers no bytes at all, and that is the one this measures. The timer is
 * pushed forward by the headers and by every chunk, so a slow transfer
 * never trips it and a dead one trips in twenty seconds.
 *
 * E9-67, measured on `splnkr`, which would not install twice in a row. One
 * file did it: `images/logo/splnkr.xcf`. jsDelivr answered 404 for it after
 * 17.7 seconds, twice, and then the URL without a ref NEVER ANSWERED AT
 * ALL — still nothing after forty seconds. The third source,
 * raw.githubusercontent, serves the same 2.96 MB in 318 ms and was never
 * reached, because `await fetch(...)` on a dead connection does not return
 * and the install's own signal was the only thing that could stop it. 56 of
 * 57 files, then nothing, then "install cancelled" at 150 seconds.
 */
const STALL_MS = 20000;

async function defaultBytes(url: string, signal?: AbortSignal): Promise<Uint8Array> {
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bump = (): void => {
    clearTimeout(timer);
    timer = setTimeout(
      () => ctl.abort(new DOMException(`${url}: silent for ${STALL_MS} ms`, "TimeoutError")),
      STALL_MS,
    );
  };
  const relay = (): void => ctl.abort(signal?.reason);
  if (signal !== undefined) {
    if (signal.aborted) throw new DOMException("install cancelled", "AbortError");
    signal.addEventListener("abort", relay, { once: true });
  }
  bump();
  try {
    const res = await fetch(url, { signal: ctl.signal });
    bump();
    if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
    // A body is not guaranteed (a 204, or a fetch shim in a test). Falling
    // back to arrayBuffer() keeps the deadline on the headers at least.
    if (res.body === null) return new Uint8Array(await res.arrayBuffer());
    const reader = res.body.getReader();
    const parts: Uint8Array[] = [];
    let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) {
        bump();
        parts.push(value);
        n += value.length;
      }
    }
    const out = new Uint8Array(n);
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  } finally {
    clearTimeout(timer);
    if (signal !== undefined) signal.removeEventListener("abort", relay);
  }
}
