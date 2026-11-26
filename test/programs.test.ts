// E9-267 — sendosc, oscnotify, audiowaveform and the pkill / ps | kill that
// manage them, through the shell the way scripts call them. Every command
// line here is a real call site:
//
//   sampswap/lib/sampswap.lua:489   SENDOSC.." --host 127.0.0.1 --addr \"/score\" --port 47113 --recv-port 47888 -s …"
//   amenbreak.lua:140               os.execute(_path.code.."amenbreak/lib/oscnotify/run.sh &")
//   amenbreak.lua:683               os.execute("pkill -f oscnotify")
//   zxcvbn/lib/oscnotify/run.sh     two watchers, one with -addr "/oscpage"
//   amenbreak/lib/sample.lua:126    "%s -q -i '%s' -o '%s' -z %d -b 8 &"
//   amenbreak/lib/sample.lua:518    "%s -q -i '%s' -o '%s' -s … -e … -w … -h … --background-color 000000 …"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Vfs } from "../src/fs/vfs.js";
import { runShell } from "../src/fs/shell.js";
import { runningPrograms, setProgramHost, stopAllPrograms, type ProgramHost } from "../src/fs/programs.js";
import { encodeWav } from "../src/crone/wav.js";
import { decodeDat } from "../src/fs/audiowaveform.js";
import { decodePngSync } from "../src/screen/png-sync.js";

const sent: Array<{ host: string; port: number; path: string; args: Array<number | string> }> = [];
const logs: string[] = [];
const fakeHost = (extra: Partial<ProgramHost> = {}): ProgramHost => ({
  oscSend: (host, port, path, args) => {
    sent.push({ host, port, path, args: [...args] });
    return port === 10111 || port === 57120 ? "here" : false;
  },
  log: (l) => logs.push(l),
  ...extra,
});

beforeEach(() => {
  sent.length = 0;
  logs.length = 0;
  setProgramHost(fakeHost());
});
afterEach(() => {
  stopAllPrograms();
  setProgramHost(null);
  vi.useRealTimers();
});

describe("sendosc", () => {
  it("sends its ints, then floats, then strings, whatever the order on the line", () => {
    const r = runShell(new Vfs(), `sendosc --host 127.0.0.1 --addr "/score" --port 57120 -s a.wav -i 3 -s b.wav -f 0.5`);
    expect(r.ok, r.refused).toBe(true);
    expect(sent).toEqual([{ host: "127.0.0.1", port: 57120, path: "/score", args: [3, 0.5, "a.wav", "b.wav"] }]);
  });

  it("defaults to localhost:57120 /osc/address, from any path", () => {
    expect(runShell(new Vfs(), "/home/we/dust/data/sampswap/sendosc -i 1").ok).toBe(true);
    expect(sent[0]).toEqual({ host: "localhost", port: 57120, path: "/osc/address", args: [1] });
  });

  it("sends, then refuses to pretend --recv-port was answered", () => {
    const r = runShell(new Vfs(), `sendosc --host 127.0.0.1 --addr "/score" --port 47113 --recv-port 47888 -s x -s 47888`);
    expect(sent).toHaveLength(1);
    expect(r.ok).toBe(false);
    expect(r.refused).toMatch(/waits for a \/quit/);
  });

  it("sends nothing when an int is not one, and still exits 0, as strconv.Atoi does", () => {
    expect(runShell(new Vfs(), "sendosc -i 3.5").ok).toBe(true);
    expect(sent).toHaveLength(0);
    expect(logs.join()).toMatch(/strconv\.Atoi/);
  });
});

const AMEN_RUN = `#!/bin/bash
ps -ef | grep 'oscnotify' | grep -v grep | grep -v run | awk '{print $2}' | xargs -r kill -9
cd "$(dirname "$0")"
nohup ./oscnotify -path /home/we/dust/code/amenbreak/ >/dev/null 2>&1 &
`;
const ZX_RUN = `#!/bin/bash
ps -ef | grep 'oscnotify' | grep -v grep | grep -v run | awk '{print $2}' | xargs -r kill -9
cd "$(dirname "$0")"
nohup ./oscnotify -path /home/we/dust/code/zxcvbn/ >/dev/null 2>&1 &
nohup ./oscnotify -path /home/we/dust/data/zxcvbn/pages/ -addr "/oscpage" >/dev/null 2>&1 &
`;

describe("oscnotify", () => {
  it("starts from amenbreak's run.sh, and says which file was written, 500 ms after the last write", () => {
    vi.useFakeTimers();
    const vfs = new Vfs();
    vfs.write("/home/we/dust/code/amenbreak/lib/oscnotify/run.sh", AMEN_RUN);
    const r = runShell(vfs, "/home/we/dust/code/amenbreak/lib/oscnotify/run.sh &");
    expect(r.ok, r.refused).toBe(true);
    expect(runningPrograms()).toHaveLength(1);
    vfs.write("/home/we/dust/code/amenbreak/lib/a.lua", "x");
    vi.advanceTimersByTime(300);
    vfs.write("/home/we/dust/code/amenbreak/amenbreak.lua", "y");
    vi.advanceTimersByTime(499);
    expect(sent).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual([{ host: "localhost", port: 10111, path: "/oscnotify", args: ["/home/we/dust/code/amenbreak/amenbreak.lua"] }]);
  });

  it("leaves alone what is not a write, outside the path, or in a .git folder", () => {
    vi.useFakeTimers();
    const vfs = new Vfs();
    vfs.write("/home/we/dust/code/amenbreak/lib/oscnotify/run.sh", AMEN_RUN);
    vfs.write("/home/we/dust/code/amenbreak/old.lua", "x");
    runShell(vfs, "/home/we/dust/code/amenbreak/lib/oscnotify/run.sh &");
    vfs.write("/home/we/dust/code/other/x.lua", "x");
    vfs.write("/home/we/dust/code/amenbreak/.git/HEAD", "x");
    vfs.remove("/home/we/dust/code/amenbreak/old.lua");
    vi.advanceTimersByTime(1000);
    expect(sent).toHaveLength(0);
  });

  it("is one process however often the script starts it, and pkill -f stops it", () => {
    const vfs = new Vfs();
    vfs.write("/home/we/dust/code/amenbreak/lib/oscnotify/run.sh", AMEN_RUN);
    runShell(vfs, "/home/we/dust/code/amenbreak/lib/oscnotify/run.sh &");
    runShell(vfs, "/home/we/dust/code/amenbreak/lib/oscnotify/run.sh &");
    expect(runningPrograms()).toHaveLength(1);
    expect(runShell(vfs, "pkill -f oscnotify").ok).toBe(true);
    expect(runningPrograms()).toHaveLength(0);
    // Nothing left to match: exit 1, not a refusal.
    const again = runShell(vfs, "pkill -f oscnotify");
    expect([again.ok, again.failed, again.refused]).toEqual([false, true, undefined]);
  });

  it("runs zxcvbn's two watchers, one on its own address", () => {
    vi.useFakeTimers();
    const vfs = new Vfs();
    vfs.write("/home/we/dust/code/zxcvbn/lib/oscnotify/run.sh", ZX_RUN);
    expect(runShell(vfs, "/home/we/dust/code/zxcvbn/lib/oscnotify/run.sh &").ok).toBe(true);
    expect(runningPrograms()).toHaveLength(2);
    vfs.write("/home/we/dust/data/zxcvbn/pages/1", "page");
    vi.advanceTimersByTime(500);
    expect(sent).toEqual([{ host: "localhost", port: 10111, path: "/oscpage", args: ["/home/we/dust/data/zxcvbn/pages/1"] }]);
  });

  it("stops watching once killed", () => {
    vi.useFakeTimers();
    const vfs = new Vfs();
    runShell(vfs, "oscnotify -path /home/we/dust/code/x/ &");
    runShell(vfs, "pkill -f oscnotify");
    vfs.write("/home/we/dust/code/x/a.lua", "a");
    vi.advanceTimersByTime(1000);
    expect(sent).toHaveLength(0);
  });
});

describe("audiowaveform, as amenbreak calls it", () => {
  const AUDIO = "/home/we/dust/audio/amenbreak/a.wav";
  const DAT = "/home/we/dust/data/amenbreak/dats/a.wav.dat";
  const PNG = "/home/we/dust/data/amenbreak/pngs/a.wav_0.000_0.010_16_8.png";
  const wav = (): Uint8Array => {
    const n = 480;
    const samples = new Float32Array(n);
    for (let i = 0; i < n; i++) samples[i] = Math.sin((2 * Math.PI * 440 * i) / 48000) * 0.8;
    return encodeWav({ channels: 1, sampleRate: 48000, samples, bits: 16 });
  };

  it("answers --help with the word the scripts look for", () => {
    const r = runShell(new Vfs(), "audiowaveform --help");
    expect(r.ok).toBe(true);
    expect(r.out).toContain("Options");
  });

  it("makes the .dat and then the picture of a view", () => {
    const vfs = new Vfs();
    vfs.write(AUDIO, wav());
    expect(runShell(vfs, `audiowaveform -q -i '${AUDIO}' -o '${DAT}' -z 2 -b 8 &`).ok).toBe(true);
    const dat = decodeDat(vfs.read(DAT)!);
    expect([dat.sampleRate, dat.samplesPerPixel, dat.data.length / 2]).toEqual([48000, 2, 240]);
    const r = runShell(
      vfs,
      `audiowaveform -q -i '${DAT}' -o '${PNG}' -s 0.0000 -e 0.0100 -w 16 -h  8 --background-color 000000 --waveform-color 757575 --no-axis-labels --compression 9 &`,
    );
    expect(r.ok, r.refused).toBe(true);
    const img = decodePngSync(vfs.read(PNG)!)!;
    expect([img.width, img.height]).toEqual([16, 8]);
    // 0.8 of full scale reaches row 0 or 1 at some column.
    let lit = 0;
    for (let i = 0; i < img.rgba.length; i += 4) if (img.rgba[i] === 0x75) lit++;
    expect(lit).toBeGreaterThan(16);
  });

  it("is quiet about an input that does not exist yet, in the background only", () => {
    const vfs = new Vfs();
    expect(runShell(vfs, `audiowaveform -q -i '/nope.dat' -o '/x.png' -s 0 -e 1 -w 8 -h 8 --no-axis-labels &`).ok).toBe(true);
    const fg = runShell(vfs, `audiowaveform -q -i '/nope.dat' -o '/x.png' -s 0 -e 1 -w 8 -h 8 --no-axis-labels`);
    expect([fg.ok, fg.failed]).toEqual([false, true]);
  });

  it("hands a FLAC to the page's decoder and writes the .dat when it is done", async () => {
    const decodeAudio = vi.fn(async () => ({ sampleRate: 44100, channels: [Float32Array.from([0.5, -0.5, 0.25, -0.25])] }));
    setProgramHost(fakeHost({ decodeAudio }));
    const vfs = new Vfs();
    const flac = new Uint8Array(64);
    flac.set([0x66, 0x4c, 0x61, 0x43], 0); // "fLaC" — the decoder is faked, only the name matters
    vfs.write("/a.flac", flac);
    expect(runShell(vfs, "audiowaveform -q -i '/a.flac' -o '/a.dat' -z 2 -b 8 &").ok).toBe(true);
    await vi.waitFor(() => expect(vfs.exists("/a.dat")).toBe(true));
    const dat = decodeDat(vfs.read("/a.dat")!);
    expect([dat.sampleRate, dat.samplesPerPixel]).toEqual([44100, 2]);
    expect(Array.from(dat.data)).toEqual([-16384, 16384, -8192, 8192].map((v) => Math.trunc(v / 256) * 256));
  });
});
