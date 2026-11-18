// Patches applied to norns' own Lua, at load time, to a COPY.
//
// Same principle as the staged C++ headers in `src/crone/build.sh`:
// `third_party/` is never modified, the patch is applied to the source on its
// way into the interpreter, and a missing anchor FAILS LOUDLY rather than
// silently producing an unpatched file. A patch that quietly stops applying
// is worse than no patch, because the bug comes back wearing a fix.
//
// The bar for being in here is high. A patch is justified when upstream's
// code crashes or hangs in a way that is NOT a behaviour anyone chose, and
// when the browser makes it reachable where hardware does not. Anything that
// is merely different — a path, a device, a timing — belongs in a shim or a
// stub, not here. Each entry carries the upstream line and what makes it
// reachable here.

export interface LuaPatch {
  /** The module, as `require` names it. */
  readonly module: string;
  /** Exact text to find. Must appear exactly once. */
  readonly find: string;
  readonly replace: string;
  /** Why, in one line, for the log and for whoever reads this next. */
  readonly why: string;
}

export const LUA_PATCHES: readonly LuaPatch[] = [
  {
    module: "core/menu/select",
    // select.lua:79
    find: "    if m.list[m.pos+1].file == nil then return end",
    replace:
      "    -- norns-js: the entry itself can be nil, not just its `file`.\n" +
      "    if m.list[m.pos+1] == nil then return end\n" +
      "    if m.list[m.pos+1].file == nil then return end",
    why:
      "pressing K3 in SELECT before the script scan returns indexes an empty " +
      "list. `m.init` sets `m.list = {}` and `m.len = \"scan\"`, then fires an " +
      "ASYNCHRONOUS `norns.system_cmd` to find the scripts; until its callback " +
      "runs, `m.list[m.pos+1]` is nil and `.file` on it throws " +
      "\"attempt to index a nil value (field '?')\". On hardware the `find` " +
      "returns in a few milliseconds and it is hard to hit; here the command " +
      "runs over the VFS and its callback is a task, so a second key press " +
      "beats it easily. Upstream already tracks the state — `m.len` is the " +
      "string \"scan\" while it waits — the key handler just does not consult it",
  },
  {
    module: "core/state",
    // state.lua:107-109
    // ONE LINE, no newline in it: the vendored tree is checked out with
    // CRLF on this machine, so a multi-line anchor would depend on how
    // git felt about line endings the day it was cloned.
    find: '  io.output(fd)',
    replace:
      '  io.output(fd)' + '\n' +
      '  -- norns-js: write numbers this file can be read back as.' + '\n' +
      '  local _io = io' + '\n' +
      '  local io = setmetatable({' + '\n' +
      '    write = function(...)' + '\n' +
      '      local out = {}' + '\n' +
      "      for i = 1, select('#', ...) do" + '\n' +
      '        local s = tostring((select(i, ...)))' + '\n' +
      '        -- E9-117: two spellings, because two interpreters. fengari' + '\n' +
      '        -- wrote Infinity; PUC Lua writes inf, which is what hardware' + '\n' +
      '        -- writes too. Neither one is a Lua literal.' + '\n' +
      '        s = s:gsub("= %-Infinity", "= -math.huge")' + '\n' +
      '        s = s:gsub("= Infinity", "= math.huge")' + '\n' +
      '        s = s:gsub("= %-inf", "= -math.huge")' + '\n' +
      '        s = s:gsub("= inf", "= math.huge")' + '\n' +
      '        s = s:gsub("= NaN", "= 0/0")' + '\n' +
      '        s = s:gsub("= %-?nan", "= 0/0")' + '\n' +
      '        out[i] = s' + '\n' +
      '      end' + '\n' +
      '      return _io.write(table.unpack(out))' + '\n' +
      '    end,' + '\n' +
      '  }, { __index = _io })',
    why:
      "the state file did not round-trip. `norns.state.mix.rev_monitor_input` " +
      "and two others default to `-math.huge` (state.lua:27-28, 46), and " +
      "concatenating that into the file writes a token Lua cannot read back: " +
      "`-inf` on hardware, `-Infinity` here, and neither is a Lua literal. " +
      "`state.resume` then dies on line 21 of its own output with " +
      "\"attempt to perform arithmetic on a nil value (global 'Infinity')\" " +
      "and every setting is lost on every boot — the vport bindings, the " +
      "mixer, the clock source. Upstream has the same hole with `inf`; this " +
      "shadows `io` inside save_state with one that rewrites a whole value " +
      "after `= `, so it covers the lines upstream adds later too",
  },
  {
    module: "core/paramset",
    // paramset.lua:514 — one line, see the note on the state patch.
    find: 'io.write(string.format("%s: %s' + '\\n' + '", quote(param.id), param:get()))',
    replace:
      'local _v = param:get()' + '\n' +
      '        if _v == math.huge then _v = "inf"' + '\n' +
      '        elseif _v == -math.huge then _v = "-inf" end' + '\n' +
      '        io.write(string.format("%s: %s' + '\\n' + '", quote(param.id), _v))',
    why:
      "a PSET holding an infinite level could not be read back. ParamSet:read " +
      "ALREADY handles it -- it tests for the strings \"inf\" and \"-inf\" and " +
      "turns them into math.huge -- so upstream's writer and reader agree, " +
      "because Lua spells an infinity that way. Fengari spells it the way JS " +
      "does, \"-Infinity\", which matches neither branch and falls through to " +
      "the one that sets the param to the STRING. The next controlspec.unmap " +
      "then does math.max on it: \"attempt to compare string with number\", " +
      "out of params:read, before the script's init has finished. Invisible " +
      "until E6-01 made PSETs survive a reload. Writing inf and -inf also " +
      "means a PSET written here can be read by a real norns",
  },
];

/**
 * Apply every patch to a module map, in place, and report what was done.
 *
 * Throws if an anchor is missing or ambiguous. That is the point: these are
 * pinned to exact upstream lines, and upstream moves.
 */
export function applyLuaPatches(sources: Map<string, string>): string[] {
  const applied: string[] = [];
  for (const patch of LUA_PATCHES) {
    const src = sources.get(patch.module);
    if (src === undefined) {
      throw new Error(`lua patch: ${patch.module} is not in the source map`);
    }
    const first = src.indexOf(patch.find);
    if (first < 0) {
      throw new Error(
        `lua patch: the anchor in ${patch.module} is gone — upstream changed it. Re-read the file and update src/lua/patches.ts. Anchor: ${JSON.stringify(patch.find)}`,
      );
    }
    if (src.indexOf(patch.find, first + 1) >= 0) {
      throw new Error(`lua patch: the anchor in ${patch.module} appears more than once; make it unique`);
    }
    sources.set(patch.module, src.replace(patch.find, patch.replace));
    applied.push(patch.module);
  }
  return applied;
}
