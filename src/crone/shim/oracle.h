// norns-js: the four callbacks crone makes back towards matron.
//
// Upstream, crone and matron are one process and these are direct calls into
// `oracle.cc`, which posts an event. Here crone is an AudioWorklet and matron
// is the main thread, so each one writes a record into the ring E3-03 already
// built — the same ring the clock uses, with the same wake message that makes
// delivery work in a hidden tab.
//
// They are called FROM THE AUDIO THREAD, so they must not allocate, block or
// throw. A ring push is a bounded store; a full ring drops and says so.
#ifndef NORNSJS_ORACLE_H
#define NORNSJS_ORACLE_H

#include <cstddef>
#include <cstdint>

extern "C" {

// Signatures copied exactly from matron/src/oracle.h:106-113. They are not
// guessed: `o_poll_callback_vu` takes twelve separate uint8_t levels rather
// than a buffer, and `tape_file` takes a TYPE (0 = play_close, 1 = rec_close)
// rather than a name — both are easy to assume wrongly and neither would fail
// to compile if assumed.
void o_poll_callback_vu(uint8_t in0, uint8_t in1, uint8_t out0, uint8_t out1,
                        uint8_t eng0, uint8_t eng1, uint8_t mon0, uint8_t mon1,
                        uint8_t cut0, uint8_t cut1, uint8_t tape0, uint8_t tape1);

void o_poll_callback_tape_status(int play_state, float play_pos_s, float play_len_s,
                                 int rec_state, float rec_pos_s, int loop_enabled);
void o_poll_callback_tape_file(int type);

void o_poll_callback_softcut_phase(int voice, float phase);
void o_poll_callback_softcut_position(int voice, float position);
void o_poll_callback_softcut_render(int ch, float secPerSample, float start,
                                    size_t count, const float *samples);
}

#endif
