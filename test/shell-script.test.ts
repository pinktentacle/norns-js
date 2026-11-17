// E9-45 — a shell script the repository ships, read and run.
//
// Nine catalogue scripts run one by name. Until now `.sh` was not installed
// at all, so the refusal named a path that did not exist — which is how
// `amenbreak`'s endless "please restart norns" could only be explained by
// fetching its `install.sh` from the CDN by hand.
//
// What is tested here is less "it runs" than "it says WHICH line it could
// not run", because that line is the answer to why a script does not work.

import { describe, expect, it } from "vitest";
import { Vfs } from "../src/fs/vfs.js";
import { runShell } from "../src/fs/shell.js";

const sh = (vfs: Vfs, path: string, body: string): void => void vfs.write(path, body);

describe("running a shell script a repository ships", () => {
  it("runs the lines it knows and reports the output", () => {
    const vfs = new Vfs();
    vfs.write("/home/we/dust/code/x/a.txt", "one\n");
    sh(vfs, "/home/we/dust/code/x/go.sh", [
      "#!/bin/bash",
      "# a comment",
      "",
      "mkdir -p /home/we/dust/data/x",
      "cp /home/we/dust/code/x/a.txt /home/we/dust/data/x/a.txt",
    ].join("\n"));
    const r = runShell(vfs, "/home/we/dust/code/x/go.sh");
    expect(r.ok, r.refused).toBe(true);
    expect(vfs.exists("/home/we/dust/data/x/a.txt")).toBe(true);
  });

  it("stops at the first line it cannot run, and NAMES it", () => {
    // The whole point. `amenbreak` dies on a `wget` of a GitHub release
    // asset, and a user told only "it did not work" has nothing to go on.
    const vfs = new Vfs();
    sh(vfs, "/home/we/dust/code/y/install.sh", [
      "#!/bin/bash",
      "mkdir -p /home/we/dust/data/y",
      "sudo rsync -avrP /tmp/y /home/we/",
      "mkdir -p /home/we/dust/data/y/late",
    ].join("\n"));
    const r = runShell(vfs, "/home/we/dust/code/y/install.sh");
    expect(r.ok).toBe(false);
    expect(r.refused).toContain("install.sh:3");
    expect(r.refused).toContain("sudo");
    // And it stopped: the line after the failure did not run.
    expect(vfs.isDir("/home/we/dust/data/y")).toBe(true);
    expect(vfs.exists("/home/we/dust/data/y/late")).toBe(false);
  });

  it("hands a download up the way a bare wget does", () => {
    const vfs = new Vfs();
    sh(vfs, "/home/we/dust/code/z/get.sh", [
      "cd /home/we/dust/audio",
      "wget -q https://example.com/kit.tar",
    ].join("\n"));
    const r = runShell(vfs, "/home/we/dust/code/z/get.sh");
    expect(r.ok).toBe(false);
    expect(r.fetch?.url).toBe("https://example.com/kit.tar");
  });

  it("says so when the script is not there, instead of naming the verb", () => {
    // The old message was `unsupported shell command: /home/we/…/install.sh`,
    // which reads as "this shell cannot do that" when the truth is "that
    // file was never installed".
    const r = runShell(new Vfs(), "/home/we/dust/code/none/install.sh");
    expect(r.ok).toBe(false);
    expect(r.refused).toMatch(/no such shell script/);
  });

  it("accepts the `bash <path>` spelling", () => {
    const vfs = new Vfs();
    sh(vfs, "/home/we/dust/code/b/run.sh", "mkdir -p /home/we/dust/data/b\n");
    expect(runShell(vfs, "bash /home/we/dust/code/b/run.sh").ok).toBe(true);
    expect(vfs.isDir("/home/we/dust/data/b")).toBe(true);
  });

  it("does not follow a script that runs itself", () => {
    // Nothing else here would stop it, and a stack overflow in the shell
    // takes the page with it.
    const vfs = new Vfs();
    sh(vfs, "/home/we/dust/code/loop/a.sh", "/home/we/dust/code/loop/a.sh\n");
    const r = runShell(vfs, "/home/we/dust/code/loop/a.sh");
    expect(r.ok).toBe(false);
  });
});
