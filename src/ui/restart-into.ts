// E9-254 — RESTART, AND COME BACK INTO THE SCRIPT THAT ASKED FOR IT.
//
// The store's "restart" on a script that brought an engine is pressed to
// play THAT script. norns already comes back into a script by itself:
// `state.resume` loads `state.script` after a clean shutdown. `_norns.restart`
// empties it first (`norns.script.clear()` runs before `state.save()`), so
// this puts it back right after that clear, and the save, the clean
// shutdown and the resume are all norns' own.
//
// NOT ONLY THE FILE. `Script.load()` with no argument — what resume calls —
// takes the name and the folder from the state too, and `include("lib/x")`
// looks in that folder: with the file alone gridofpoints came back with
// "MISSING INCLUDE: lib/json". So the fields are the ones `Script.load`
// sets (core/script.lua:160-190), computed the same way.

/** The Lua for the page's restart; `open` is the script to resume into. */
export function restartInto(open: string | null): string {
  if (open === null) return "if _norns and _norns.restart then _norns.restart() end";
  // A JSON string is a Lua string: the same quotes and escapes.
  return [
    "if _norns and _norns.restart then",
    `  local open, clear = ${JSON.stringify(open)}, norns.script.clear`,
    "  norns.script.clear = function(...)",
    "    clear(...)",
    '    local path, script = open:match("^(.*)/([^.]*).*$")',
    "    local name = string.sub(path, string.len(_path.code) + 1)",
    '    if string.sub(name, -#script) ~= script then name = name .. "/" .. script end',
    "    local s = norns.state",
    '    s.script, s.name, s.shortname = open, name, name:match("([^/]+)$")',
    '    s.path, s.lib, s.data = path .. "/", path .. "/lib/", _path.data .. name .. "/"',
    "  end",
    "  _norns.restart()",
    "end",
  ].join("\n");
}
