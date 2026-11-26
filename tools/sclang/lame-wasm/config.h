/* E9-269 — what LAME's configure would answer for wasm32 (see CMakeLists.txt). */
#ifndef LAME_WASM_CONFIG_H
#define LAME_WASM_CONFIG_H

#define STDC_HEADERS 1
#define HAVE_STDINT_H 1
#define HAVE_INTTYPES_H 1
#define HAVE_STRING_H 1
#define HAVE_STDLIB_H 1
#define HAVE_LIMITS_H 1
#define HAVE_ERRNO_H 1
#define HAVE_FCNTL_H 1
#define HAVE_UNISTD_H 1
#define HAVE_MEMORY_H 1
#define HAVE_STRCHR 1
#define HAVE_MEMCPY 1

#define SIZEOF_SHORT 2
#define SIZEOF_UNSIGNED_SHORT 2
#define SIZEOF_INT 4
#define SIZEOF_UNSIGNED_INT 4
#define SIZEOF_LONG 4
#define SIZEOF_UNSIGNED_LONG 4
#define SIZEOF_LONG_LONG 8
#define SIZEOF_UNSIGNED_LONG_LONG 8
#define SIZEOF_FLOAT 4
#define SIZEOF_DOUBLE 8

/* stdint has them all, so configure's fallback typedefs stay out */
#define HAVE_UINT8_T 1
#define HAVE_INT8_T 1
#define HAVE_UINT16_T 1
#define HAVE_INT16_T 1
#define HAVE_UINT32_T 1
#define HAVE_INT32_T 1
#define HAVE_UINT64_T 1
#define HAVE_INT64_T 1

/* and no system has these two: configure's AH_VERBATIM adds them */
typedef float ieee754_float32_t;
typedef double ieee754_float64_t;

#define PACKAGE "lame"
#define VERSION "3.100"
#define LAME_LIBRARY_BUILD 1

#endif
