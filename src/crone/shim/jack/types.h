// norns-js: the JACK typedefs, without JACK.
//
// `Tape.h` includes this for the frame count and sample types. They are the
// only two JACK names the DSP uses outside Client.h — measured, not assumed.
#ifndef NORNSJS_JACK_TYPES_H
#define NORNSJS_JACK_TYPES_H

#include <cstdint>

typedef uint32_t jack_nframes_t;
typedef float jack_default_audio_sample_t;

// JACK's sentinel for "no limit", which Tape.h uses as an initial frame
// count. Upstream's value, not a guess: jack/types.h defines it as the
// largest 32-bit frame index.
#define JACK_MAX_FRAMES (4294967295U)

#endif
