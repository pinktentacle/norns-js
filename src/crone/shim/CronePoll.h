// norns-js: crone's Poll, driven by the audio callback instead of a thread.
//
// Upstream `Poll::start()` spawns a `std::thread` that calls the callback and
// then `cv.wait_for(period)`. Two things make that unusable here, and the
// second is the one that matters:
//
//   1. An AudioWorkletGlobalScope cannot spawn a thread.
//   2. `Poll::start()` is only ever called from `OscInterface.cpp`, which
//      this port does not compile (1015 lines of liblo). So with upstream's
//      header the polls simply never start — and a poll that never starts
//      does not fail, it is just quiet. The VU meters stay at zero, softcut
//      never reports a phase, and nothing anywhere says why.
//
// That is worth stating plainly because it nearly passed a test: "no poll
// records dropped" is trivially true when no poll ever ran.
//
// So the period is counted in FRAMES, in the render callback that is already
// running. This is not a downgrade from the thread — it is better on every
// axis that matters here: no allocation, no lock, no wakeup jitter, and a
// period that is exact against the audio clock rather than against a
// condition variable's timeout. The cost is that a callback now runs ON the
// audio thread, which is why `shim/oracle.cpp` is a ring of plain stores.
//
// The interface is upstream's, so crone's own sources are unchanged.

#ifndef CRONE_POLL_H
#define CRONE_POLL_H

#include <cassert>
#include <functional>
#include <sstream>
#include <string>

class Poll {

  public:
    typedef std::function<void(const char *)> Callback;

    explicit Poll(std::string name) {
        std::ostringstream os;
        os << "/poll/" << name;
        path = os.str();
        // An intrusive singly-linked list of every live Poll, so the render
        // callback can tick them without anything having to keep a registry
        // in step. crone creates three, all at construction, and never
        // destroys them before the module goes away.
        next = head();
        head() = this;
    }

    ~Poll() {
        // Unlink, so a destroyed Poll is not ticked. Linear over three
        // elements, and it never runs on the audio thread.
        Poll **p = &head();
        while (*p != nullptr) {
            if (*p == this) {
                *p = next;
                return;
            }
            p = &((*p)->next);
        }
    }

    void setCallback(Callback c) {
        cb = std::move(c);
    }

    void start() {
        assert(this->cb && "Poll callback must be set before starting");
        countdown = 0; // fire on the next block, as the thread did on start
        running = true;
    }

    void stop() {
        running = false;
    }

    void setPeriod(int ms) {
        periodMs = ms;
    }

    const char *getPath() const {
        return path.c_str();
    }

    /** Advance every live poll by one block. Audio thread. */
    static void tickAll(int numFrames, int sampleRate) {
        for (Poll *p = head(); p != nullptr; p = p->next) {
            p->tick(numFrames, sampleRate);
        }
    }

    /**
     * Start or stop one poll by the name it was constructed with.
     *
     * Upstream this is `/poll/start/vu` arriving at the OSC interface. The
     * match is on the name, not on an index, because an index into a list
     * built in constructor order is exactly the kind of thing that shifts.
     */
    static bool setRunning(const char *name, bool on) {
        std::string want = std::string("/poll/") + name;
        bool found = false;
        for (Poll *p = head(); p != nullptr; p = p->next) {
            if (p->path == want) {
                if (on) {
                    p->start();
                } else {
                    p->stop();
                }
                found = true;
            }
        }
        return found;
    }

    static void stopAll() {
        for (Poll *p = head(); p != nullptr; p = p->next) {
            p->stop();
        }
    }

  private:
    void tick(int numFrames, int sampleRate) {
        if (!running || !cb) {
            return;
        }
        countdown -= numFrames;
        if (countdown > 0) {
            return;
        }
        // Reset from the period rather than adding to the remainder: a poll
        // that falls behind should resume at its period, not try to catch up
        // by firing repeatedly. These drive meters, not music.
        countdown = (periodMs * sampleRate) / 1000;
        if (countdown < numFrames) {
            countdown = numFrames;
        }
        cb(path.c_str());
    }

    /** Function-local static: no ordering problem with crone's globals. */
    static Poll *&head() {
        static Poll *h = nullptr;
        return h;
    }

    Callback cb;
    int periodMs = 50;
    int countdown = 0;
    bool running = false;
    std::string path;
    Poll *next = nullptr;
};

#endif // CRONE_POLL_H
