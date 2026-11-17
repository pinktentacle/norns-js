// The editor's door onto the store: what it refuses, and what it moves.
//
// Everything here is destructive or close to it, and the one thing that
// must never happen is a file becoming shorter than it was because
// something could not read it properly.

import { describe, expect, it } from "vitest";
import { Vfs } from "../src/fs/vfs.js";
import { createVfsStore } from "../src/editor/store.js";

const ROOT = "/home/we/dust";
const text = (s: string): Uint8Array => new TextEncoder().encode(s);

function tree(): { vfs: Vfs; store: ReturnType<typeof createVfsStore> } {
  const vfs = new Vfs();
  vfs.mount(`${ROOT}/code/awake/awake.lua`, () => "-- bundled\n");
  vfs.write(`${ROOT}/code/mine/mine.lua`, "-- mine\n");
  return { vfs, store: createVfsStore(vfs) };
}

describe("opening", () => {
  it("refuses a file whose bytes have never arrived", () => {
    // `vfs.read` answers null, which an editor would show as an empty
    // buffer and save back as an empty file: 9.7 MB of amen break
    // destroyed by Ctrl-S.
    const { vfs, store } = tree();
    vfs.mountRemote(`${ROOT}/audio/amen/break.wav`, { url: "/x.wav", size: 1270628 });
    const r = store.open(`${ROOT}/audio/amen/break.wav`);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.why).toContain("not downloaded");
  });

  it("refuses something that is not text, rather than mangling it", () => {
    const { vfs, store } = tree();
    vfs.write(`${ROOT}/audio/x.wav`, new Uint8Array([0xff, 0xfe, 0x00, 0x80, 0x41]));
    const r = store.open(`${ROOT}/audio/x.wav`);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.why).toContain("not a text file");
  });

  it("refuses a folder, and says which kind of refusal it is", () => {
    const { store } = tree();
    const r = store.open(`${ROOT}/code/awake`);
    expect(r.ok === false && r.why).toContain("folder");
  });

  it("opens a bundled file, and marks the edited one as the session's", () => {
    const { vfs, store } = tree();
    expect(store.open(`${ROOT}/code/awake/awake.lua`)).toEqual({ ok: true, text: "-- bundled\n" });
    const before = store.list(`${ROOT}/code/awake`)[0];
    expect(before?.mine).toBe(false);
    store.save(`${ROOT}/code/awake/awake.lua`, "-- changed\n");
    expect(store.list(`${ROOT}/code/awake`)[0]?.mine).toBe(true);
    expect(vfs.readText(`${ROOT}/code/awake/awake.lua`)).toBe("-- changed\n");
  });

  it("does not count a merely downloaded file as the session's", () => {
    // Reading a lazily-fetched sample caches its bytes in the same overlay
    // a written file lands in; `wasFetched` is the difference, and the
    // export code learned it the expensive way.
    const { vfs, store } = tree();
    vfs.mountRemote(`${ROOT}/audio/a.wav`, { url: "/a.wav", size: 4 });
    globalThis.fetch = (async () => new Response(text("abcd") as BodyInit)) as typeof fetch;
    return vfs.fetchRemote(`${ROOT}/audio/a.wav`).then(() => {
      expect(store.list(`${ROOT}/audio`)[0]?.mine).toBe(false);
    });
  });
});

describe("making and moving", () => {
  it("creates a file and a folder, and refuses to land on something", () => {
    const { store } = tree();
    expect(store.create(`${ROOT}/code/new.lua`, "file")).toEqual({
      ok: true,
      path: `${ROOT}/code/new.lua`,
    });
    expect(store.create(`${ROOT}/code/new.lua`, "file").ok).toBe(false);
    expect(store.create(`${ROOT}/code/newdir`, "folder").ok).toBe(true);
    expect(store.list(`${ROOT}/code`).some((e) => e.name === "newdir" && e.kind === "dir")).toBe(
      true,
    );
  });

  it("refuses a name that climbs out of the tree", () => {
    // The names come from a text box, and a text box is where
    // `../../etc/passwd` comes from.
    const { store } = tree();
    expect(store.create("/etc/passwd", "file").ok).toBe(false);
    expect(store.create(`${ROOT}/code/../../outside.lua`, "file").ok).toBe(false);
  });

  it("renames, and takes the contents with it", () => {
    const { vfs, store } = tree();
    expect(store.rename(`${ROOT}/code/mine/mine.lua`, `${ROOT}/code/mine/other.lua`).ok).toBe(true);
    expect(vfs.readText(`${ROOT}/code/mine/other.lua`)).toBe("-- mine\n");
    expect(vfs.exists(`${ROOT}/code/mine/mine.lua`)).toBe(false);
  });

  it("renames a folder by moving everything under it", () => {
    const { vfs, store } = tree();
    vfs.write(`${ROOT}/code/mine/lib/a.lua`, "a");
    expect(store.rename(`${ROOT}/code/mine`, `${ROOT}/code/yours`).ok).toBe(true);
    expect(vfs.readText(`${ROOT}/code/yours/mine.lua`)).toBe("-- mine\n");
    expect(vfs.readText(`${ROOT}/code/yours/lib/a.lua`)).toBe("a");
    expect(vfs.isDir(`${ROOT}/code/mine`)).toBe(false);
  });

  it("refuses to rename onto something that exists", () => {
    const { store } = tree();
    expect(store.rename(`${ROOT}/code/mine/mine.lua`, `${ROOT}/code/awake/awake.lua`).ok).toBe(
      false,
    );
  });

  it("duplicates beside the original, under a free name", () => {
    const { vfs, store } = tree();
    const a = store.duplicate(`${ROOT}/code/mine/mine.lua`);
    expect(a).toEqual({ ok: true, path: `${ROOT}/code/mine/mine-copy.lua` });
    const b = store.duplicate(`${ROOT}/code/mine/mine.lua`);
    expect(b).toEqual({ ok: true, path: `${ROOT}/code/mine/mine-copy-2.lua` });
    expect(vfs.readText(`${ROOT}/code/mine/mine-copy.lua`)).toBe("-- mine\n");
  });

  it("refuses to duplicate a file whose bytes are not here", () => {
    // A copy of nothing is a zero-length file wearing the name of a
    // 9 MB sample.
    const { vfs, store } = tree();
    vfs.mountRemote(`${ROOT}/audio/big.wav`, { url: "/big.wav", size: 9522000 });
    expect(store.duplicate(`${ROOT}/audio/big.wav`).ok).toBe(false);
  });

  it("deletes a folder and everything under it", () => {
    const { vfs, store } = tree();
    vfs.write(`${ROOT}/code/mine/lib/a.lua`, "a");
    expect(store.remove(`${ROOT}/code/mine`).ok).toBe(true);
    expect(vfs.exists(`${ROOT}/code/mine/mine.lua`)).toBe(false);
    expect(vfs.exists(`${ROOT}/code/mine/lib/a.lua`)).toBe(false);
  });
});

describe("putting a bundled file back", () => {
  it("can revert what the build supplies, and not what it does not", () => {
    const { store } = tree();
    expect(store.canRevert(`${ROOT}/code/awake/awake.lua`)).toBe(true);
    expect(store.canRevert(`${ROOT}/code/mine/mine.lua`)).toBe(false);
  });

  it("undoes an edit to a bundled file", () => {
    const { vfs, store } = tree();
    store.save(`${ROOT}/code/awake/awake.lua`, "-- changed\n");
    expect(store.revert(`${ROOT}/code/awake/awake.lua`).ok).toBe(true);
    expect(vfs.readText(`${ROOT}/code/awake/awake.lua`)).toBe("-- bundled\n");
    expect(store.list(`${ROOT}/code/awake`)[0]?.mine, "and it is the build's again").toBe(false);
  });

  it("says no rather than deleting a file you wrote", () => {
    const { vfs, store } = tree();
    expect(store.revert(`${ROOT}/code/mine/mine.lua`).ok).toBe(false);
    expect(vfs.readText(`${ROOT}/code/mine/mine.lua`)).toBe("-- mine\n");
  });
});
