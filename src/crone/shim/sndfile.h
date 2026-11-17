// norns-js: enough of libsndfile's C API for Tape.h to compile.
//
// Tape is not part of this build (E4-11) but `MixerClient.h:61` declares a
// `Tape<2>` MEMBER, so its 1047 lines have to compile. Declaring the API it
// names is far less invasive than replacing the class — and it keeps Tape's
// real code in the tree, ready for the story that gives it a filesystem.
//
// Every function here FAILS. Decoding belongs to the browser:
// `AudioContext.decodeAudioData` already handles every format it supports,
// and compiling a second decoder into wasm would ship more bytes to do a
// worse job. See sndfile.hh.
#ifndef NORNSJS_SNDFILE_H
#define NORNSJS_SNDFILE_H

#include <cstdint>
#include <cstddef>

typedef int64_t sf_count_t;
typedef struct SNDFILE_tag SNDFILE;

typedef struct SF_INFO {
    sf_count_t frames;
    int samplerate;
    int channels;
    int format;
    int sections;
    int seekable;
} SF_INFO;

#define SF_TRUE 1
#define SF_FALSE 0
#define SF_ERR_NO_ERROR 0

#define SFM_READ 0x10
#define SFM_WRITE 0x20
#define SFM_RDWR 0x30

#define SFC_SET_CLIPPING 0x10C0

#define SF_FORMAT_WAV 0x010000
#define SF_FORMAT_AIFF 0x020000
#define SF_FORMAT_PCM_S8 0x0001
#define SF_FORMAT_PCM_16 0x0002
#define SF_FORMAT_PCM_24 0x0003
#define SF_FORMAT_PCM_32 0x0004
#define SF_FORMAT_PCM_U8 0x0005
#define SF_FORMAT_FLOAT 0x0006

#define SF_SEEK_SET 0
#define SF_SEEK_CUR 1
#define SF_SEEK_END 2

static inline SNDFILE *sf_open(const char *, int, SF_INFO *) { return nullptr; }
static inline int sf_close(SNDFILE *) { return 0; }
static inline const char *sf_strerror(SNDFILE *) {
    return "no libsndfile in the browser (E4-11)";
}
static inline int sf_command(SNDFILE *, int, void *, int) { return 0; }
static inline int sf_error(SNDFILE *) { return 1; }
static inline sf_count_t sf_readf_float(SNDFILE *, float *, sf_count_t) { return 0; }
static inline sf_count_t sf_writef_float(SNDFILE *, const float *, sf_count_t) { return 0; }
static inline sf_count_t sf_read_float(SNDFILE *, float *, sf_count_t) { return 0; }
static inline sf_count_t sf_write_float(SNDFILE *, const float *, sf_count_t) { return 0; }
static inline sf_count_t sf_seek(SNDFILE *, sf_count_t, int) { return -1; }
static inline int sf_format_check(const SF_INFO *) { return SF_FALSE; }

#endif
