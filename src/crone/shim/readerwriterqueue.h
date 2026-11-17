// norns-js: a stand-in for moodycamel::ReaderWriterQueue.
//
// `Tape.h` uses it for its command queue. Same situation and same reasoning
// as concurrentqueue.h in this directory: the submodule is not checked out
// and fetching it was refused by this environment's sandbox. Restoring it is
// one command, and if it is run this file should be deleted.
//
// ReaderWriterQueue is already single-producer/single-consumer upstream, so
// unlike the ConcurrentQueue substitution this one has the same concurrency
// contract — it differs only in being fixed-capacity rather than growing,
// which is the right trade in an audio callback.
#ifndef NORNSJS_READERWRITERQUEUE_H
#define NORNSJS_READERWRITERQUEUE_H

#include "concurrentqueue.h"

namespace moodycamel {

template <typename T>
class ReaderWriterQueue : public ConcurrentQueue<T> {
  public:
    ReaderWriterQueue() : ConcurrentQueue<T>(1024) {}
    explicit ReaderWriterQueue(size_t capacity) : ConcurrentQueue<T>(capacity) {}
};

} // namespace moodycamel

#endif
