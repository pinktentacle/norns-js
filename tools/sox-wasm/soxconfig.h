/* E9-275 — SoX's soxconfig.h for emscripten (src/soxconfig.h.cmake, filled
 * in by hand: what emscripten's musl has, nothing that talks to hardware).
 *
 * No popen (no processes), no termios (no terminal: sox only uses it for
 * the interactive keys of `play`), no audio devices. The codecs are on only
 * when the build links them (SOX_WASM_CODECS, tools/sox/build.sh).
 */
#define PACKAGE_VERSION "14.4.2"

#define HAVE_FENV_H 1
#define HAVE_FMEMOPEN 1
#define HAVE_FSEEKO 1
#define HAVE_GETTIMEOFDAY 1
#define HAVE_GLOB_H 1
#define HAVE_GSM 1
#define HAVE_INTTYPES_H 1
#define HAVE_LPC10 1
#define HAVE_LRINT 1
#define HAVE_MKSTEMP 1
#define HAVE_STDINT_H 1
#define HAVE_STRCASECMP 1
#define HAVE_STRING_H 1
#define HAVE_STRINGS_H 1
#define HAVE_SYS_STAT_H 1
#define HAVE_SYS_TIME_H 1
#define HAVE_SYS_TYPES_H 1
#define HAVE_SYS_UTSNAME_H 1
#define HAVE_UNISTD_H 1
#define HAVE_VSNPRINTF 1

#ifdef SOX_WASM_CODECS
#define HAVE_FLAC 1
#define HAVE_OGG_VORBIS 1
#define HAVE_LAME_LAME_H 1
#define HAVE_LAME_SET_VBR_QUALITY 1
#define HAVE_MP3 1
#endif
