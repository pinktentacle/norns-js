// E9-64 — the integers are 64-bit, as norns' are.
//
// They were 32-bit until this epic, and that was not a detail:
// `1000000 * 1000000` came back as -727379968 with nothing in the log to
// say so, and `fibonacci` built an eighteen-digit number in a `repeat`
// loop whose condition could therefore never be true — forty-one seconds
// of a frozen page and then `RangeError: Map maximum size exceeded`.
//
// That was fengari, and the fix was `patches/fengari.patch`: BigInt
// integers inside the VM, JS numbers across the C API.
// `spike/lua64/README.md` has the measurements and the five things that
// bit on the way. Since E9-117 the interpreter is PUC Lua 5.3, whose
// integers are 64-bit because they are a C `long long`, and the tree and
// the patch are both gone (E9-118). THE FILE DID NOT CHANGE, which is the
// point of it: it is a contract, not a regression test for one runtime.
// Four of these caught a real bug in the port — `luaL_tolstring` popping
// the value it is required to leave on the stack, so `print(nil)` came out
// empty and `print(1, true)` lost its second argument.
//
// This file is the contract. Every expectation below is what Lua 5.3 on a
// norns answers, checked against the manual rather than against the
// previous behaviour.

import { beforeAll, describe, expect, it } from "vitest";
import { createHost, boot, type Host } from "../src/lua/host.js";
import { loadNornsLua, loadConfig } from "../src/lua/host-node.js";
import { registerFs } from "../src/fs/register.js";
import { Vfs } from "../src/fs/vfs.js";

let host: Host;

const out = (code: string): string => {
  const before = host.output.length;
  const err = host.run(code);
  if (err) return `ERROR: ${err}`;
  return host.output.slice(before).join("").trim();
};

beforeAll(() => {
  const vfs = new Vfs();
  host = createHost({ sources: loadNornsLua(), vfs });
  registerFs(host.registry, vfs);
  const err = boot(host, loadConfig());
  if (err) throw new Error(`boot failed at ${err.step}: ${err.error}`);
});

describe("how wide an integer is", () => {
  it("is 64 bits, which is what norns has", () => {
    expect(out("print(math.maxinteger)")).toBe("9223372036854775807");
    expect(out("print(math.mininteger)")).toBe("-9223372036854775808");
  });

  it("no longer wraps where a 32-bit one did", () => {
    expect(out("print(2147483647 + 1)")).toBe("2147483648");
    expect(out("print(1000000 * 1000000)")).toBe("1000000000000");
    expect(out("print(math.type(1000000 * 1000000))")).toBe("integer");
    // A literal past 2^31 is an INTEGER now, so %d prints it instead of
    // raising "number has no integer representation".
    expect(out("print(math.type(3000000000))")).toBe("integer");
    expect(out(`print(string.format("%d", 3000000000))`)).toBe("3000000000");
  });

  it("wraps at 64, because Lua's integers do", () => {
    // Documented behaviour, not an accident: §3.4.2 of the manual.
    expect(out("print(math.maxinteger + 1 == math.mininteger)")).toBe("true");
    expect(out("print(math.mininteger - 1 == math.maxinteger)")).toBe("true");
    expect(out("print(math.abs(math.mininteger) == math.mininteger)")).toBe("true");
  });

  it("shifts and masks over 64 bits", () => {
    expect(out("print(1 << 40)")).toBe("1099511627776");
    expect(out("print(1 << 64)"), "a shift of the width or more is zero").toBe("0");
    // Hex numerals wrap rather than becoming floats, which is what makes
    // 0xFFFFFFFF four billion and not minus one.
    expect(out("print(0xFFFFFFFF)")).toBe("4294967295");
    expect(out("print(0xFFFFFFFFFFFFFFFF)")).toBe("-1");
  });

  it("keeps float and integer the same key and the same value", () => {
    expect(out("print(1 == 1.0, math.type(1), math.type(1.0))")).toBe("true\tinteger\tfloat");
    expect(out(`local t = {} t[1] = "a" print(t[1.0])`)).toBe("a");
  });

  it("divides and takes remainders the way Lua does, not the way JS does", () => {
    // Floor division and a remainder with the sign of the DIVISOR.
    expect(out("print(7 // 2, -7 // 2)")).toBe("3\t-4");
    expect(out("print(7 % 3, -7 % 3)")).toBe("1\t2");
    expect(out(`print(pcall(function() return 1 // 0 end))`)).toContain("attempt to divide by zero");
  });

  it("is exact past 2^53, which a double is not", () => {
    expect(out("print(9007199254740993 + 0)")).toBe("9007199254740993");
    expect(out(`print(string.format("%d", math.maxinteger))`)).toBe("9223372036854775807");
  });
});

describe("fibonacci, the script that could not run", () => {
  it("reaches eighteen digits, with the number norns reaches", () => {
    // fibonacci/lib — build_numbers() verbatim in shape, bounded so a
    // regression is a failure rather than a hang.
    const said = out(`
      local numbers = {0, 1, 1}
      local steps = 0
      repeat
        local n = numbers[#numbers - 1] + numbers[#numbers]
        numbers[#numbers + 1] = n
        steps = steps + 1
      until string.len(n) >= 18 or steps > 300
      print((steps > 300) and "NEVER" or (#numbers .. " " .. numbers[#numbers]))
    `);
    expect(said).toBe("85 160500643816367088");
  });
});

describe("the C API still speaks JS numbers", () => {
  it("hands a Lua integer back as a number, so nothing above has to change", () => {
    // The split this rests on: BigInt inside the VM, Number at the
    // boundary. 174 `_norns` functions take coordinates and levels from
    // here and do arithmetic with them; a BigInt would throw on the first
    // `+` against a float.
    const before = host.output.length;
    host.run("_test_number = 42");
    host.output.length = before;
    expect(typeof host.run("print(math.type(42))")).toBe("object");
    expect(out("print(#'hello', ('abc'):byte(1))")).toBe("5\t97");
    expect(out("print(table.concat({1,2,3}, ','))"), "luaL_len is a count").toBe("1,2,3");
    expect(out("print(select('#', 1, 2, 3))")).toBe("3");
  });
});
