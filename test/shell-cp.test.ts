// `cp` in the shell shim, and the one decision it has to get right.
//
// A script copies its own demo material into `~/dust/audio` on its first
// run — `beets` and `amen` both do — and it does so with a glob. Where the
// files land is decided by whether the destination is a directory, and a
// glob is ONE argument however many files it matches.

import { describe, expect, it } from "vitest";
import { Vfs } from "../src/fs/vfs.js";
import { runShell } from "../src/fs/shell.js";

const text = (s: string): Uint8Array => new TextEncoder().encode(s);

function tree(): Vfs {
  const vfs = new Vfs();
  vfs.write("/home/we/dust/code/s/demo/0.wav", text("zero"));
  vfs.write("/home/we/dust/code/s/demo/1.wav", text("one"));
  return vfs;
}

describe("cp with a glob", () => {
  it("lands each file under the destination when it already exists", () => {
    const vfs = tree();
    vfs.mkdir("/home/we/dust/audio/s");
    runShell(vfs, "cp /home/we/dust/code/s/demo/* /home/we/dust/audio/s");
    expect(vfs.list("/home/we/dust/audio/s").map((e) => e.name).sort()).toEqual([
      "0.wav",
      "1.wav",
    ]);
  });

  it("does the same when the destination does NOT exist yet", () => {
    // The trap this closes. The count used to come from the ARGUMENTS, and
    // a glob is one argument — so with no destination directory the shim
    // took the `cp a b` path and wrote every matched file onto the
    // destination PATH in turn, each overwriting the last. One file,
    // wrongly named, where a folder was meant, and no error anywhere.
    const vfs = tree();
    runShell(vfs, "cp /home/we/dust/code/s/demo/* /home/we/dust/audio/s");
    expect(vfs.read("/home/we/dust/audio/s"), "not a file called `s`").toBeNull();
    expect(vfs.list("/home/we/dust/audio/s").map((e) => e.name).sort()).toEqual([
      "0.wav",
      "1.wav",
    ]);
  });

  it("still renames when there is genuinely one source", () => {
    // `cp a b` where b does not exist is a RENAME, and must stay one.
    const vfs = tree();
    runShell(vfs, "cp /home/we/dust/code/s/demo/0.wav /home/we/dust/audio/renamed.wav");
    expect(vfs.read("/home/we/dust/audio/renamed.wav")).not.toBeNull();
  });

  it("copies a lazily-declared file BY REFERENCE, and keeps it", () => {
    // The bytes are fetched the first time something plays them, so this
    // must not pull them through a shell for a copy nobody may read — and
    // the reference has to be one the store will remember.
    const vfs = new Vfs();
    const remote = { url: "/dust-bin/s/demo/0.wav", size: 4 };
    vfs.mountRemote("/home/we/dust/code/s/demo/0.wav", remote);
    vfs.mkdir("/home/we/dust/audio/s");
    runShell(vfs, "cp /home/we/dust/code/s/demo/* /home/we/dust/audio/s");
    expect(vfs.remoteAt("/home/we/dust/audio/s/0.wav")).toEqual(remote);
    expect(vfs.read("/home/we/dust/audio/s/0.wav"), "still lazy").toBeNull();
    expect(vfs.references().map(([p]) => p)).toEqual(["/home/we/dust/audio/s/0.wav"]);
  });

  it("resurrects a path that had been deleted", () => {
    // A script re-running its own copy after the user cleared the folder
    // must get its files back, not a tombstone.
    const vfs = tree();
    vfs.mkdir("/home/we/dust/audio/s");
    runShell(vfs, "cp /home/we/dust/code/s/demo/* /home/we/dust/audio/s");
    vfs.remove("/home/we/dust/audio/s/0.wav");
    expect(vfs.read("/home/we/dust/audio/s/0.wav")).toBeNull();
    runShell(vfs, "cp /home/we/dust/code/s/demo/* /home/we/dust/audio/s");
    expect(vfs.read("/home/we/dust/audio/s/0.wav")).not.toBeNull();
  });
});

describe("a bare ls, which is how a script finds its loops", () => {
  // `beets` does `io.popen('ls "<path>"/*.wav')` — no flags, and the quote
  // around the DIRECTORY only, so it sits in the middle of the token.
  // Neither case was recognised: the command fell through to the refusal,
  // `f:lines()` gave nothing, and the script loaded zero loops. It ran, it
  // kept time, and it was silent with nothing to say why.
  it("expands a glob to full paths", () => {
    const vfs = tree();
    const out = runShell(vfs, "ls /home/we/dust/code/s/demo/*.wav");
    expect(out.ok).toBe(true);
    expect(out.out.trim().split("\n")).toEqual([
      "/home/we/dust/code/s/demo/0.wav",
      "/home/we/dust/code/s/demo/1.wav",
    ]);
  });

  it("expands it when the quote is in the MIDDLE of the word", () => {
    const vfs = tree();
    const out = runShell(vfs, 'ls "/home/we/dust/code/s/demo"/*.wav');
    expect(out.ok).toBe(true);
    expect(out.out.trim().split("\n")).toEqual([
      "/home/we/dust/code/s/demo/0.wav",
      "/home/we/dust/code/s/demo/1.wav",
    ]);
  });

  it("lists a directory by NAME, as ls does", () => {
    const vfs = tree();
    const out = runShell(vfs, "ls /home/we/dust/code/s/demo");
    expect(out.out.trim().split("\n")).toEqual(["0.wav", "1.wav"]);
  });

  it("is empty, not refused, for a directory that is not there", () => {
    expect(runShell(new Vfs(), "ls /home/we/dust/nope").ok).toBe(true);
  });
});

describe("ls -p, which is how a script learns a name is a directory", () => {
  it("puts a trailing slash on directories, and that decides the glob", () => {
    // `util.scandir` is `ls -pL --group-directories-first`, and norns'
    // scripts build their copy command from what it returns:
    // `from_dir .. '*'`. Without the slash that glob names the directory
    // instead of its contents.
    const vfs = tree();
    vfs.write("/home/we/dust/code/s/readme.md", text("hi"));
    const out = runShell(vfs, 'ls -pL --group-directories-first "/home/we/dust/code/s"');
    expect(out.out.trim().split("\n")).toEqual(["demo/", "readme.md"]);
  });
});

describe("one fetch per path, however many readers ask", () => {
  // softcut and scsynth read the same tree and both fetch; a script
  // triggering several voices on one sample asks several times in a tick.
  // Each used to download the file again — 9.3 MB twice for amen's vinyl
  // loop — and each wrote it back for the mirror to persist again.
  it("asks the network once for two simultaneous readers", async () => {
    const vfs = new Vfs();
    vfs.mountRemote("/home/we/dust/audio/s.wav", { url: "/dust-bin/s.wav", size: 4 });
    let calls = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer };
    }) as unknown as typeof fetch;
    try {
      const [a, b] = await Promise.all([
        vfs.fetchRemote("/home/we/dust/audio/s.wav"),
        vfs.fetchRemote("/home/we/dust/audio/s.wav"),
      ]);
      expect(calls).toBe(1);
      expect(a).toEqual(b);
      expect(vfs.read("/home/we/dust/audio/s.wav")).not.toBeNull();
    } finally {
      globalThis.fetch = original;
    }
  });

  it("asks again later, because the first attempt may have failed", async () => {
    const vfs = new Vfs();
    vfs.mountRemote("/home/we/dust/audio/t.wav", { url: "/dust-bin/t.wav", size: 4 });
    let calls = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls++;
      return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    }) as unknown as typeof fetch;
    try {
      expect(await vfs.fetchRemote("/home/we/dust/audio/t.wav")).toBeNull();
      expect(await vfs.fetchRemote("/home/we/dust/audio/t.wav")).toBeNull();
      expect(calls, "a failure is not cached for ever").toBe(2);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("cd <dir>; ls -d *, which is how a script lists folder NAMES", () => {
  // `beets` builds its loops-folder menu with
  // `io.popen('cd ' .. dir .. '; ls -d *')`. Refusing `cd` left it with an
  // empty list, so its folder parameter read "Create folders in
  // audio/beets to load" and its Load button had nothing to point at.
  const folders = (): Vfs => {
    const vfs = new Vfs();
    vfs.write("/home/we/dust/audio/beets/demo-amen/0.wav", new Uint8Array([1]));
    vfs.write("/home/we/dust/audio/beets/demo-beets/0.wav", new Uint8Array([1]));
    return vfs;
  };

  it("names the folders, not their contents and not their paths", () => {
    // A RELATIVE pattern prints names; the caller joins them to the
    // directory itself. And `-d` names an entry as itself, so a folder of
    // folders answers with two lines, not with every file beneath them.
    const r = runShell(folders(), "cd /home/we/dust/audio/beets/; ls -d *");
    expect(r.ok).toBe(true);
    expect(r.out.trim().split("\n")).toEqual(["demo-amen", "demo-beets"]);
  });

  it("works with && as well as ;", () => {
    const r = runShell(folders(), "cd /home/we/dust/audio/beets && ls -d *");
    expect(r.out.trim().split("\n")).toEqual(["demo-amen", "demo-beets"]);
  });

  it("is empty, not refused, for a folder with nothing in it", () => {
    const vfs = folders();
    vfs.mkdir("/home/we/dust/audio/empty");
    const r = runShell(vfs, "cd /home/we/dust/audio/empty; ls -d *");
    expect(r.ok).toBe(true);
    expect(r.out).toBe("");
  });

  it("still refuses a chained command it does not understand", () => {
    // Supporting one shape is not an invitation to pretend about the rest.
    const r = runShell(folders(), "cd /home/we/dust && rm -rf *");
    expect(r.ok).toBe(false);
    expect(r.refused).toContain("cd ...");
  });
});

// E9-144 — a directory is a source, and `-r` is what says so.
//
// Reported from a Pixel: `kolor` unusable, twelve voices with no samples
// and "Buffer UGen: no buffer data" once each. Its init copies twelve
// sample banks with `cp -r <bank> ~/dust/audio/kolor/`, and every one of
// those copied NOTHING while answering ok — `globIn` expands to files and
// a directory is not one, so the loop ran over an empty list.
describe("cp -r, which is how a script moves its sample banks", () => {
  const withBanks = (): Vfs => {
    const vfs = new Vfs();
    vfs.write("/home/we/dust/code/kolor/samples/bank1/kick.wav", "a");
    vfs.write("/home/we/dust/code/kolor/samples/bank1/hat/closed.wav", "b");
    return vfs;
  };

  it("copies the folder INTO the destination, keeping its shape", () => {
    const vfs = withBanks();
    const r = runShell(vfs, "cp -r /home/we/dust/code/kolor/samples/bank1 /home/we/dust/audio/kolor/");
    expect(r.ok).toBe(true);
    expect(vfs.readText("/home/we/dust/audio/kolor/bank1/kick.wav")).toBe("a");
    // Nested, because a bank is not always flat.
    expect(vfs.readText("/home/we/dust/audio/kolor/bank1/hat/closed.wav")).toBe("b");
  });

  // THE TRAILING SLASH IS THE INTENT, and it was being thrown away: the
  // destination folder does not exist yet when a script copies into it.
  it("treats a trailing slash as a directory even before it exists", () => {
    const vfs = withBanks();
    runShell(vfs, "cp /home/we/dust/code/kolor/samples/bank1/kick.wav /home/we/dust/audio/kolor/");
    expect(vfs.readText("/home/we/dust/audio/kolor/kick.wav")).toBe("a");
    // Not a FILE called `kolor`, which is what it used to write.
    expect(vfs.readText("/home/we/dust/audio/kolor")).toBeNull();
  });

  it("omits a directory when -r was not asked for, as cp does", () => {
    const vfs = withBanks();
    const r = runShell(vfs, "cp /home/we/dust/code/kolor/samples/bank1 /home/we/dust/audio/kolor/");
    expect(r.ok).toBe(true);
    expect(vfs.walk("/home/we/dust/audio")).toEqual([]);
  });

  it("still copies a plain file to a plain name", () => {
    const vfs = withBanks();
    runShell(vfs, "cp /home/we/dust/code/kolor/samples/bank1/kick.wav /home/we/dust/audio/one.wav");
    expect(vfs.readText("/home/we/dust/audio/one.wav")).toBe("a");
  });
});
