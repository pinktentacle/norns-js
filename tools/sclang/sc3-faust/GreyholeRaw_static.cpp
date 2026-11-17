// norns-js: GreyholeRaw, linkable beside another Faust plugin.
//
// THE PROBLEM. sc3-plugins' Faust-generated UGens are not written for a
// static link. Each one ends with
//
//     FAUST_EXPORT void load(InterfaceTable* inTable)
//
// — a bare `load`, where every other plugin uses `PluginLoad(Name)` and gets
// a unique `Name_Load`. wasm has no `dlopen`, so every plugin has to be on
// one link line, and two bare `load`s cannot be.
//
// AND THE NAME IS THE SMALL HALF OF IT. Faust generates `class mydsp` in
// every file, with virtual functions — so `GreyholeRaw.cpp` and
// `GreyholeRaw.cpp` each define a `mydsp` vtable and typeinfo at global
// scope. Those are COMDAT symbols: the linker does not complain, it picks
// ONE and both plugins use it. The result is a Greyhole that runs JPverb's
// DSP, or the reverse, with nothing anywhere to say so. That is the failure
// this file exists to prevent, and it is worse than a link error.
//
// `include/jprev.h` is the third: a non-inline `int primes(int)` at global
// scope, included by both.
//
// THE FIX is to give each plugin a namespace of its own. The shared headers
// are included FIRST, at global scope, so the copy inside the namespace is a
// no-op and the standard library is never namespaced — that would not
// compile. `jprev.h` is deliberately NOT among them: it must land inside,
// so each plugin gets its own `primes`.
//
// What is left at global scope is one forwarder with the name
// `SC_StaticPlugins.h` expects.

// Everything the generated file includes, except jprev.h. Guarded headers,
// so the includes inside the namespace below do nothing.
#include <math.h>
#include <stdlib.h>
#include <string.h>

#include <algorithm>
#include <cmath>
#include <map>
#include <string>

#include <SC_PlugIn.h>

#include <faust/dsp/dsp.h>
#include <faust/gui/UI.h>
#include <faust/misc.h>

// THE NAMESPACE IS NOT ENOUGH ON ITS OWN. The generated file wraps its
// entry points in an explicit `extern "C" { ... }`, so `load`,
// `api_version`, `Faust_Ctor`, `Faust_Dtor` and the three `Faust_next*`
// keep C linkage and the same symbol inside a namespace as outside it.
// Linking two of them gives
//
//     wasm-ld: error: duplicate symbol: Faust_Dtor
//     wasm-ld: error: duplicate symbol: api_version
//     wasm-ld: error: duplicate symbol: load
//
// so they are renamed by the preprocessor. AFTER every include above, on
// purpose: `#define load ...` before `SC_PlugIn.h` would rename whatever
// `load` the headers happen to use. By here they are all parsed, and the
// only thing left to rewrite is the generated file's own body — where each
// of these names appears two or three times and always as the function.
// AND THE NAME THE UGEN REGISTERS UNDER. The generated file ends with
//
//     #if !defined(SC_FAUST_PREFIX)
//     # define SC_FAUST_PREFIX "Faust"
//     ...
//     if (strncmp(name.c_str(), SC_FAUST_PREFIX, strlen(SC_FAUST_PREFIX)) != 0) {
//         name = SC_FAUST_PREFIX + name;
//     }
//
// so without a build-time definition the unit is registered as
// `FaustGreyholeRaw` while the SC class asks for `GreyholeRaw`. sc3-plugins'
// own CMake passes an empty prefix; this build has to as well.
//
// THE FAILURE IT CAUSED IS WORTH THE PARAGRAPH. A graph def naming a UGen
// the server does not have makes scsynth THROW — and this build has
// exceptions off, so the throw is not caught and turned into
// `/fail /d_recv` with "UGen 'GreyholeRaw' not installed". It aborts the
// worker with a bare address:
//
//     Uncaught 19842080
//
// and sends nothing at all back: no `/done`, no `/fail`, no posted error.
// From sclang's side the def simply never arrives, and the first thing
// anyone sees is `SynthDef effect not found` from an `/s_new` much later.
#define SC_FAUST_PREFIX ""

#define load nornsjs_greyhole_load
#define api_version nornsjs_greyhole_api_version
#define Faust_next nornsjs_greyhole_Faust_next
#define Faust_next_copy nornsjs_greyhole_Faust_next_copy
#define Faust_next_clear nornsjs_greyhole_Faust_next_clear
#define Faust_Ctor nornsjs_greyhole_Faust_Ctor
#define Faust_Dtor nornsjs_greyhole_Faust_Dtor

namespace nornsjs_greyhole {
// NOLINTNEXTLINE(bugprone-suspicious-include) — including a .cpp is the
// point: it is the unit of isolation here, and sc3-plugins is upstream.
#include "GreyholeRaw.cpp"
} // namespace nornsjs_greyhole

/** The name SC_StaticPlugins.h declares. C++ linkage, as every `X_Load` has. */
void GreyholeRaw_Load(InterfaceTable* inTable) {
    // The renamed C entry point from inside the namespace. Qualified by
    // hand because the macro above moved it out from under the namespace's
    // name — C linkage ignores scope.
    nornsjs_greyhole::nornsjs_greyhole_load(inTable);
}
