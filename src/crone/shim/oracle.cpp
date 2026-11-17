// norns-js: the bodies behind shim/oracle.h.
//
// Upstream these four are direct calls into `matron/src/oracle.c`, which posts
// an event onto matron's queue. crone and matron are one process there, so a
// call is a call. Here crone is an AudioWorklet and matron is the main thread,
// and the call happens ON THE AUDIO THREAD — inside `MixerClient::process`,
// inside `SoftcutClient::process`. So the body may not allocate, may not lock
// and may not throw. It writes a fixed-size record into a pre-allocated ring
// and returns.
//
// WHY A RING AND NOT A postMessage PER EVENT: the obvious shape — have each
// callback ship its own message — allocates on the audio thread, once per
// event, at poll rate. The ring is static memory written with plain stores;
// the worklet's `process()` drains it ONCE per quantum, right after
// `crone_process` returns, and posts only when there is something. In the
// common quantum the drain reads one integer and does nothing.
//
// PRODUCER AND CONSUMER ARE THE SAME THREAD. That is worth saying plainly
// because it is what makes the plain `int` indices here correct rather than
// merely lucky: the JS that drains this ring runs in the worklet's `process`,
// on the audio thread, between two `crone_process` calls. Nothing else ever
// touches these indices. (The clock's ring in E3-03 is a genuine SPSC ring
// across two threads and uses Atomics for exactly that reason; this one is
// not, and pretending otherwise would be cargo cult.)
//
// The cross-thread hop happens afterwards, in JS, as one batched postMessage.
// That satisfies the rule E3 paid for in research/clock-worklet-pull.md §9 —
// *anything the audio thread produces needs a delivery path that is not a
// frame* — because a worklet message is delivered to the main thread whether
// or not the tab is drawing. A hidden tab still gets its VU meters.
//
// A FULL RING DROPS. It does not grow, it does not block, and it does not
// pretend: `crone_events_dropped()` counts what was lost so a caller can say
// "the meters are behind" instead of showing stale numbers for ever.

#include "oracle.h"

#include <cstring>
#include <emscripten.h>

namespace {

// 16 floats per record because `vu` carries twelve levels and splitting it
// across two records would let a drain see half a frame.
constexpr int SLOTS = 16;
constexpr int CAPACITY = 256;

float ring[CAPACITY * SLOTS];
int ringHead = 0; // next to write
int ringCount = 0;
int ringDropped = 0;

// softcut's render is the one variable-length payload: a waveform preview,
// occasional and up to a few thousand samples. It gets a staging buffer of its
// own rather than a path through a fixed record, and a second render arriving
// before the first is drained is dropped rather than half-overwritten.
constexpr int RENDER_MAX = 8192;
float renderBuf[RENDER_MAX];
int renderCount = 0;
bool renderPending = false;
int renderDropped = 0;

inline float *claim(float type) {
    if (ringCount >= CAPACITY) {
        ringDropped++;
        return nullptr;
    }
    float *r = &ring[ringHead * SLOTS];
    ringHead = (ringHead + 1) % CAPACITY;
    ringCount++;
    r[0] = type;
    return r;
}

} // namespace

extern "C" {

// Record types. Mirrored in src/crone/events.js; changing one without the
// other silently reinterprets a payload — a tape status decoded as a vu
// frame, twelve garbage levels reaching `_norns.vu`. So they are named on
// both sides, and test/crone-events.test.ts reads THIS enum and checks the
// JavaScript still agrees with it.
enum : int {
    EV_VU = 1,
    EV_TAPE_STATUS = 2,
    EV_TAPE_FILE = 3,
    EV_SOFTCUT_PHASE = 4,
    EV_SOFTCUT_POSITION = 5,
    EV_SOFTCUT_RENDER = 6,
};

void o_poll_callback_vu(uint8_t in0, uint8_t in1, uint8_t out0, uint8_t out1,
                        uint8_t eng0, uint8_t eng1, uint8_t mon0, uint8_t mon1,
                        uint8_t cut0, uint8_t cut1, uint8_t tape0, uint8_t tape1) {
    float *r = claim(EV_VU);
    if (r == nullptr) return;
    // The ORDER is matron's, not a guess: `w_handle_poll_io_levels` pushes
    // twelve separate integers and `core/norns.lua` reads them positionally.
    r[1] = in0;  r[2] = in1;
    r[3] = out0; r[4] = out1;
    r[5] = eng0; r[6] = eng1;
    r[7] = mon0; r[8] = mon1;
    r[9] = cut0; r[10] = cut1;
    r[11] = tape0; r[12] = tape1;
}

void o_poll_callback_tape_status(int play_state, float play_pos_s, float play_len_s,
                                 int rec_state, float rec_pos_s, int loop_enabled) {
    float *r = claim(EV_TAPE_STATUS);
    if (r == nullptr) return;
    r[1] = static_cast<float>(play_state);
    r[2] = play_pos_s;
    r[3] = play_len_s;
    r[4] = static_cast<float>(rec_state);
    r[5] = rec_pos_s;
    r[6] = static_cast<float>(loop_enabled);
}

void o_poll_callback_tape_file(int type) {
    float *r = claim(EV_TAPE_FILE);
    if (r == nullptr) return;
    // A TYPE, not a name: 0 = play_close, 1 = rec_close. The Lua side turns it
    // back into `_norns.tape_play_file` / `_norns.tape_rec_file`, which is
    // where the filename lives — crone never had it.
    r[1] = static_cast<float>(type);
}

void o_poll_callback_softcut_phase(int voice, float phase) {
    float *r = claim(EV_SOFTCUT_PHASE);
    if (r == nullptr) return;
    r[1] = static_cast<float>(voice); // 0-based here; callbacks.ts adds the 1
    r[2] = phase;
}

void o_poll_callback_softcut_position(int voice, float position) {
    float *r = claim(EV_SOFTCUT_POSITION);
    if (r == nullptr) return;
    r[1] = static_cast<float>(voice);
    r[2] = position;
}

void o_poll_callback_softcut_render(int ch, float secPerSample, float start,
                                    size_t count, const float *samples) {
    if (renderPending || count > RENDER_MAX) {
        renderDropped++;
        return;
    }
    float *r = claim(EV_SOFTCUT_RENDER);
    if (r == nullptr) return;
    r[1] = static_cast<float>(ch);
    r[2] = secPerSample;
    r[3] = start;
    r[4] = static_cast<float>(count);
    // memcpy of floats on the audio thread is a bounded copy, not an
    // allocation. RENDER_MAX caps it at 32 kB.
    std::memcpy(renderBuf, samples, count * sizeof(float));
    renderCount = static_cast<int>(count);
    renderPending = true;
}

// ---- the drain side, called from the worklet's process() -----------------

EMSCRIPTEN_KEEPALIVE int crone_events_slots() { return SLOTS; }
EMSCRIPTEN_KEEPALIVE int crone_events_capacity() { return CAPACITY; }
EMSCRIPTEN_KEEPALIVE float *crone_events_buffer() { return ring; }
EMSCRIPTEN_KEEPALIVE int crone_events_count() { return ringCount; }
/** Index of the OLDEST unread record; the ring wraps, so the drain must too. */
EMSCRIPTEN_KEEPALIVE int crone_events_tail() {
    int tail = ringHead - ringCount;
    return tail < 0 ? tail + CAPACITY : tail;
}
EMSCRIPTEN_KEEPALIVE void crone_events_clear() { ringCount = 0; }
EMSCRIPTEN_KEEPALIVE int crone_events_dropped() { return ringDropped + renderDropped; }

EMSCRIPTEN_KEEPALIVE float *crone_render_buffer() { return renderBuf; }
EMSCRIPTEN_KEEPALIVE int crone_render_count() { return renderPending ? renderCount : 0; }
EMSCRIPTEN_KEEPALIVE void crone_render_clear() { renderPending = false; renderCount = 0; }

} // extern "C"
