// E4-07 / E4-08 / E4-09 — crone, as an AudioWorklet.
//
// crone is norns' audio engine: a JACK client holding the mixer (with its own
// reverb and compressor), six softcut voices, the tape, and a lock-free
// command queue that matron posts into. p1-api-plan §0.3 established that at
// this revision crone is compiled INTO matron, so `level_*`, `cut_*`, `rev_*`
// and `comp_*` are an in-process queue and not OSC at all — 62 of the 178.
//
// This file is the only new code in the port. Everything that makes a sound
// is upstream's, compiled unchanged; the shim/ directory replaces JACK and
// libsndfile, and this replaces `main.cpp` and the OSC interface.
//
// The graph, from MixerClient<6,6> and SoftcutClient<2,2>:
//
//     adc ──┐                        ┌── cut in
//     ext ──┼─► mixer ─► fx ─► dac   └── cut out ──► mixer
//     cut ──┘
//
// Upstream wires those as JACK ports between two clients. Here one render
// call runs softcut first and hands its output to the mixer, which is the
// same order JACK's graph would impose.

#include <cstring>
#include <emscripten.h>

#include "MixerClient.h"
#include "SoftcutClient.h"
#include "Commands.h"
#include "crone_param_dispatch.h"
#include "crone.h"
#include "CronePoll.h"
#include "BufDiskWorker.h"
#include "Tape.h"
#include "sndfile.hh"

using namespace crone;

namespace {

MixerClient *mixer = nullptr;
SoftcutClient *cutClient = nullptr;
int sampleRate = 48000;

// One render quantum's worth of interleaved-by-pair buffers. 128 is the
// browser's quantum; the extra headroom costs nothing and means a host with
// `renderSizeHint` does not overrun.
constexpr int MAX_FRAMES = 1024;
float adcL[MAX_FRAMES], adcR[MAX_FRAMES];
float dacL[MAX_FRAMES], dacR[MAX_FRAMES];
float extL[MAX_FRAMES], extR[MAX_FRAMES];
float cutInL[MAX_FRAMES], cutInR[MAX_FRAMES];
float cutOutL[MAX_FRAMES], cutOutR[MAX_FRAMES];
float auxL[MAX_FRAMES], auxR[MAX_FRAMES];

// E9-240 — WHAT IS PLUGGED INTO SUPERCOLLIDER'S TWO INPUTS, as JACK
// connections. On a norns those are cables in the JACK graph that a script
// can move: the default is `crone:output_5/6` (the Ext sink, the ADC after
// `level_adc`) into `SuperCollider:in_1/2`, and splnkr, otis, combos and
// tetrabotis `jack_connect softcut:output_1 SuperCollider:in_1` to put
// softcut through their engine. Here SuperCollider hears `aux`, which was
// the Ext sink and nothing else. route[source][input] is 1 for a cable,
// 0 for none; JACK sums what arrives at one port, so this does too.
//   sources: 0 crone:output_5, 1 crone:output_6, 2 softcut:output_1, 3 softcut:output_2
float route[4][2] = {{1.f, 0.f}, {0.f, 1.f}, {0.f, 0.f}, {0.f, 0.f}};
float extSinkL[MAX_FRAMES], extSinkR[MAX_FRAMES];

} // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE void crone_worklet_init(int sr) {
    sampleRate = sr;
    if (mixer == nullptr) mixer = new MixerClient();
    if (cutClient == nullptr) cutClient = new SoftcutClient();
    // The disk worker, WITHOUT its thread. `init(sr)` would try to spawn
    // one; this sets the sample rate it needs and leaves the queue to be
    // pumped from the render callback below. See shim/BufDiskWorkerPump.cpp.
    BufDiskWorker::nornsjsSetup(sr);
    // What rate the files crone writes are actually at. Upstream hardcodes
    // 48000 in `writeBufferMono` and `writeBufferStereo` because norns is
    // always 48 kHz; a browser's AudioContext is whatever the device is.
    cronejs::setEngineRate(sr);
    mixer->setup(static_cast<jack_nframes_t>(sr));
    cutClient->setup(static_cast<jack_nframes_t>(sr));
    crone_init(mixer, cutClient);
}

/** Where JS writes the microphone, and reads the speakers. */
EMSCRIPTEN_KEEPALIVE float *crone_adc_left() { return adcL; }
EMSCRIPTEN_KEEPALIVE float *crone_adc_right() { return adcR; }
EMSCRIPTEN_KEEPALIVE float *crone_dac_left() { return dacL; }
EMSCRIPTEN_KEEPALIVE float *crone_dac_right() { return dacR; }
/** The engine bus: scsynth's output, mixed in as `ext`. */
EMSCRIPTEN_KEEPALIVE float *crone_ext_left() { return extL; }
EMSCRIPTEN_KEEPALIVE float *crone_ext_right() { return extR; }
/**
 * E9-222 — and what goes BACK to the engine: the mixer's Ext sink, which
 * upstream fills with the ADC (`bus.ext_sink.copyFrom(bus.adc_source)`,
 * after `level_adc`) and JACK carries to SuperCollider's inputs
 * (`crone:output_5` -> `SuperCollider:in_1`). It was rendered here every
 * block and never left the worklet, so `SoundIn` — and `context.in_b`,
 * which is built from it — heard silence with the microphone on.
 */
EMSCRIPTEN_KEEPALIVE float *crone_aux_left() { return auxL; }
EMSCRIPTEN_KEEPALIVE float *crone_aux_right() { return auxR; }

/** E9-240 — connect (1) or disconnect (0) a source to one of SuperCollider's inputs. */
EMSCRIPTEN_KEEPALIVE void crone_route(int source, int input, float on) {
    if (source < 0 || source > 3 || input < 0 || input > 1) return;
    route[source][input] = on > 0.f ? 1.f : 0.f;
}

// The two INTERNAL buses between the mixer and softcut. Nothing in the audio
// path needs them from outside; they are exported because the chain
// ext -> cut in -> voice -> cut out -> dac has three links and a silent dac
// says only that one of them is broken. With these, a probe can say which.
EMSCRIPTEN_KEEPALIVE float *crone_cut_in_left() { return cutInL; }
EMSCRIPTEN_KEEPALIVE float *crone_cut_out_left() { return cutOutL; }

EMSCRIPTEN_KEEPALIVE int crone_num_voices() { return SoftcutClient::NumVoices; }
EMSCRIPTEN_KEEPALIVE int crone_sample_rate() { return sampleRate; }

/**
 * One block.
 *
 * Order matters and is upstream's: pending commands are applied BEFORE the
 * audio, so a parameter set between blocks takes effect on the block after
 * it rather than halfway through one — which is what makes a slew sound like
 * a slew rather than a step.
 */
EMSCRIPTEN_KEEPALIVE void crone_process(int numFrames) {
    if (mixer == nullptr || cutClient == nullptr) return;
    if (numFrames > MAX_FRAMES) numFrames = MAX_FRAMES;
    const auto n = static_cast<jack_nframes_t>(numFrames);

    Commands::softcutCommands.handlePending(cutClient);
    Commands::mixerCommands.handlePending(mixer);

    // One slice of disk work per block, if there is any. The budget is a
    // trade, not a tuned constant: 65536 frames is about 1.4 seconds of
    // audio to clear, roughly 1% of a 128-frame block's time at 48 kHz —
    // inaudible, and large enough that a full 2 x 2^24-frame `buffer_clear`
    // finishes in about 256 blocks, or 0.7 s. Upstream does it on a thread
    // and it is instant; here it is quick and quiet, which is the better of
    // the two ways to be wrong.
    //
    // BEFORE the audio: a region that was just cleared should be heard as
    // cleared in this block, not the next.
    BufDiskWorker::nornsjsRunJob(65536);

    // softcut first: the mixer takes its output as one of three sources, so
    // running it second would mix the PREVIOUS block's cut output — one
    // quantum of delay on every softcut voice, which is audible as a comb
    // filter the moment a voice feeds back.
    cutClient->setSource(0, cutInL, cutInR);
    cutClient->setSink(0, cutOutL, cutOutR);
    cutClient->render(n);

    // MixerClient<6,6>: sources are adc, ext (the engine), cut;
    // sinks are dac, aux (to softcut), and the insert return.
    mixer->setSource(MixerClient::SourceAdc, adcL, adcR);
    mixer->setSource(MixerClient::SourceExt, extL, extR);
    mixer->setSource(MixerClient::SourceCut, cutOutL, cutOutR);
    // Sinks are Dac, Cut and Ext — upstream's names, which say where the
    // signal GOES: Cut feeds softcut's input next block, Ext goes back out
    // to the engine.
    mixer->setSink(MixerClient::SinkDac, dacL, dacR);
    mixer->setSink(MixerClient::SinkCut, cutInL, cutInR);
    mixer->setSink(MixerClient::SinkExt, extSinkL, extSinkR);
    mixer->render(n);

    // E9-240 — the cables into SuperCollider, summed as JACK sums them.
    // softcut's output is THIS block's (it rendered first), which is what a
    // JACK connection from softcut's ports would carry too.
    for (jack_nframes_t i = 0; i < n; ++i) {
        const float s0 = extSinkL[i], s1 = extSinkR[i], s2 = cutOutL[i], s3 = cutOutR[i];
        auxL[i] = route[0][0] * s0 + route[1][0] * s1 + route[2][0] * s2 + route[3][0] * s3;
        auxR[i] = route[0][1] * s0 + route[1][1] * s1 + route[2][1] * s2 + route[3][1] * s3;
    }

    // The polls, LAST, so a vu frame reports the block that was just
    // rendered rather than the one before it.
    //
    // Upstream each Poll owns a std::thread. There is no thread here, and
    // `Poll::start()` is only called from the OSC interface this port does
    // not compile — so without this line the polls never run and nothing
    // says so: the meters simply stay at zero. See shim/CronePoll.h.
    Poll::tickAll(numFrames, sampleRate);
}

/**
 * Start or stop one of crone's polls, by name: vu, tape, softcut/phase.
 *
 * Upstream this is `/poll/start/vu` at the OSC interface. Returns 0 if no
 * poll has that name, rather than succeeding quietly — a misspelled poll
 * that reports success is a meter that never moves and a morning spent in
 * the wrong file.
 */
EMSCRIPTEN_KEEPALIVE int crone_poll_set(const char *name, int on) {
    return Poll::setRunning(name, on != 0) ? 1 : 0;
}

/**
 * `_norns.cut_query_position(i)` — ask one voice where it is.
 *
 * crone.cpp already has the body; it is not inline, so it needs a KEEPALIVE
 * wrapper to survive the link rather than a reimplementation. The answer does
 * not come back from this call: `crone_cut_query_position` pushes it through
 * `o_poll_callback_softcut_position`, i.e. the same ring as everything else,
 * and Lua hears it as `_norns.softcut_position`. That is upstream's shape and
 * it is the reason `cut_query_position` returns nothing.
 */
EMSCRIPTEN_KEEPALIVE void cronejs_cut_query_position(int voice) {
    crone_cut_query_position(voice);
}

// --- the buffer operations (E4-11) -----------------------------------
//
// crone.cpp has the bodies and they are not inline, so each needs a
// KEEPALIVE wrapper to survive the link rather than a reimplementation.
// Every one of them only QUEUES a job; the work happens in the pump, a
// slice per block. Nothing here blocks and nothing here returns a result.
//
// Argument names are upstream's own, from crone.h. `preserve` and `mix`
// are the two that are easy to swap and impossible to hear as a swap:
// preserve scales what is already in the buffer, mix scales what is
// arriving, and a sample loaded with them exchanged sounds like a
// quieter sample over the old one rather than like a bug.
EMSCRIPTEN_KEEPALIVE void cronejs_cut_buffer_clear() { crone_cut_buffer_clear(); }
EMSCRIPTEN_KEEPALIVE void cronejs_cut_buffer_clear_channel(int ch) {
    crone_cut_buffer_clear_channel(ch);
}
EMSCRIPTEN_KEEPALIVE void cronejs_cut_buffer_clear_region(float start, float dur, float fadeTime,
                                                          float preserve) {
    crone_cut_buffer_clear_region(start, dur, fadeTime, preserve);
}
EMSCRIPTEN_KEEPALIVE void cronejs_cut_buffer_clear_region_channel(int ch, float start, float dur,
                                                                  float fadeTime, float preserve) {
    crone_cut_buffer_clear_region_channel(ch, start, dur, fadeTime, preserve);
}
EMSCRIPTEN_KEEPALIVE void cronejs_cut_buffer_copy_mono(int srcCh, int dstCh, float srcStart,
                                                       float dstStart, float dur, float fadeTime,
                                                       float preserve, int reverse) {
    crone_cut_buffer_copy_mono(srcCh, dstCh, srcStart, dstStart, dur, fadeTime, preserve, reverse != 0);
}
EMSCRIPTEN_KEEPALIVE void cronejs_cut_buffer_copy_stereo(float srcStart, float dstStart, float dur,
                                                         float fadeTime, float preserve, int reverse) {
    crone_cut_buffer_copy_stereo(srcStart, dstStart, dur, fadeTime, preserve, reverse != 0);
}
EMSCRIPTEN_KEEPALIVE void cronejs_cut_buffer_read_mono(const char *path, float startSrc, float startDst,
                                                       float dur, int chanSrc, int chanDst,
                                                       float preserve, float mix) {
    crone_cut_buffer_read_mono(path, startSrc, startDst, dur, chanSrc, chanDst, preserve, mix);
}
EMSCRIPTEN_KEEPALIVE void cronejs_cut_buffer_read_stereo(const char *path, float startSrc,
                                                         float startDst, float dur, float preserve,
                                                         float mix) {
    crone_cut_buffer_read_stereo(path, startSrc, startDst, dur, preserve, mix);
}
EMSCRIPTEN_KEEPALIVE void cronejs_cut_buffer_write_mono(const char *path, float start, float dur,
                                                        int ch) {
    crone_cut_buffer_write_mono(path, start, dur, ch);
}
EMSCRIPTEN_KEEPALIVE void cronejs_cut_buffer_write_stereo(const char *path, float start, float dur) {
    crone_cut_buffer_write_stereo(path, start, dur);
}
EMSCRIPTEN_KEEPALIVE void cronejs_cut_buffer_render(int ch, float start, float dur, int samples) {
    crone_cut_buffer_render(ch, start, dur, samples);
}
EMSCRIPTEN_KEEPALIVE void cronejs_cut_reset() { crone_cut_reset(); }

// --- the tape (E4-11) -------------------------------------------------
//
// The twelve transport calls go through crone.cpp unchanged. What is new is
// the SEAM: upstream's tape streams to and from a disk on its own thread,
// and here the main thread is the disk. The record ring is drained once per
// block alongside the poll ring; the play ring is topped up the same way.
//
// `tapeStage` is one block's worth of interleaved frames, reused. Allocating
// per drain would allocate on the audio thread at block rate, which is the
// thing none of this is allowed to do.
namespace {
constexpr int TAPE_STAGE_FRAMES = 4096;
float tapeStage[TAPE_STAGE_FRAMES * 2];
} // namespace

EMSCRIPTEN_KEEPALIVE void cronejs_tape_rec_open(const char *path) { crone_tape_rec_open(path); }
EMSCRIPTEN_KEEPALIVE void cronejs_tape_rec_start() { crone_tape_rec_start(); }
EMSCRIPTEN_KEEPALIVE void cronejs_tape_rec_pause(int paused) { crone_tape_rec_pause(paused); }
EMSCRIPTEN_KEEPALIVE void cronejs_tape_rec_stop() { crone_tape_rec_stop(); }
EMSCRIPTEN_KEEPALIVE void cronejs_tape_play_open(const char *path) { crone_tape_play_open(path); }
EMSCRIPTEN_KEEPALIVE void cronejs_tape_play_start() { crone_tape_play_start(); }
EMSCRIPTEN_KEEPALIVE void cronejs_tape_play_pause(int paused) { crone_tape_play_pause(paused); }
EMSCRIPTEN_KEEPALIVE void cronejs_tape_play_stop() { crone_tape_play_stop(); }
EMSCRIPTEN_KEEPALIVE void cronejs_tape_play_loop(int enabled) { crone_tape_play_loop(enabled); }
EMSCRIPTEN_KEEPALIVE void cronejs_tape_pause() { crone_tape_pause(); }
EMSCRIPTEN_KEEPALIVE void cronejs_tape_resume() { crone_tape_resume(); }

/** The staging buffer both directions use, interleaved stereo. */
EMSCRIPTEN_KEEPALIVE float *cronejs_tape_stage() { return tapeStage; }
EMSCRIPTEN_KEEPALIVE int cronejs_tape_stage_frames() { return TAPE_STAGE_FRAMES; }

/** Frames waiting to be written to a file. */
EMSCRIPTEN_KEEPALIVE int cronejs_tape_rec_available() {
    auto *t = Tape<2>::live();
    return t == nullptr ? 0 : static_cast<int>(t->writer.ring.available());
}
/** Move up to a stage's worth into the staging buffer. Returns the frames. */
EMSCRIPTEN_KEEPALIVE int cronejs_tape_rec_drain() {
    auto *t = Tape<2>::live();
    if (t == nullptr) return 0;
    return static_cast<int>(t->writer.ring.pop(tapeStage, TAPE_STAGE_FRAMES));
}
/**
 * True ONCE, after a recording is stopped.
 *
 * Taking it rather than reading it is deliberate: the main thread has to
 * encode exactly one file per stop, and a flag that stayed set would write
 * the same recording again on the next drain.
 */
EMSCRIPTEN_KEEPALIVE int cronejs_tape_rec_finished() {
    auto *t = Tape<2>::live();
    return t != nullptr && t->writer.takeFinished() ? 1 : 0;
}
EMSCRIPTEN_KEEPALIVE double cronejs_tape_rec_dropped() {
    auto *t = Tape<2>::live();
    return t == nullptr ? 0 : static_cast<double>(t->writer.ring.dropped());
}

/** Tell the reader how long the file is before it is opened. */
EMSCRIPTEN_KEEPALIVE void cronejs_tape_play_prepare(double frames, double rate) {
    auto *t = Tape<2>::live();
    if (t != nullptr) t->reader.setFile(static_cast<size_t>(frames), static_cast<float>(rate));
}
/** Room in the play ring, in frames. */
EMSCRIPTEN_KEEPALIVE int cronejs_tape_play_space() {
    auto *t = Tape<2>::live();
    return t == nullptr ? 0 : static_cast<int>(t->reader.ring.space());
}
/** Push `frames` interleaved frames from the staging buffer. */
EMSCRIPTEN_KEEPALIVE void cronejs_tape_play_fill(int frames) {
    auto *t = Tape<2>::live();
    if (t == nullptr || frames <= 0) return;
    t->reader.ring.push(tapeStage, static_cast<size_t>(frames > TAPE_STAGE_FRAMES ? TAPE_STAGE_FRAMES : frames));
}
/** Blocks the reader had to fill with silence because nothing arrived. */
EMSCRIPTEN_KEEPALIVE double cronejs_tape_play_underruns() {
    auto *t = Tape<2>::live();
    return t == nullptr ? 0 : static_cast<double>(t->reader.underruns());
}
EMSCRIPTEN_KEEPALIVE double cronejs_tape_play_processed() {
    auto *t = Tape<2>::live();
    return t == nullptr ? 0 : static_cast<double>(t->playbackFramesProcessed());
}

/** How much disk work is still queued; 0 means every job has finished. */
EMSCRIPTEN_KEEPALIVE int cronejs_disk_pending() {
    return static_cast<int>(BufDiskWorker::nornsjsPending());
}

// --- the command surface ---------------------------------------------
//
// Named dispatch, exactly as matron does it: `crone_param_dispatch.cpp` maps
// a NAME to a setter, and §4.8's lesson applies here too — a caller that
// guesses the type sends a float where an int is meant and the failure lands
// somewhere else. The name comes across the boundary as a string so the one
// table upstream maintains stays the only table.

EMSCRIPTEN_KEEPALIVE void crone_cut_param(const char *name, int voice, float value) {
    crone_set_cut_param(name, voice, value);
}
EMSCRIPTEN_KEEPALIVE void crone_cut_param_ii(const char *name, int voice, int value) {
    crone_set_cut_param_ii(name, voice, value);
}
EMSCRIPTEN_KEEPALIVE void crone_cut_param_iif(const char *name, int a, int b, float value) {
    crone_set_cut_param_iif(name, a, b, value);
}
EMSCRIPTEN_KEEPALIVE void crone_reverb_param(const char *name, float value) {
    crone_set_reverb_param(name, value);
}
EMSCRIPTEN_KEEPALIVE void crone_compressor_param(const char *name, float value) {
    crone_set_compressor_param(name, value);
}

// The mixer's own commands — the levels — have no name table upstream to
// borrow. `crone_param_dispatch.cpp` covers softcut, the reverb and the
// compressor; the ~20 `SET_LEVEL_*` ids are mapped from OSC addresses inside
// `OscInterface.cpp`, which is the 1015 lines of liblo this port does not
// compile. So the id crosses the boundary as the ENUM VALUE, and the name
// table is derived from `Commands.h` by tools/extract-crone-commands.mjs
// rather than retyped here. One table, upstream's, as everywhere else.
//
// Four arities because `Commands::post` has four. Posting with the wrong one
// fills the wrong union members, which is silent: the command arrives and
// does something adjacent to what was meant.
EMSCRIPTEN_KEEPALIVE void crone_mixer_command_f(int id, float f) {
    Commands::mixerCommands.post(static_cast<Commands::Id>(id), f);
}
EMSCRIPTEN_KEEPALIVE void crone_mixer_command_if(int id, int i, float f) {
    Commands::mixerCommands.post(static_cast<Commands::Id>(id), i, f);
}
EMSCRIPTEN_KEEPALIVE void crone_mixer_command_ii(int id, int i, int j) {
    Commands::mixerCommands.post(static_cast<Commands::Id>(id), i, j);
}
EMSCRIPTEN_KEEPALIVE void crone_mixer_command_iif(int id, int i, int j, float f) {
    Commands::mixerCommands.post(static_cast<Commands::Id>(id), i, j, f);
}

// The SAME enum, the OTHER queue. `Commands::Id` is one list but there are two
// queues, and which one an id belongs to is not written anywhere in the enum:
// it is whichever client's `handleCommand` has a `case` for it. Posting
// `SET_LEVEL_CUT` to the mixer is not an error — the mixer's switch has no
// case for it, so the command is consumed and silently does nothing.
//
// That is why the generated table carries the queue alongside the id, read
// from the two switch statements. Nothing here has to remember.
EMSCRIPTEN_KEEPALIVE void crone_softcut_command_f(int id, float f) {
    Commands::softcutCommands.post(static_cast<Commands::Id>(id), f);
}
EMSCRIPTEN_KEEPALIVE void crone_softcut_command_if(int id, int i, float f) {
    Commands::softcutCommands.post(static_cast<Commands::Id>(id), i, f);
}
EMSCRIPTEN_KEEPALIVE void crone_softcut_command_ii(int id, int i, int j) {
    Commands::softcutCommands.post(static_cast<Commands::Id>(id), i, j);
}
EMSCRIPTEN_KEEPALIVE void crone_softcut_command_iif(int id, int i, int j, float f) {
    Commands::softcutCommands.post(static_cast<Commands::Id>(id), i, j, f);
}

} // extern "C"
