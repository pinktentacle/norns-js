// E9-203 — an engine nobody publishes, because the study has you write it.
//
// `streams` sets `engine.name = "Moonshine"`. Moonshine is the engine of
// monome's two engine studies: the reader types it in, and no catalogue
// script carries it — it is in none of the 355 repositories. So the note in
// maiden said the engine "is in no catalogue script", which was true, and
// the script could not run for anyone who had not done the study.
//
// The study PUBLISHES the engine, whole, as the last two listings of its
// second part. This fetches that page — pinned to a commit, so what arrives
// is what was checked — takes the two listings out of it, verifies each
// against the hash recorded when it was read, and writes them where the
// study says to put them: `code/engine_study/lib`.
//
// FETCHED, NOT SHIPPED. It goes from monome to the user's own storage, the
// way a catalogue script does; this build carries none of it. The folder
// gets a README naming the authors, the page and the licence.
//
// IT FAILS CLOSED. A listing that no longer matches its hash is not
// installed: an engine is code that runs in the audio server, and "the
// page changed" is not a reason to run something nobody looked at.

import table from "./study-engines.json";
import type { CatalogEntry } from "./catalog.js";
import type { CommunityInstall } from "./install.js";
import type { Vfs } from "../fs/vfs.js";

export interface StudyEngine {
  readonly engine: string;
  /** The folder under `code/`, as the study names it. */
  readonly folder: string;
  /** The page's source, pinned to a commit. */
  readonly page: string;
  /** The page a person reads. */
  readonly read: string;
  readonly title: string;
  readonly credit: string;
  readonly licence: string;
  readonly files: ReadonlyArray<{ readonly path: string; readonly starts: string; readonly sha256: string }>;
}

/** What an entry's `url` says when it is one of these rather than a repository. */
export const STUDY_SCHEME = "study:";

const ENGINES = (table as { engines: Record<string, Omit<StudyEngine, "engine">> }).engines;

export function studyEngine(engine: string): StudyEngine | null {
  const spec = ENGINES[engine];
  return spec === undefined ? null : { engine, ...spec };
}

/** The engine a `study:` url names, or null for any other url. */
export function studyEngineOf(url: string): StudyEngine | null {
  return url.startsWith(STUDY_SCHEME) ? studyEngine(url.slice(STUDY_SCHEME.length)) : null;
}

/**
 * Something the install queue can carry: it takes catalogue entries, and
 * this is one in every respect but where it comes from.
 */
export function studyEntry(engine: string): CatalogEntry | null {
  const spec = studyEngine(engine);
  if (spec === null) return null;
  return {
    name: spec.folder,
    url: `${STUDY_SCHEME}${engine}`,
    author: "monome",
    description: `the ${engine} engine, from ${spec.title}`,
    tags: [],
    discussion: null,
    documentation: spec.read,
  };
}

/**
 * The LAST fenced listing whose first line of code starts with `starts`.
 *
 * The last, because a study builds its engine up: the page holds three
 * `Moonshine { … }` and only the third is the one the engine file expects.
 * The first line OF CODE, because that one opens with two comment lines.
 */
export function extractListing(markdown: string, starts: string): string | null {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const fences: number[] = [];
  lines.forEach((l, i) => {
    if (l.trim().startsWith("```")) fences.push(i);
  });
  let found: string | null = null;
  for (let k = 0; k + 1 < fences.length; k += 2) {
    const body = lines.slice(fences[k]! + 1, fences[k + 1]!);
    const first = body.find((l) => l.trim() !== "" && !l.trim().startsWith("//")) ?? "";
    if (first.startsWith(starts)) found = `${body.join("\n")}\n`;
  }
  return found;
}

async function sha256(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const readme = (spec: StudyEngine): string =>
  [
    `# ${spec.folder}`,
    "",
    `The ${spec.engine} engine, from monome's "${spec.title}".`,
    "",
    spec.credit,
    "",
    `Read it, and write it yourself: ${spec.read}`,
    "",
    `These files are the listings of that page, fetched unchanged from`,
    `${spec.page}`,
    `by norns-js because a script you installed sets engine.name = "${spec.engine}".`,
    `Licence: ${spec.licence}.`,
    "",
  ].join("\n");

export async function installStudyEngine(
  vfs: Vfs,
  spec: StudyEngine,
  opts: {
    root?: string;
    fetchText?: (url: string, signal?: AbortSignal) => Promise<string>;
    signal?: AbortSignal;
    /** Make it durable before saying it is installed. See `install.ts`. */
    commit?: () => Promise<void>;
  } = {},
): Promise<CommunityInstall> {
  const fetchText =
    opts.fetchText ??
    (async (url: string, signal?: AbortSignal): Promise<string> => {
      const r = await fetch(url, signal === undefined ? {} : { signal });
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      return r.text();
    });
  const page = await fetchText(spec.page, opts.signal);

  // Everything is checked before anything is written: half an engine is a
  // class library that does not compile.
  const ready: Array<{ path: string; text: string }> = [];
  for (const f of spec.files) {
    const text = extractListing(page, f.starts);
    if (text === null) {
      throw new Error(`the study's page no longer has the listing for ${f.path} — it is at ${spec.read}`);
    }
    if ((await sha256(text)) !== f.sha256) {
      throw new Error(
        `the listing for ${f.path} is not the one that was checked, so it was not installed — ` +
          `read it at ${spec.read} and add it yourself`,
      );
    }
    ready.push({ path: f.path, text });
  }

  const dir = `${opts.root ?? "/home/we/dust"}/code/${spec.folder}`;
  ready.push({ path: "README.md", text: readme(spec) });
  let bytes = 0;
  for (const f of ready) {
    vfs.write(`${dir}/${f.path}`, f.text);
    bytes += f.text.length;
  }
  await opts.commit?.();
  return { name: spec.folder, branch: "study", files: ready.length, bytes, skipped: [], needsReload: true };
}
