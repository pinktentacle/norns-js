/* Hand-written pixman config.h for wasm32-emscripten.
 *
 * Replaces what ./configure would generate. Written by hand deliberately:
 * running an archive's configure script is not permitted in this sandbox,
 * and pixman's configuration surface is small enough to pin explicitly.
 *
 * Source: pixman-0.42.2/config.h.in (its full #undef list was enumerated and
 * each entry decided below). See research/screen.md.
 */
#ifndef PIXMAN_WASM_CONFIG_H
#define PIXMAN_WASM_CONFIG_H

#define PACKAGE         "pixman"
#define PACKAGE_NAME    "pixman"
#define PACKAGE_VERSION "0.42.2"
#define PACKAGE_STRING  "pixman 0.42.2"
#define VERSION         "0.42.2"

/* C library features present in the Emscripten sysroot. */
#define STDC_HEADERS 1
#define HAVE_STDIO_H 1
#define HAVE_STDLIB_H 1
#define HAVE_STRING_H 1
#define HAVE_STRINGS_H 1
#define HAVE_INTTYPES_H 1
#define HAVE_STDINT_H 1
#define HAVE_UNISTD_H 1
#define HAVE_SYS_TYPES_H 1
#define HAVE_SYS_STAT_H 1
#define HAVE_SYS_MMAN_H 1
#define HAVE_FENV_H 1
#define HAVE_MMAP 1
#define HAVE_MPROTECT 1
#define HAVE_GETPAGESIZE 1
#define HAVE_GETTIMEOFDAY 1
#define HAVE_POSIX_MEMALIGN 1
#define HAVE_ALARM 1
#define HAVE_SIGACTION 1

/* clang provides these. */
#define HAVE_BUILTIN_CLZ 1
#define HAVE_GCC_VECTOR_EXTENSIONS 1
#define TOOLCHAIN_SUPPORTS_ATTRIBUTE_CONSTRUCTOR 1

#define SIZEOF_LONG 4   /* wasm32 */

/* Single-threaded build: use plain statics instead of TLS, avoiding any
 * pthread dependency. Emscripten pthreads need SharedArrayBuffer, which we
 * do not want to force on the screen path. */
#define PIXMAN_NO_TLS 1

/* No SIMD on wasm32. Every arch backend is compiled out; pixman-x86.c,
 * pixman-arm.c, pixman-mips.c and pixman-ppc.c still compile and simply
 * return no implementation. */
/* #undef USE_X86_MMX */
/* #undef USE_SSE2 */
/* #undef USE_SSSE3 */
/* #undef USE_ARM_SIMD */
/* #undef USE_ARM_NEON */
/* #undef USE_ARM_A64_NEON */
/* #undef USE_ARM_IWMMXT */
/* #undef USE_MIPS_DSPR2 */
/* #undef USE_LOONGSON_MMI */
/* #undef USE_VMX */
/* #undef USE_GCC_INLINE_ASM */
/* #undef USE_OPENMP */

/* Not available / not wanted. */
/* #undef HAVE_PTHREADS */
/* #undef HAVE_GETISAX */
/* #undef HAVE_FEDIVBYZERO */
/* #undef HAVE_FEENABLEEXCEPT */
/* #undef HAVE_FLOAT128 */
/* #undef HAVE_LIBPNG */
/* #undef PIXMAN_TIMERS */
/* #undef PIXMAN_GNUPLOT */

#endif /* PIXMAN_WASM_CONFIG_H */
