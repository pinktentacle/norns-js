# E9-269 — LAME's encoder library for wasm, for libsndfile's mp3 writing.
#
# LAME ships autotools only, and `./configure` under MSYS with a cross
# compiler is the argument build-fftw.sh avoided. The library is twenty C
# files with no generated sources, so this lists them, with a config.h
# answering what configure would on a 32-bit little-endian target. On
# purpose NOT defining TAKEHIRO_IEEE754_HACK or USE_FAST_LOG: configure sets
# them for x86 and PowerPC only, and a norns is aarch64, where it does not.
#
# Built and installed by tools/sclang/build-sndfile.sh:
#   lib/libmp3lame.a  and  include/lame/lame.h

cmake_minimum_required(VERSION 3.13)
project(mp3lame C)

if(NOT LAME_DIR)
  message(FATAL_ERROR "pass -DLAME_DIR=<third_party/lame>")
endif()

set(SRC
  bitstream.c encoder.c fft.c gain_analysis.c id3tag.c lame.c
  mpglib_interface.c newmdct.c presets.c psymodel.c quantize.c
  quantize_pvt.c reservoir.c set_get.c tables.c takehiro.c util.c
  vbrquantize.c VbrTag.c version.c
)
list(TRANSFORM SRC PREPEND "${LAME_DIR}/libmp3lame/")

add_library(mp3lame STATIC ${SRC})
target_include_directories(mp3lame PRIVATE
  "${CMAKE_CURRENT_SOURCE_DIR}"
  "${LAME_DIR}/include"
  "${LAME_DIR}/libmp3lame"
)
target_compile_definitions(mp3lame PRIVATE HAVE_CONFIG_H)

install(TARGETS mp3lame ARCHIVE DESTINATION lib)
install(FILES "${LAME_DIR}/include/lame.h" DESTINATION include/lame)
