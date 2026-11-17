// norns-js E9-35: Fverb, linkable beside the other Faust plugins.
//
// Same shape and same reason as JPverbRaw_static.cpp beside it, which
// carries the full explanation. In short: PortedPlugins' Fverb is Faust
// output ending in a bare
//
//     FAUST_EXPORT void load(InterfaceTable* inTable)
//
// where every other plugin has a unique `Name_Load`, and it defines
// `class mydsp` with virtual functions at global scope. wasm has no
// dlopen, so all of them share one link line — and two `mydsp` vtables are
// COMDAT symbols the linker folds into ONE, silently, giving one plugin
// the other's DSP. Fverb and Fverb2 are two reverbs by the same author
// from the same generator, so that fold would be very hard to hear and
// impossible to explain.
//
// A namespace per plugin fixes both. The shared headers are included
// FIRST, at global scope, so the copies inside the namespace are no-ops
// and the standard library is never namespaced.

#include <math.h>
#include <stdlib.h>
#include <string.h>

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <fstream>
#include <map>
#include <string>
#include <vector>

#include <SC_PlugIn.h>

// The generated file wraps its entry points in an explicit `extern "C"`,
// so a namespace does not change their symbols. Renamed by the
// preprocessor, after every include above — see JPverbRaw_static.cpp.
#define load nornsjs_fverb_load
#define api_version nornsjs_fverb_api_version
#define Faust_next nornsjs_fverb_Faust_next
#define Faust_next_copy nornsjs_fverb_Faust_next_copy
#define Faust_next_clear nornsjs_fverb_Faust_next_clear
#define Faust_Ctor nornsjs_fverb_Faust_Ctor
#define Faust_Dtor nornsjs_fverb_Faust_Dtor
// `server_type` is the third extern "C" the generated file exports,
// and two of them cannot share it either.
#define server_type nornsjs_fverb_server_type

namespace nornsjs_fverb {
// NOLINTNEXTLINE(bugprone-suspicious-include) — including the .cpp is the
// point: it is the unit of isolation.
#include "fverb.cpp"
} // namespace nornsjs_fverb

/** The name SC_StaticPlugins.h declares. */
void Fverb_Load(InterfaceTable* inTable) {
    nornsjs_fverb::nornsjs_fverb_load(inTable);
}
