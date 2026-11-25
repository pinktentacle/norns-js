// E9-228 — `tar`, a shell script that downloads twice, and `test -n "$(…)"`.

import { describe, expect, it } from "vitest";
import { runShell } from "../src/fs/shell.js";
import { Vfs } from "../src/fs/vfs.js";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("tar", () => {
  it("hands up an extraction like unzip: the archive, and where it goes", () => {
    expect(runShell(new Vfs(), "tar -xvf /home/we/dust/audio/amenbreak.tar -C /home/we/dust/audio").fetch).toEqual({
      kind: "unzip",
      url: "/home/we/dust/audio/amenbreak.tar",
      dest: "/home/we/dust/audio",
    });
    expect(runShell(new Vfs(), "cd ~/dust/data && tar -xvzf amenbreak_data.tar.gz").fetch).toEqual({
      kind: "unzip",
      url: "/home/we/dust/data/amenbreak_data.tar.gz",
      dest: "/home/we/dust/data",
    });
    expect(runShell(new Vfs(), "cd /tmp && tar xzf a.tgz").fetch).toMatchObject({ url: "/tmp/a.tgz", dest: "/tmp" });
  });

  it("does not take making or listing an archive for opening one", () => {
    for (const line of ["cd /tmp && tar -czf out.tgz dir", "cd /tmp && tar -tzf a.tgz", "tar -xvf a.tar"]) {
      expect(runShell(new Vfs(), line).fetch, line).toBeUndefined();
    }
  });

  it("lorenzos-drums' one line: one download, unpacked where it lands", () => {
    const line =
      "cd ~/dust/audio && wget -q https://github.com/schollz/lorenzos-drums/releases/download/samples/lorenzos-drums.tar.gz && tar -xzvf lorenzos-drums.tar.gz && rm lorenzos-drums.tar.gz";
    expect(runShell(new Vfs(), line).fetch).toEqual({
      kind: "file",
      url: "https://github.com/schollz/lorenzos-drums/releases/download/samples/lorenzos-drums.tar.gz",
      dest: "/home/we/dust/audio/lorenzos-drums.tar.gz",
      unzipTo: "/home/we/dust/audio",
    });
  });
});

describe("a shell script that downloads", () => {
  const AMENBREAK = [
    "#!/bin/bash",
    "",
    "cd /home/we/dust/audio",
    'echo "downloading amens"',
    "wget -q https://github.com/schollz/amenbreak/releases/download/audio2/amenbreak.tar",
    'echo "unzipping amens"',
    "tar -xvf amenbreak.tar",
    "rm amenbreak.tar",
    "cd /home/we/dust/data",
    'echo "downloading image data"',
    "wget -q https://github.com/schollz/amenbreak/releases/download/audio2/amenbreak_data.tar.gz",
    'echo "unzipping image data"',
    "tar -xvzf amenbreak_data.tar.gz",
    "rm amenbreak_data.tar.gz",
  ].join("\n");

  it("goes on past a download, and hands up every one, each unpacked where the script said", () => {
    const vfs = new Vfs();
    vfs.write("/home/we/dust/code/amenbreak/lib/install.sh", enc(AMENBREAK));
    const r = runShell(vfs, "/home/we/dust/code/amenbreak/lib/install.sh");
    expect(r.ok, "not done yet: the files are not here").toBe(false);
    expect([r.fetch, ...(r.more ?? [])]).toEqual([
      {
        kind: "file",
        url: "https://github.com/schollz/amenbreak/releases/download/audio2/amenbreak.tar",
        dest: "/home/we/dust/audio/amenbreak.tar",
        unzipTo: "/home/we/dust/audio",
      },
      {
        kind: "file",
        url: "https://github.com/schollz/amenbreak/releases/download/audio2/amenbreak_data.tar.gz",
        dest: "/home/we/dust/data/amenbreak_data.tar.gz",
        unzipTo: "/home/we/dust/data",
      },
    ]);
  });

  it("still stops at a line it cannot do, and says which", () => {
    const vfs = new Vfs();
    vfs.write("/home/we/x.sh", enc("cd /tmp\nwget -q https://example.org/a.zip\nsudo make install\n"));
    const r = runShell(vfs, "/home/we/x.sh");
    expect(r.ok).toBe(false);
    expect(r.refused).toMatch(/x\.sh:3: .*sudo/);
    expect(r.fetch, "what was asked before the stop is still fetched").toMatchObject({ url: "https://example.org/a.zip" });
  });
});

describe("test", () => {
  const EXT = "/home/we/.local/share/SuperCollider/Extensions";
  const AMEN = `test -n "$(find ${EXT}/ -name ignore -prune -o -name AnalogTape_scsynth.so -print)"`;

  it("amenbreak's question: is AnalogTape here — yes when it is declared, no when not", () => {
    const vfs = new Vfs();
    expect(runShell(vfs, AMEN)).toMatchObject({ ok: false });
    expect(runShell(vfs, AMEN).refused ?? "").not.toMatch(/unsupported/);
    vfs.write(`${EXT}/PortedPlugins/AnalogTape_scsynth.so`, enc("compiled in"));
    expect(runShell(vfs, AMEN)).toMatchObject({ ok: true });
  });

  it("-z, -e, -f and -d", () => {
    const vfs = new Vfs();
    vfs.write("/home/we/dust/audio/a.wav", enc("x"));
    expect(runShell(vfs, "test -e /home/we/dust/audio/a.wav").ok).toBe(true);
    expect(runShell(vfs, "test -f /home/we/dust/audio/a.wav").ok).toBe(true);
    expect(runShell(vfs, "test -d /home/we/dust/audio").ok).toBe(true);
    expect(runShell(vfs, "test -d /home/we/dust/audio/a.wav").ok).toBe(false);
    expect(runShell(vfs, "test -e /home/we/dust/nope").ok).toBe(false);
    expect(runShell(vfs, `test -z "$(ls /home/we/dust/empty)"`).ok).toBe(true);
  });
});
