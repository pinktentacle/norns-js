// E9-55 — `f:read("*all")` is `f:read("a")`, and was reading one line.
//
// Lua's liolib.c reads ONE character of a read format: `g_read` skips an
// optional `*` and switches on the byte after it. So `"*a"`, `"a"` and the
// Lua 5.1 spelling `"*all"` are the same format and always have been, and
// `"*l"`, `"*line"`, `"*n"`, `"*number"` likewise.
//
// Ours compared the whole string. `"*all"` matched neither `'a'` nor `'n'`
// and fell through to the line branch, so a script asking for a whole file
// got its FIRST LINE. `pirate-radio` read `{` out of its station list and
// cjson said
//
//     Expected value at character 2 of 1
//
// which names neither the file nor the read, and the script never loaded.
// Thirteen uses across seven of the fifty-two scripts installed when this
// was found: amen, mx.samples, oooooo, pirate-radio, pitter-patter, ygg,
// zxcvbn.

import { beforeEach, describe, expect, it } from "vitest";
import { createHost, boot, type Host } from "../src/lua/host.js";
import { loadNornsLua, loadConfig } from "../src/lua/host-node.js";
import { registerFs } from "../src/fs/register.js";
import { Vfs } from "../src/fs/vfs.js";

const JSON_FILE = '{\n  "stations": [\n    { "name": "one" }\n  ]\n}\n';
let host: Host;

const out = (code: string): string => {
  const before = host.output.length;
  const err = host.run(code);
  if (err) return `ERROR: ${err}`;
  return host.output.slice(before).join("").trim();
};

beforeEach(() => {
  const vfs = new Vfs();
  vfs.write("/home/we/dust/code/thing/stations.json", JSON_FILE);
  host = createHost({ sources: loadNornsLua(), vfs });
  registerFs(host.registry, vfs);
  const err = boot(host, loadConfig());
  if (err) throw new Error(`boot failed at ${err.step}: ${err.error}`);
});

const read = (fmt: string): string =>
  out(
    `local f = assert(io.open("/home/we/dust/code/thing/stations.json", "rb"))\n` +
      `local c = f:read(${fmt})\n` +
      `f:close()\n` +
      `print(type(c) == "string" and #c or tostring(c))`,
  );

describe("a read format is one character after an optional star", () => {
  it("reads the whole file for every spelling of 'all'", () => {
    const whole = String(JSON_FILE.length);
    expect(read('"a"')).toBe(whole);
    expect(read('"*a"')).toBe(whole);
    expect(read('"*all"'), "the Lua 5.1 spelling, and the commoner one").toBe(whole);
    expect(read('"all"')).toBe(whole);
  });

  it("still reads one line for every spelling of 'line'", () => {
    // The first line here is `{`, which is exactly what pirate-radio got
    // when it asked for the whole file.
    expect(read('"l"')).toBe("1");
    expect(read('"*l"')).toBe("1");
    expect(read('"*line"')).toBe("1");
    // `L` keeps the newline, and the case has to survive the trim.
    expect(read('"*L"')).toBe("2");
  });

  it("reads a count of bytes when given a number", () => {
    expect(read("7")).toBe("7");
  });

  it("decodes what a script decodes, rather than its first line", () => {
    // The shape of pirate-radio/lib/globals.lua:43 load_json.
    expect(
      out(
        `local f = assert(io.open("/home/we/dust/code/thing/stations.json", "rb"))\n` +
          `local content = f:read("*all")\n` +
          `f:close()\n` +
          `print(require("cjson").decode(content).stations[1].name)`,
      ),
    ).toBe("one");
  });
});
