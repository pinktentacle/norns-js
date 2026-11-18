// Two modules norns' Lua environment has and a stock 5.3 does not.
//
// Neither is a feature invented here. `bit32` is part of the
// `LUA_COMPAT_5_2` layer norns' interpreter is built with — the same layer
// that supplies `math.pow`, already in `host.ts` for the same reason — and
// `cjson` is a C module installed in the norns image. A script that reaches
// either one is using its platform correctly, and the failure without them
// is `module 'bit32' not found` in the main chunk, before anything runs.
//
// Measured need across the 35 bundled scripts: `n.kria` requires `bit32`,
// `zxcvbn` requires `cjson` (and ships a `cjson.so` it builds on the norns
// itself, which a browser can do nothing with).

/**
 * `bit32`, over Lua 5.3's own operators.
 *
 * The subtlety is that `bit32` is **unsigned 32-bit** while Lua 5.3's
 * integers are signed 64-bit, so every result is masked back into range —
 * and the shifts have to saturate rather than wrap: `bit32.lshift(x, 32)` is
 * 0, where Lua's own `<<` only reaches 0 at 64.
 */
export const BIT32_LUA = `
local M = {}
local MASK = 0xFFFFFFFF

-- E9-64 — THIS GOT SIMPLER WHEN THE INTEGERS GOT WIDER.
--
-- 'bit32' is unsigned 32-bit; Lua 5.3's integers are signed 64-bit. That is
-- the whole of it, and on a 64-bit interpreter the masking says so directly:
-- every value in [0, 2^32) fits an integer with room to spare, so nothing
-- has to be folded into signed range first and nothing comes back as a
-- float. The previous version did both, because fengari's integers were
-- 32-bit and 'x & MASK' on anything at or above 2^31 raised "number has no
-- integer representation".
--
-- What it means for a caller: 'bit32.bnot(0)' is the INTEGER 4294967295
-- here now, where it used to be the float 4294967295.0. Both compare and
-- arithmetic equal; only tostring differed, and it differed from norns.
local function trim(x)
  return math.tointeger(math.floor(x) % 0x100000000) & MASK
end

-- The result range the bit32 manual specifies: [0, 2^32).
local function unsigned(r)
  return r & MASK
end

local function fold(init, op, ...)
  local r = init
  for i = 1, select('#', ...) do r = op(r, trim((select(i, ...)))) end
  return unsigned(r)
end

function M.band(...) return fold(MASK, function(a, b) return a & b end, ...) end
function M.bor(...) return fold(0, function(a, b) return a | b end, ...) end
function M.bxor(...) return fold(0, function(a, b) return a ~ b end, ...) end
function M.bnot(x) return unsigned(~trim(x)) end
function M.btest(...) return M.band(...) ~= 0 end

-- The shifts SATURATE rather than wrap: bit32.lshift(x, 32) is 0, where
-- Lua's own '<<' by 32 on a 64-bit integer would keep the bits.
function M.lshift(x, n)
  n = math.floor(n)
  if n <= -32 or n >= 32 then return 0 end
  if n < 0 then return unsigned(trim(x) >> -n) end
  return unsigned(trim(x) << n)
end

function M.rshift(x, n)
  n = math.floor(n)
  if n <= -32 or n >= 32 then return 0 end
  if n < 0 then return unsigned(trim(x) << -n) end
  -- trim() already produced a non-negative 32-bit value, so Lua's logical
  -- '>>' over 64 bits is exactly the 32-bit logical shift bit32 wants.
  return unsigned(trim(x) >> n)
end

function M.arshift(x, n)
  n = math.floor(n)
  local v = trim(x)
  local negative = v & 0x80000000 ~= 0
  if n < 0 then return M.lshift(v, -n) end
  if n >= 32 then return negative and MASK or 0 end
  if n == 0 then return unsigned(v) end
  return unsigned((v >> n) | (negative and (MASK << (32 - n)) or 0))
end

local function field(f, w)
  w = w or 1
  assert(f >= 0, 'field cannot be negative')
  assert(w > 0, 'width must be positive')
  assert(f + w <= 32, 'trying to access non-existent bits')
  return f, w
end

function M.extract(x, f, w)
  f, w = field(f, w)
  return M.band(M.rshift(x, f), M.rshift(MASK, 32 - w))
end

function M.replace(x, v, f, w)
  f, w = field(f, w)
  local m = M.rshift(MASK, 32 - w)
  return unsigned((trim(x) & ~(m << f)) | ((trim(v) & m) << f))
end

function M.lrotate(x, n)
  n = math.floor(n) % 32
  local v = trim(x)
  if n == 0 then return unsigned(v) end
  return unsigned((v << n) | trim(M.rshift(v, 32 - n)))
end

function M.rrotate(x, n) return M.lrotate(x, (-math.floor(n)) % 32) end

return M
`;

/**
 * `cjson`, in Lua.
 *
 * In JS it would be shorter — `JSON.parse` exists — but the interesting part
 * of a JSON codec for Lua is not the parsing, it is the data model: which
 * tables are arrays, what happens to nil, how null comes back. Keeping that
 * on the Lua side keeps it visible and testable, and the decisions here are
 * cjson's own:
 *
 *   * a table with no keys encodes as `{}`, an object, as cjson does;
 *   * a table whose keys are exactly 1..n encodes as an array, and a sparse
 *     one is refused rather than filled in with nulls;
 *   * JSON null decodes to `cjson.null`, a sentinel, because decoding it to
 *     nil would silently delete the key it arrived under.
 */
export const CJSON_LUA = `
local M = {}
M.null = setmetatable({}, { __tostring = function() return 'null' end })

local CH = string.char
local BACKSLASH = CH(92)

-- ---- encode ----------------------------------------------------------

local ESC = {
  ['"'] = BACKSLASH .. '"',
  [BACKSLASH] = BACKSLASH .. BACKSLASH,
  [CH(8)] = BACKSLASH .. 'b',
  [CH(12)] = BACKSLASH .. 'f',
  [CH(10)] = BACKSLASH .. 'n',
  [CH(13)] = BACKSLASH .. 'r',
  [CH(9)] = BACKSLASH .. 't',
}

local function esc(c)
  return ESC[c] or string.format(BACKSLASH .. 'u%04x', string.byte(c))
end

local function quote(s)
  return '"' .. s:gsub('[%c"' .. BACKSLASH .. ']', esc) .. '"'
end

--- Is this table a 1..n sequence? Returns the answer and n.
local function is_array(t)
  local n, count = 0, 0
  for k in pairs(t) do
    if type(k) ~= 'number' or k < 1 or math.floor(k) ~= k then return false, 0 end
    if k > n then n = k end
    count = count + 1
  end
  return count == n, n
end

local encode_value

local function encode_table(t, depth)
  if depth > 200 then error('cannot serialise: excessive nesting', 0) end
  if t == M.null then return 'null' end
  local arr, n = is_array(t)
  local out = {}
  if arr and n > 0 then
    for i = 1, n do out[i] = encode_value(t[i], depth + 1) end
    return '[' .. table.concat(out, ',') .. ']'
  end
  for k, v in pairs(t) do
    local key = type(k) == 'string' and k or tostring(k)
    out[#out + 1] = quote(key) .. ':' .. encode_value(v, depth + 1)
  end
  return '{' .. table.concat(out, ',') .. '}'
end

encode_value = function(v, depth)
  local tv = type(v)
  if v == nil then return 'null' end
  if tv == 'boolean' then return tostring(v) end
  if tv == 'number' then
    if v ~= v or v == math.huge or v == -math.huge then
      error('cannot serialise number: must not be NaN or Infinity', 0)
    end
    if math.type(v) == 'integer' then return string.format('%d', v) end
    return string.format('%.14g', v)
  end
  if tv == 'string' then return quote(v) end
  if tv == 'table' then return encode_table(v, depth) end
  error('cannot serialise ' .. tv, 0)
end

function M.encode(v) return encode_value(v, 0) end

-- ---- decode ----------------------------------------------------------

local function decode_error(s, i, msg)
  error('Expected ' .. msg .. ' at character ' .. i .. ' of ' .. #s, 0)
end

local parse_value

local function skip(s, i)
  local _, j = s:find('^[ ' .. CH(9) .. CH(13) .. CH(10) .. ']*', i)
  return (j or (i - 1)) + 1
end

local UNESC = {
  ['"'] = '"',
  [BACKSLASH] = BACKSLASH,
  ['/'] = '/',
  b = CH(8),
  f = CH(12),
  n = CH(10),
  r = CH(13),
  t = CH(9),
}

local function utf8_char(cp)
  if utf8 and utf8.char then return utf8.char(cp) end
  return CH(cp < 128 and cp or 63)
end

local function parse_string(s, i)
  local out = {}
  i = i + 1
  while true do
    local c = s:sub(i, i)
    if c == '' then decode_error(s, i, 'closing quote') end
    if c == '"' then return table.concat(out), i + 1 end
    if c == BACKSLASH then
      local e = s:sub(i + 1, i + 1)
      if e == 'u' then
        local hex = s:sub(i + 2, i + 5)
        if not hex:match('^%x%x%x%x$') then decode_error(s, i, 'four hex digits') end
        out[#out + 1] = utf8_char(tonumber(hex, 16))
        i = i + 6
      else
        local r = UNESC[e]
        if r == nil then decode_error(s, i, 'valid escape') end
        out[#out + 1] = r
        i = i + 2
      end
    else
      out[#out + 1] = c
      i = i + 1
    end
  end
end

local function parse_number(s, i)
  local j = s:find('[^%-%+0-9%.eE]', i) or (#s + 1)
  local n = tonumber(s:sub(i, j - 1))
  if n == nil then decode_error(s, i, 'number') end
  return n, j
end

parse_value = function(s, i)
  i = skip(s, i)
  local c = s:sub(i, i)
  if c == '{' then
    local t = {}
    i = skip(s, i + 1)
    if s:sub(i, i) == '}' then return t, i + 1 end
    while true do
      if s:sub(i, i) ~= '"' then decode_error(s, i, 'string key') end
      local k
      k, i = parse_string(s, i)
      i = skip(s, i)
      if s:sub(i, i) ~= ':' then decode_error(s, i, 'colon') end
      local v
      v, i = parse_value(s, i + 1)
      t[k] = v
      i = skip(s, i)
      local d = s:sub(i, i)
      if d == '}' then return t, i + 1 end
      if d ~= ',' then decode_error(s, i, 'comma or close') end
      i = skip(s, i + 1)
    end
  elseif c == '[' then
    local t = {}
    i = skip(s, i + 1)
    if s:sub(i, i) == ']' then return t, i + 1 end
    while true do
      local v
      v, i = parse_value(s, i)
      t[#t + 1] = v
      i = skip(s, i)
      local d = s:sub(i, i)
      if d == ']' then return t, i + 1 end
      if d ~= ',' then decode_error(s, i, 'comma or close') end
      i = i + 1
    end
  elseif c == '"' then
    return parse_string(s, i)
  elseif s:sub(i, i + 3) == 'true' then
    return true, i + 4
  elseif s:sub(i, i + 4) == 'false' then
    return false, i + 5
  elseif s:sub(i, i + 3) == 'null' then
    return M.null, i + 4
  elseif c:match('[%-0-9]') then
    return parse_number(s, i)
  end
  decode_error(s, i, 'value')
end

function M.decode(s)
  if type(s) ~= 'string' then error('expected string', 0) end
  local v, i = parse_value(s, 1)
  i = skip(s, i)
  if i <= #s then decode_error(s, i, 'end of input') end
  return v
end

return M
`;

/**
 * Both, as a chunk that installs them — and `bit32` is also a GLOBAL.
 *
 * E9-27. Preload alone was half the job, and the half that is missing is
 * the one scripts actually use. `bit32` is part of the `LUA_COMPAT_5_2`
 * layer norns' interpreter is built with, and a compat library is opened by
 * `luaL_openlibs`: on hardware it is a global **and** `package.loaded`
 * already holds it, exactly like `math.pow`, which `host.ts` makes global
 * for the same reason. Preload only answers `require`.
 *
 * Found by running `eterna`, whose vendored perlin noise is copied from a
 * Lua 5.2 gist and says `bit32.band(...)` with no require in the file:
 *
 *     lib/ext/perlin.lua:41: attempt to index a nil value (global 'bit32')
 *
 * `mosaic` does the same. `n.kria` requires it and worked all along, which
 * is why this went unseen. All three are using their platform correctly;
 * this environment was the one that was wrong.
 *
 * `package.loaded` is set from the same table rather than left to preload,
 * so `require 'bit32'` and the global are the SAME object — on hardware
 * they are, and a script that stores a reference from one and compares it
 * with the other should not be able to tell the difference.
 *
 * `cjson` stays preload-only: it is a C module installed in the image, not
 * part of any compat layer, and on hardware it is not a global either.
 */
export const COMPAT_PRELOAD_LUA = `
package.preload['bit32'] = function() ${BIT32_LUA} end
package.preload['cjson'] = function() ${CJSON_LUA} end
bit32 = require('bit32')
`;
