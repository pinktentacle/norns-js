// norns-js: a stand-in for moodycamel::ConcurrentQueue.
//
// WHY THIS EXISTS, because it is a substitution in the audio path and that
// deserves to be stated plainly rather than discovered.
//
// crone's command queue is `moodycamel::ConcurrentQueue`, which norns vendors
// as a git submodule at `third-party/concurrentqueue`. That submodule is not
// checked out in this tree, and fetching it was refused by this environment's
// sandbox as untrusted code integration. Restoring it is one command:
//
//     cd third_party/norns && git submodule update --init --depth 1 \
//         third-party/concurrentqueue third-party/readerwriterqueue
//
// and if it is run, DELETE THIS FILE: the real one is on the include path
// behind it and upstream's queue is the faithful choice.
//
// WHAT CRONE ACTUALLY USES, measured rather than assumed: a constructor
// taking a capacity, `enqueue`, and `try_dequeue`. Nothing else, in either
// Commands.cpp or Commands.h.
//
// WHAT IS DIFFERENT. moodycamel's queue is multi-producer, multi-consumer and
// grows. This is a fixed-capacity single-producer/single-consumer ring, which
// is what crone's use actually is — commands are posted from one thread and
// drained in the audio callback — and it is bounded on purpose: growing
// inside an audio callback is an allocation, which is the one thing that
// callback must not do.
//
// A FULL QUEUE DROPS, and that is a real behavioural difference: moodycamel
// would allocate and keep the command. Here a command posted into a full ring
// is lost. 2048 entries is crone's own COMMAND_Q_CAPACITY, and filling it
// means the audio thread has not run for thousands of parameter changes — at
// which point the commands are already meaningless. `droppedCount` records
// it rather than hiding it.

#ifndef NORNSJS_CONCURRENTQUEUE_H
#define NORNSJS_CONCURRENTQUEUE_H

#include <atomic>
#include <cstddef>
#include <vector>

namespace moodycamel {

template <typename T>
class ConcurrentQueue {
  public:
    ConcurrentQueue() : ConcurrentQueue(1024) {}
    explicit ConcurrentQueue(size_t capacity)
        : buf(capacity + 1), cap(capacity + 1) {}

    /** Returns false when full. Upstream would grow instead. */
    bool enqueue(const T &item) {
        const size_t w = write.load(std::memory_order_relaxed);
        const size_t next = (w + 1) % cap;
        if (next == read.load(std::memory_order_acquire)) {
            dropped.fetch_add(1, std::memory_order_relaxed);
            return false;
        }
        buf[w] = item;
        // Release: the item must be visible before the index advertising it.
        write.store(next, std::memory_order_release);
        return true;
    }

    /** moodycamel's bounded spelling. Same thing here: this queue is bounded. */
    bool try_enqueue(const T &item) { return enqueue(item); }

    bool try_dequeue(T &out) {
        const size_t r = read.load(std::memory_order_relaxed);
        if (r == write.load(std::memory_order_acquire)) return false;
        out = buf[r];
        read.store((r + 1) % cap, std::memory_order_release);
        return true;
    }

    size_t size_approx() const {
        const size_t w = write.load(std::memory_order_relaxed);
        const size_t r = read.load(std::memory_order_relaxed);
        return (w + cap - r) % cap;
    }

    /** Commands lost to a full queue. Zero on any healthy run. */
    size_t droppedCount() const { return dropped.load(std::memory_order_relaxed); }

  private:
    std::vector<T> buf;
    size_t cap;
    std::atomic<size_t> read{0};
    std::atomic<size_t> write{0};
    std::atomic<size_t> dropped{0};
};

} // namespace moodycamel

#endif
