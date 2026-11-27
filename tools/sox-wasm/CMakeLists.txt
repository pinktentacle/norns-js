# E9-275 — SoX 14.4.2 for wasm: the `sox` command the scripts run.
#
# SoX ships a CMakeLists.txt, but it asks for CMake 2.4 and calls
# install_files(), which CMake 3.31 refuses under any policy level that
# still configures. This builds the same sources (src/CMakeLists.txt's
# effects_srcs and formats_srcs, the library's own files, libgsm, lpc10,
# sox.c) with a soxconfig.h written for emscripten, and leaves the upstream
# tree untouched.
#
#   -DSOX_DIR=<third_party/sox>
#   -DSOX_CODECS=ON with -DSOX_DEPS=<deps prefix>: FLAC, Ogg Vorbis and MP3
#     writing (LAME), the codecs build-sndfile.sh built for scsynth.

cmake_minimum_required(VERSION 3.13)
project(sox_wasm C)

if(NOT SOX_DIR)
  message(FATAL_ERROR "-DSOX_DIR=<path to the sox tree> is required")
endif()

set(S ${SOX_DIR}/src)

set(effects_srcs
  bend biquad biquads chorus compand compandt contrast dcshift delay
  dft_filter dither divide downsample earwax echo echos fade fft4g fir
  firfit flanger gain hilbert input loudness mcompand noiseprof noisered
  output overdrive pad phaser rate remix repeat reverb reverse silence
  sinc skeleff speed splice stat stats stretch swap synth tempo tremolo
  trim upsample vad vol)

set(formats_srcs
  8svx adpcm adpcms aifc-fmt aiff aiff-fmt al-fmt au avr cdr cvsd
  cvsd-fmt dat dvms-fmt f4-fmt f8-fmt g711 g721 g723_24 g723_40 g72x gsm
  gsrt hcom htk ima-fmt ima_rw la-fmt lpc10 lu-fmt maud nulfile prc raw
  raw-fmt s1-fmt s2-fmt s3-fmt s4-fmt sf skelform smp sounder soundtool
  sox-fmt sphere tx16w u1-fmt u2-fmt u3-fmt u4-fmt ul-fmt voc vox vox-fmt
  wav wve xa)

set(lib_srcs
  effects formats_i libsox_i effects_i effects_i_dsp getopt util formats
  libsox xmalloc)

set(optional_srcs)
set(optional_libs)
if(SOX_CODECS)
  # The same names src/CMakeLists.txt's optional() would have added for
  # FLAC, Ogg Vorbis and LAME. mp3.c reads only through libmad, which is not
  # here: .mp3 is written, not read (sox says so).
  list(APPEND optional_srcs flac vorbis mp3)
endif()

set(srcs)
foreach(f ${effects_srcs} ${formats_srcs} ${lib_srcs} ${optional_srcs})
  if(NOT f STREQUAL "formats")
    list(APPEND srcs ${S}/${f}.c)
  endif()
endforeach()

# formats.c's rewind_pipe() knows glibc, BSD and MSVC stdio and stops on
# any other with `#error FIX NEEDED HERE`; its own comment says to remove
# that line "and live without file-type detection with pipes". emscripten's
# libc is musl, and there are no pipes here. A copy, without the line.
file(READ ${S}/formats.c formats_text)
string(REPLACE "#error FIX NEEDED HERE" "/* norns-js: musl, no pipes (see tools/sox-wasm) */" formats_text "${formats_text}")
file(WRITE ${CMAKE_CURRENT_BINARY_DIR}/formats.c "${formats_text}")
list(APPEND srcs ${CMAKE_CURRENT_BINARY_DIR}/formats.c)

file(GLOB gsm_srcs ${SOX_DIR}/libgsm/*.c)
file(GLOB lpc10_srcs ${SOX_DIR}/lpc10/*.c)

add_executable(sox ${S}/sox.c ${srcs} ${gsm_srcs} ${lpc10_srcs})

# soxconfig.h comes from here, before anything in the tree.
target_include_directories(sox BEFORE PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR} ${S} ${SOX_DIR}/libgsm ${SOX_DIR}/lpc10)
target_compile_definitions(sox PRIVATE HAVE_CONFIG_H=1)
target_compile_options(sox PRIVATE -O2 -Wno-implicit-function-declaration -Wno-int-conversion)

if(SOX_CODECS)
  target_compile_definitions(sox PRIVATE SOX_WASM_CODECS=1)
  target_include_directories(sox PRIVATE ${SOX_DEPS}/include)
  target_link_directories(sox PRIVATE ${SOX_DEPS}/lib)
  # Static, in dependency order: what needs ogg before ogg.
  target_link_libraries(sox PRIVATE FLAC vorbisfile vorbisenc vorbis mp3lame ogg m)
endif()

# A module the page instantiates once per command: no main() at load,
# EXIT_RUNTIME so exit() flushes stdio (stdout is not a tty, so musl buffers
# it all: `sox --i` printed nothing without it), the filesystem and callMain
# exported.
target_link_options(sox PRIVATE
  -sMODULARIZE=1
  -sEXPORT_ES6=1
  -sEXPORT_NAME=createSox
  -sINVOKE_RUN=0
  -sEXIT_RUNTIME=1
  -sWASM_ASYNC_COMPILATION=0
  -sALLOW_MEMORY_GROWTH=1
  -sINITIAL_MEMORY=33554432
  -sSTACK_SIZE=1048576
  -sFORCE_FILESYSTEM=1
  -sENVIRONMENT=web,worker
  -sEXPORTED_RUNTIME_METHODS=FS,callMain
)
