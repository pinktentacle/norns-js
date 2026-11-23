// E9-209 — how many stars each catalogue script has, and when it was
// first published and last pushed: the table the script store sorts by.
//
//   node tools/build-meta.mjs        writes public/community-meta.json
//
// WHY THERE IS A TABLE AT ALL. The catalogue is a name, an author, a
// sentence and some tags — no dates, no counts — so "popular" and "new"
// have to come from somewhere else, and the somewhere is the repository
// each entry points at. GitHub's repository search takes MANY `repo:`
// qualifiers in one query and answers with stars and dates for all of
// them, without a token: sixty repositories a request, six requests for
// the whole catalogue, where asking one repository at a time would be 355
// requests against an allowance of sixty an hour.
//
// THE PAGE DOES THE SAME THING ITSELF, once a week, and keeps the answer
// (src/community/meta.ts). This file is what it starts from: the store has
// its charts the first time it is opened, offline, and in the desktop
// application before a single request has been made.
//
// WHAT THE SEARCH DOES NOT FIND IS ASKED FOR BY NAME. A repository that
// was renamed is not found under its old name by the search, and is
// forwarded by `/repos/<owner>/<name>`. That is a handful, and the hourly
// allowance is ample for a handful.

import { readFile, writeFile } from "node:fs/promises";

const ROOT = new URL("../", import.meta.url);
const CATALOG = "https://raw.githubusercontent.com/monome/norns-community/main/community.json";
const SEARCH = "https://api.github.com/search/repositories";
const PER_QUERY = 60;
const HEADERS = { accept: "application/vnd.github+json", "user-agent": "norns-js-catalogue-meta" };

const MOVED = JSON.parse(await readFile(new URL("src/community/moved.json", ROOT), "utf8")).moved;
const movedTo = Object.fromEntries(Object.entries(MOVED).map(([from, v]) => [from.toLowerCase(), v.to]));

/** `https://github.com/owner/repo(.git)(/anything)` → `owner/repo`. */
function repoOf(url) {
  const m = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/#?]+)/.exec(String(url ?? "").trim());
  if (!m) return null;
  const key = `${m[1]}/${m[2].replace(/\.git$/i, "")}`;
  return movedTo[key.toLowerCase()] ?? key;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const day = (iso) => String(iso ?? "").slice(0, 10);
const row = (r) => [r.stargazers_count ?? 0, day(r.created_at), day(r.pushed_at)];

const catalogue = await (await fetch(CATALOG)).json();
const wanted = new Map(); // owner/repo, lower-cased -> { repo, names }
const elsewhere = [];
for (const e of catalogue.entries ?? []) {
  const name = String(e.project_name ?? "").trim();
  const repo = repoOf(e.project_url);
  if (name === "") continue;
  if (repo === null) {
    elsewhere.push(name);
    continue;
  }
  const slot = wanted.get(repo.toLowerCase()) ?? { repo, names: [] };
  slot.names.push(name);
  wanted.set(repo.toLowerCase(), slot);
}

const found = new Map(); // owner/repo, lower-cased -> [stars, created, pushed]
const repos = [...wanted.values()].map((w) => w.repo);
for (let i = 0; i < repos.length; i += PER_QUERY) {
  const batch = repos.slice(i, i + PER_QUERY);
  const url = `${SEARCH}?q=${batch.map((r) => `repo:${r}`).join("+")}+fork:true&per_page=100`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  for (const r of body.items ?? []) found.set(String(r.full_name).toLowerCase(), row(r));
  console.log(`search ${i / PER_QUERY + 1}: asked ${batch.length}, answered ${body.items?.length ?? 0}`);
  // Ten searches a minute is the allowance; this never gets near it, and
  // says so by waiting when the header says there is none left.
  if (res.headers.get("x-ratelimit-remaining") === "0") {
    const until = Number(res.headers.get("x-ratelimit-reset")) * 1000 - Date.now();
    await sleep(Math.max(1000, until + 1000));
  } else await sleep(1200);
}

const missed = repos.filter((r) => !found.has(r.toLowerCase()));
const gone = [];
for (const repo of missed) {
  const res = await fetch(`https://api.github.com/repos/${repo}`, { headers: HEADERS });
  if (res.ok) {
    const r = await res.json();
    found.set(repo.toLowerCase(), row(r));
    console.log(`by name: ${repo} is now ${r.full_name}`);
  } else {
    gone.push(repo);
    console.log(`by name: ${repo} — ${res.status}`);
  }
}

const scripts = {};
for (const [key, w] of wanted) {
  const got = found.get(key);
  if (got === undefined) continue;
  for (const name of w.names) scripts[name] = got;
}
const names = Object.keys(scripts).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

// One script a line: a diff of this file is then a list of what changed.
const lines = names.map((n) => `  ${JSON.stringify(n)}: ${JSON.stringify(scripts[n])}`);
const head = {
  generated: new Date().toISOString().slice(0, 10),
  from: `GitHub, for the ${catalogue.entries?.length ?? 0}-entry monome/norns-community catalogue`,
  note:
    "name -> [stars, first published, last pushed], of the repository the catalogue points at. " +
    "A script absent from this table is on no chart; that is all its absence means.",
};
const text =
  "{\n" +
  Object.entries(head)
    .map(([k, v]) => ` ${JSON.stringify(k)}: ${JSON.stringify(v)},`)
    .join("\n") +
  '\n "scripts": {\n' +
  lines.join(",\n") +
  "\n }\n}\n";
await writeFile(new URL("public/community-meta.json", ROOT), text);

console.log(`\n${names.length} of ${catalogue.entries?.length ?? 0} scripts have a row`);
if (elsewhere.length > 0) console.log(`not a github repository: ${elsewhere.join(", ")}`);
if (gone.length > 0) console.log(`not found by search or by name: ${gone.join(", ")}`);
