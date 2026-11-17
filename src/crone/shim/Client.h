// norns-js: crone's Client base, with JACK removed.
//
// A drop-in replacement for `crone/src/Client.h`, placed FIRST on the include
// path so it wins without patching third_party. Same technique as the
// SuperCollider SystemOverwrites: upstream stays pristine and the difference
// stays in one readable file.
//
// Upstream's Client is a thin JACK wrapper: it owns ports, fetches their
// buffers into `source`/`sink` before each callback, and calls the subclass's
// `process`. Everything below that — MixerClient's 6-in/6-out graph, its
// reverb and compressor, SoftcutClient's six voices — never touches JACK at
// all. Measured: outside Client.h, Tape.h and OscInterface.h, the whole of
// crone references exactly two JACK symbols, `jack_nframes_t` (8 times) and
// one `jack_get_sample_rate`.
//
// So the port is this file. The AudioWorklet supplies the buffers and calls
// `render`; ports, connection and the server callback go away, because an
// AudioWorklet has one callback and we are already inside it.

#ifndef CRONE_CLIENT_H
#define CRONE_CLIENT_H

#include <array>
#include <cstddef>
#include <cstdint>
#include <iostream>

#include "Commands.h"

// The two JACK names the DSP uses. Shared with jack/types.h, which Tape.h
// includes, so the definition lives in one place.
#include "jack/types.h"

namespace crone {

template <int NumIns, int NumOuts>
class Client {
  private:
    static_assert(NumIns % 2 == 0, "non-even input count");
    static_assert(NumOuts % 2 == 0, "non-even output count");

    const char *name;

  protected:
    // `SoftcutClient.h:62` computes `sec * jack_get_sample_rate(Client::client)`.
    // Upstream asks the JACK server; here the rate is a property of the
    // AudioContext and is handed in at setup. `client` is kept as the handle
    // that call expects so the line compiles unchanged — it is this object,
    // and `jack_get_sample_rate` below reads the rate off it.
    Client *client = this;
    jack_nframes_t sampleRate_ = 48000;

    typedef const float *Source[2];
    typedef float *Sink[2];

    // Upstream fills these from jack_port_get_buffer in preProcess. Here the
    // host points them at the worklet's own buffers before each render, which
    // is the same contract one step earlier.
    std::array<Source, NumIns / 2> source{};
    std::array<Sink, NumOuts / 2> sink{};

    virtual void process(jack_nframes_t numFrames) = 0;
    virtual void setSampleRate(jack_nframes_t sr) = 0;

  public:
    explicit Client(const char *n) : name(n) {}
    virtual ~Client() = default;

    virtual void handleCommand(Commands::CommandPacket *p) = 0;

    const char *getName() const { return name; }

    /** Point one stereo input pair at the caller's buffers. */
    void setSource(int pair, const float *l, const float *r) {
        if (pair >= 0 && pair < NumIns / 2) {
            source[pair][0] = l;
            source[pair][1] = r;
        }
    }

    /** Point one stereo output pair at the caller's buffers. */
    void setSink(int pair, float *l, float *r) {
        if (pair >= 0 && pair < NumOuts / 2) {
            sink[pair][0] = l;
            sink[pair][1] = r;
        }
    }

    /** Run one block. The AudioWorklet's own callback is the clock. */
    void render(jack_nframes_t numFrames) { this->process(numFrames); }

    /** Upstream reads this from jack_get_sample_rate during setup. */
    void setup(jack_nframes_t sr) {
        sampleRate_ = sr;
        this->setSampleRate(sr);
    }

    jack_nframes_t sampleRate() const { return sampleRate_; }

    // NOTE the names: upstream's getNumSinks returns NumIns/2 and
    // getNumSources returns NumOuts/2 — the opposite of what they sound like.
    // Kept exactly as upstream, because `connect()` reads them that way and a
    // "fix" here would silently change which pair a caller addresses.
    int getNumSinks() const { return NumIns / 2; }
    int getNumSources() const { return NumOuts / 2; }
};

} // namespace crone

/**
 * Stands in for the JACK server query.
 *
 * Templated because `Client<2,2>` and `Client<6,6>` are different types and
 * the call site passes whichever it is.
 */
template <int NumIns, int NumOuts>
static inline jack_nframes_t jack_get_sample_rate(crone::Client<NumIns, NumOuts> *c) {
    return c == nullptr ? 48000 : c->sampleRate();
}

#endif // CRONE_CLIENT_H
