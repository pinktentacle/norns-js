// norns-js: JACK's lock-free ring buffer, reimplemented.
//
// `Tape.h` is the only file in crone that uses it, and Tape is not compiled
// into this build yet (E4-11) — but `MixerClient.h:61` declares a `Tape<2>`
// MEMBER, so the header has to compile even though nothing drives it.
//
// Implemented rather than stubbed because a stub that returned 0 from
// `write_space` would make Tape silently drop everything if it ever did run,
// and that is the sort of thing that looks like a tape bug for a week. This
// is the same single-producer/single-consumer ring as everywhere else here:
// bounded, no allocation after construction, Atomics on the indices only.
#ifndef NORNSJS_JACK_RINGBUFFER_H
#define NORNSJS_JACK_RINGBUFFER_H

#include <atomic>
#include <cstdlib>
#include <cstring>

typedef struct jack_ringbuffer_t {
    char *buf;
    size_t size;
    std::atomic<size_t> read_ptr;
    std::atomic<size_t> write_ptr;
} jack_ringbuffer_t;

static inline jack_ringbuffer_t *jack_ringbuffer_create(size_t sz) {
    auto *rb = static_cast<jack_ringbuffer_t *>(std::malloc(sizeof(jack_ringbuffer_t)));
    if (rb == nullptr) return nullptr;
    rb->size = sz + 1; // one slot kept free to tell full from empty
    rb->buf = static_cast<char *>(std::malloc(rb->size));
    new (&rb->read_ptr) std::atomic<size_t>(0);
    new (&rb->write_ptr) std::atomic<size_t>(0);
    return rb;
}

static inline void jack_ringbuffer_free(jack_ringbuffer_t *rb) {
    if (rb == nullptr) return;
    std::free(rb->buf);
    std::free(rb);
}

static inline void jack_ringbuffer_reset(jack_ringbuffer_t *rb) {
    rb->read_ptr.store(0, std::memory_order_relaxed);
    rb->write_ptr.store(0, std::memory_order_relaxed);
}

static inline size_t jack_ringbuffer_read_space(const jack_ringbuffer_t *rb) {
    const size_t w = rb->write_ptr.load(std::memory_order_acquire);
    const size_t r = rb->read_ptr.load(std::memory_order_relaxed);
    return (w + rb->size - r) % rb->size;
}

static inline size_t jack_ringbuffer_write_space(const jack_ringbuffer_t *rb) {
    return rb->size - 1 - jack_ringbuffer_read_space(rb);
}

static inline size_t jack_ringbuffer_read(jack_ringbuffer_t *rb, char *dest, size_t cnt) {
    const size_t avail = jack_ringbuffer_read_space(rb);
    const size_t n = cnt < avail ? cnt : avail;
    size_t r = rb->read_ptr.load(std::memory_order_relaxed);
    for (size_t i = 0; i < n; ++i) {
        dest[i] = rb->buf[r];
        r = (r + 1) % rb->size;
    }
    rb->read_ptr.store(r, std::memory_order_release);
    return n;
}

static inline size_t jack_ringbuffer_write(jack_ringbuffer_t *rb, const char *src, size_t cnt) {
    const size_t space = jack_ringbuffer_write_space(rb);
    const size_t n = cnt < space ? cnt : space;
    size_t w = rb->write_ptr.load(std::memory_order_relaxed);
    for (size_t i = 0; i < n; ++i) {
        rb->buf[w] = src[i];
        w = (w + 1) % rb->size;
    }
    rb->write_ptr.store(w, std::memory_order_release);
    return n;
}

#endif
