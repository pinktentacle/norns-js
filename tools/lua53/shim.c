/* E9-117 — the few things the binding layer cannot do from JavaScript.
 *
 * Almost all of Lua's API is exported directly and the macros are rebuilt in
 * `src/lua/wasm53.ts`, where they are one line each and a reader can check
 * them against `lua.h`. What is here is what needs the C side:
 *
 *   - raising a Lua error from inside a JavaScript callback, which has to
 *     `longjmp` and therefore cannot be a sequence of exported calls;
 *   - `luaL_loadbuffer`, because its last argument is a mode string that is
 *     NULL in the macro and passing a null pointer through the glue is
 *     easier to get wrong than to write here;
 *   - two string helpers, because `lua_tolstring` returns a pointer AND a
 *     length through an out-parameter, and reading an out-parameter from JS
 *     means allocating a cell for it on every call.
 *
 * Everything else is `lua_*` as the headers declare it.
 */

#include <string.h>
#include "lua.h"
#include "lauxlib.h"
#include "lualib.h"
#include <emscripten.h>

/* A JavaScript exception that escaped a host function, as a Lua error.
 *
 * This is what fengari's `lua_atnativeerror` was for. Without it a JS throw
 * inside a binding unwinds through wasm and aborts the module, where norns
 * expects a catchable error with a message — `norns.script.load` failing
 * with "0" from nowhere was the fengari version of the same bug (host.ts).
 *
 * Does not return: `lua_error` longjmps to the enclosing pcall. */
EMSCRIPTEN_KEEPALIVE
void njs_raise(lua_State *L, const char *msg) {
  lua_pushstring(L, msg);
  lua_error(L);
}

/* `luaL_loadbuffer` is a macro over `luaL_loadbufferx` with mode NULL. */
EMSCRIPTEN_KEEPALIVE
int njs_loadbuffer(lua_State *L, const char *buff, size_t sz, const char *name) {
  return luaL_loadbufferx(L, buff, sz, name, NULL);
}

/* The length of the string at `idx`, converting numbers as Lua does.
 *
 * Paired with `njs_tostring_ptr` below: two calls rather than one call and
 * an out-parameter, because a cell allocated per call is the thing this is
 * avoiding. The value is left on the stack between them, which is why the
 * pointer call must come second and immediately. */
EMSCRIPTEN_KEEPALIVE
int njs_tostring_len(lua_State *L, int idx) {
  size_t n = 0;
  if (lua_tolstring(L, idx, &n) == NULL) return -1;
  return (int)n;
}

EMSCRIPTEN_KEEPALIVE
const char *njs_tostring_ptr(lua_State *L, int idx) {
  size_t n = 0;
  return lua_tolstring(L, idx, &n);
}

/* `lua_rawlen` returns size_t; the glue is happier with an int, and no
 * table norns passes is anywhere near 2^31. */
EMSCRIPTEN_KEEPALIVE
int njs_rawlen(lua_State *L, int idx) { return (int)lua_rawlen(L, idx); }

/* `luaL_tolstring` with the length dropped: used only for error messages. */
EMSCRIPTEN_KEEPALIVE
const char *njs_tolstring_any(lua_State *L, int idx) {
  return luaL_tolstring(L, idx, NULL);
}

/* newstate + openlibs, so the caller does not have to sequence them. */
EMSCRIPTEN_KEEPALIVE
lua_State *njs_newstate(void) {
  lua_State *L = luaL_newstate();
  if (L) luaL_openlibs(L);
  return L;
}

EMSCRIPTEN_KEEPALIVE
const char *njs_version(void) { return LUA_RELEASE; }
