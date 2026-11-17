/* Hand-written cairo config.h for wasm32-emscripten.
 *
 * Replaces what cairo's ./configure would generate. Derived by enumerating
 * every #undef in cairo-1.16.0/config.h.in and deciding each one for the
 * Emscripten sysroot. See research/screen.md.
 *
 * cairo 1.16.0 is chosen deliberately: it is the version in Debian bullseye,
 * i.e. the one real norns hardware runs.
 */
#ifndef CAIRO_WASM_CONFIG_H
#define CAIRO_WASM_CONFIG_H

#define PACKAGE_NAME    "cairo"
#define PACKAGE_TARNAME "cairo"
#define PACKAGE_VERSION "1.16.0"
#define PACKAGE_STRING  "cairo 1.16.0"
#define PACKAGE_BUGREPORT "https://gitlab.freedesktop.org/cairo/cairo/issues"
#define PACKAGE_URL     ""

/* ---- headers present in the Emscripten sysroot ---- */
#define STDC_HEADERS 1
#define HAVE_STDINT_H 1
#define HAVE_STDLIB_H 1
#define HAVE_STRING_H 1
#define HAVE_STRINGS_H 1
#define HAVE_MEMORY_H 1
#define HAVE_INTTYPES_H 1
#define HAVE_UNISTD_H 1
#define HAVE_FCNTL_H 1
#define HAVE_SIGNAL_H 1
#define HAVE_SETJMP_H 1
#define HAVE_TIME_H 1
#define HAVE_FENV_H 1
#define HAVE_SCHED_H 1
#define HAVE_LIBGEN_H 1
#define HAVE_BYTESWAP_H 1
#define HAVE_SYS_TYPES_H 1
#define HAVE_SYS_STAT_H 1
#define HAVE_SYS_MMAN_H 1
#define HAVE_SYS_IOCTL_H 1
#define HAVE_SYS_WAIT_H 1
#define HAVE_SYS_POLL_H 1
#define HAVE_SYS_SOCKET_H 1
#define HAVE_SYS_UN_H 1

/* ---- libc functions ---- */
#define HAVE_MMAP 1
#define HAVE_MKDIR 1
#define HAVE_FORK 1
#define HAVE_WAITPID 1
#define HAVE_RAISE 1
#define HAVE_ALARM 1
#define HAVE_LINK 1
#define HAVE_GETLINE 1
#define HAVE_STRNDUP 1
#define HAVE_DRAND48 1
#define HAVE_FLOCKFILE 1
#define HAVE_FUNLOCKFILE 1
#define HAVE_CTIME_R 1
#define HAVE_GMTIME_R 1
#define HAVE_LOCALTIME_R 1
#define HAVE_CLOCK_GETTIME 1
#define HAVE_FECLEAREXCEPT 1

/* ---- compiler ---- */
#define HAVE_TYPEOF 1
#define HAVE_UINT64_T 1
#define HAVE_BUILTIN_RETURN_ADDRESS 1
#define WARN_UNUSED_RESULT __attribute__((__warn_unused_result__))

/* wasm32 */
#define SIZEOF_INT 4
#define SIZEOF_LONG 4
#define SIZEOF_LONG_LONG 8
#define SIZEOF_SIZE_T 4
#define SIZEOF_VOID_P 4
/* #undef WORDS_BIGENDIAN */
/* #undef FLOAT_WORDS_BIGENDIAN */

/* No X11 anywhere. */
#define X_DISPLAY_MISSING 1

/* ---- FreeType ---- (Emscripten's freetype port is modern; all present) */
#define HAVE_FT_GLYPHSLOT_EMBOLDEN 1
#define HAVE_FT_GLYPHSLOT_OBLIQUE 1
#define HAVE_FT_LOAD_SFNT_TABLE 1
#define HAVE_FT_LIBRARY_SETLCDFILTER 1
/* CORRECTED 2026-11-09 (E0-17). The comment here used to say emscripten
 * shipped an OLD freetype port and that these APIs were missing. That was
 * true of emsdk 3.1.61; it is false now. emsdk 4.0.18 fetches upstream
 * FreeType at VER-2-13-3 (tools/ports/freetype.py:8) — NEWER than the
 * 2.10.4 that norns runs on Debian bullseye — and both symbols link.
 *
 * They stay off because they are inert, not because they are absent: every
 * path they guard sits behind FT_Get_MM_Var(), which needs an `fvar` table,
 * and none of the 26 TTFs in norns' resources has one. Verified by reading
 * the font binaries. See research/screen-fidelity.md. */
/* #undef HAVE_FT_GET_VAR_DESIGN_COORDINATES */
/* #undef HAVE_FT_DONE_MM_VAR */
/* X11-specific FreeType helper, absent and unwanted. */
/* #undef HAVE_FT_GET_X11_FONT_FORMAT */
/* fontconfig disabled -- see cairo-features.h */
/* #undef HAVE_FCINIT */
/* #undef HAVE_FCFINI */

/* ---- threading: single-threaded build ---- */
/* Emscripten pthreads require SharedArrayBuffer; the screen path does not
 * need threads, so cairo is built without them. */
/* #undef CAIRO_HAS_PTHREAD */
/* #undef CAIRO_HAS_REAL_PTHREAD */
/* #undef HAVE_CXX11_ATOMIC_PRIMITIVES */
#define HAVE_GCC_LEGACY_ATOMICS 1
/* #undef ATOMIC_OP_NEEDS_MEMORY_BARRIER */

/* ---- things we do not have or do not want ---- */
/* #undef HAVE_ZLIB */
/* #undef HAVE_LZO */
/* #undef HAVE_DLFCN_H */
/* #undef CAIRO_HAS_DLSYM */
/* #undef CAIRO_HAS_SYMBOL_LOOKUP */
/* #undef CAIRO_HAS_INTERPRETER */
/* #undef CAIRO_HAS_TRACE */
/* #undef CAIRO_HAS_TEST_SURFACES */
/* #undef HAVE_VALGRIND */
/* #undef HAVE_LOCKDEP */
/* #undef HAVE_MEMFAULT */
/* #undef HAVE_GCOV */
/* #undef HAVE_BFD */
/* #undef HAVE_LIBRT */
/* #undef HAVE_IO_H */
/* #undef HAVE_XLOCALE_H */
/* #undef HAVE_STRTOD_L */
/* #undef HAVE_NEWLOCALE */
/* #undef HAVE_SCHED_GETAFFINITY */
/* #undef HAVE_UINT128_T */
/* #undef HAVE___UINT128_T */
/* #undef HAS_PIXMAN_GLYPHS */

#endif /* CAIRO_WASM_CONFIG_H */
