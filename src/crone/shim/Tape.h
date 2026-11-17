// norns-js: the tape, without libsndfile and without its two disk threads.
//
// This is the one file in the port that is a REWRITE rather than a port, and
// it is worth being plain about why. Upstream's `Tape.h` is ~900 lines, and
// almost all of them exist because of the disk threads: a `SfStream` base
// with a `std::thread` and a condition variable, a JACK ring buffer between
// the audio callback and that thread, pending-open state machines so a path
// can be handed over without blocking, and libsndfile on the far side.
//
// None of that survives contact with a browser. There is no thread to spawn
// in an `AudioWorkletGlobalScope`, and there is no libsndfile — the browser's
// own decoder is better and already there. What is left of Tape once you
// remove the threads and the file format is: **a ring buffer, a channel
// interleave, and a pause flag**. There is no DSP in it. That is the
// difference from softcut, whose fade curves are the whole point and are
// compiled unchanged.
//
// So the threads become the same arrangement as everywhere else in this
// port: a bounded ring, filled or drained by the audio callback, with the
// main thread on the other side doing the part that needs a file.
//
//   record:  MixerClient -> writer.process() -> ring -> JS drains per block
//                                                    -> encodes WAV -> VFS
//   play:    VFS -> JS decodes -> fills ring -> reader.process() -> MixerClient
//
// THE DIVERGENCE THIS LEAVES, stated rather than discovered: if the main
// thread stops servicing the rings — a long synchronous task on the page, a
// tab throttled past the point where its message loop runs — a recording
// drops frames and a playback runs dry. Upstream's disk thread has the same
// failure against a slow disk, but a slow disk is rarer than a busy page.
// Both are counted, and `tape_dropped()` is not zero quietly.

#ifndef CRONE_TAPE_H
#define CRONE_TAPE_H

#include <algorithm>
#include <array>
#include <cstddef>
#include <string>
#include <vector>

namespace crone {

/**
 * A plain ring of interleaved float frames.
 *
 * Not lock-free and not atomic, because producer and consumer are the SAME
 * THREAD here: the audio callback writes it during `process`, and the main
 * thread reaches it only through the worklet's message handler, which runs
 * on the audio thread between blocks. Saying so is the point — a reader who
 * assumes otherwise would add atomics that cost something and prove nothing.
 */
class TapeRing {
  public:
    void setup(size_t frames, int channels) {
        channels_ = channels;
        capacity_ = frames;
        buf_.assign(frames * (size_t)channels, 0.f);
        read_ = write_ = count_ = 0;
        dropped_ = 0;
    }

    void clear() {
        read_ = write_ = count_ = 0;
    }

    size_t available() const { return count_; }
    size_t space() const { return capacity_ - count_; }
    size_t dropped() const { return dropped_; }

    /** Push `n` interleaved frames. Drops, and counts, when full. */
    void push(const float *src, size_t n) {
        for (size_t i = 0; i < n; ++i) {
            if (count_ == capacity_) {
                dropped_ += n - i;
                return;
            }
            for (int c = 0; c < channels_; ++c) buf_[write_ * (size_t)channels_ + (size_t)c] = src[i * (size_t)channels_ + (size_t)c];
            write_ = (write_ + 1) % capacity_;
            count_++;
        }
    }

    /** Pop up to `n` frames. Returns how many came out. */
    size_t pop(float *dst, size_t n) {
        size_t got = 0;
        while (got < n && count_ > 0) {
            for (int c = 0; c < channels_; ++c) dst[got * (size_t)channels_ + (size_t)c] = buf_[read_ * (size_t)channels_ + (size_t)c];
            read_ = (read_ + 1) % capacity_;
            count_--;
            got++;
        }
        return got;
    }

  private:
    std::vector<float> buf_;
    size_t capacity_ = 0;
    size_t read_ = 0, write_ = 0, count_ = 0;
    size_t dropped_ = 0;
    int channels_ = 2;
};

template <int NumChannels> class Tape {
  public:
    /**
     * Four seconds each way.
     *
     * The record ring only has to cover the gap between two drains, which is
     * one render quantum when the page is healthy. Four seconds is the
     * margin for a page that stalls — long enough to survive a garbage
     * collection or a layout, short enough that 1.5 MB is not worth
     * arguing about. The play ring is the same so a stall does not run it
     * dry before the record ring overflows; a tape that silently goes quiet
     * is harder to notice than one that drops frames and says so.
     */
    static constexpr size_t RingFrames = 4 * 48000;

    class Writer {
      public:
        void setup() { ring.setup(RingFrames, NumChannels); }

        /** Upstream opens the file here; here the path is only remembered. */
        void open(const std::string &path) {
            path_ = path;
            hasFile_ = true;
            frames_ = 0;
            ring.clear();
        }

        void start() {
            if (!hasFile_) return;
            running_ = true;
        }

        void stop() {
            running_ = false;
            hasFile_ = false;
            // `finished_` is what tells the main thread to encode what it
            // has drained. It is NOT cleared here: the drain that follows
            // the last block still has frames to collect.
            finished_ = true;
        }

        void pause(bool p) { paused_ = p; }
        bool isPaused() const { return paused_; }
        bool isRunning() const { return running_; }
        bool hasFile() const { return hasFile_; }
        bool takeFinished() {
            bool f = finished_;
            finished_ = false;
            return f;
        }
        size_t frames() const { return frames_; }
        const std::string &path() const { return path_; }

        /** Interleave one block into the ring. Audio thread. */
        void process(const float *src[NumChannels], size_t numFrames) {
            if (!running_ || paused_) return;
            float tmp[256 * NumChannels];
            size_t at = 0;
            while (at < numFrames) {
                const size_t n = std::min<size_t>(256, numFrames - at);
                for (size_t i = 0; i < n; ++i) {
                    for (int c = 0; c < NumChannels; ++c) tmp[i * NumChannels + c] = src[c][at + i];
                }
                ring.push(tmp, n);
                at += n;
            }
            frames_ += numFrames;
        }

        TapeRing ring;

      private:
        std::string path_;
        size_t frames_ = 0;
        bool hasFile_ = false, running_ = false, paused_ = false, finished_ = false;
    };

    class Reader {
      public:
        void setup() { ring.setup(RingFrames, NumChannels); }

        /** The main thread has already decoded; this records what it said. */
        void open(const std::string &path) {
            path_ = path;
            hasFile_ = true;
            processed_ = 0;
            ring.clear();
        }

        void start() {
            if (!hasFile_) return;
            running_ = true;
        }
        void stop() {
            running_ = false;
            hasFile_ = false;
            ring.clear();
        }
        void pause(bool p) { paused_ = p; }

        bool isPaused() const { return paused_; }
        bool isRunning() const { return running_; }
        bool hasFile() const { return hasFile_; }
        /** Enough buffered to start without a gap. */
        bool isPrimed() const { return ring.available() > 2048; }
        size_t framesProcessed() const { return processed_; }
        size_t framesTotal() const { return total_; }
        float fileSampleRate() const { return fileRate_; }
        void setFile(size_t total, float rate) {
            total_ = total;
            fileRate_ = rate;
        }

        /** Deinterleave one block out of the ring. Audio thread. */
        void process(float *dst[NumChannels], size_t numFrames) {
            if (!running_ || paused_) return;
            float tmp[256 * NumChannels];
            size_t at = 0;
            while (at < numFrames) {
                const size_t n = std::min<size_t>(256, numFrames - at);
                const size_t got = ring.pop(tmp, n);
                for (size_t i = 0; i < got; ++i) {
                    for (int c = 0; c < NumChannels; ++c) dst[c][at + i] = tmp[i * NumChannels + c];
                }
                // A ring that ran dry is SILENCE, not the previous block
                // again. The second is what a stale buffer gives you and it
                // sounds like a stuck loop rather than like a stall.
                for (size_t i = got; i < n; ++i) {
                    for (int c = 0; c < NumChannels; ++c) dst[c][at + i] = 0.f;
                }
                if (got < n) underruns_ += n - got;
                at += n;
                processed_ += got;
            }
        }

        size_t underruns() const { return underruns_; }
        const std::string &path() const { return path_; }

        TapeRing ring;

      private:
        std::string path_;
        size_t processed_ = 0, total_ = 0, underruns_ = 0;
        float fileRate_ = 0;
        bool hasFile_ = false, running_ = false, paused_ = false;
    };

    Tape() {
        writer.setup();
        reader.setup();
        live_() = this;
    }

    /**
     * The one live tape, for the entry points JS calls.
     *
     * `MixerClient::tape` is private and the public methods upstream exposes
     * are the transport controls, not the buffers — and the buffers are
     * exactly what has to cross to the main thread here. The alternative was
     * a second round of surgery on a staged upstream header; a static
     * pointer set in the constructor is smaller and says what it is. There
     * is exactly one `Tape<2>` in the program, inside the one MixerClient.
     */
    static Tape *live() { return live_(); }

    void clear() {
        writer.stop();
        reader.stop();
        writer.takeFinished();
    }

    void setSampleRate(float sr) { sampleRate_ = sr; }
    float getSampleRate() const { return sampleRate_; }

    void setLooping(bool l) { looping_ = l; }
    bool isLooping() const { return looping_; }

    void pauseRecord(bool p) { writer.pause(p); }
    void pausePlayback(bool p) { reader.pause(p); }
    bool recordIsPaused() const { return writer.isPaused(); }
    bool playbackIsPaused() const { return reader.isPaused(); }

    bool isWriting() const { return writer.isRunning(); }
    bool isReading() const { return reader.isRunning(); }
    bool recordHasFile() const { return writer.hasFile(); }
    bool playbackHasFile() const { return reader.hasFile(); }
    bool playbackIsPrimed() const { return reader.isPrimed(); }

    size_t recordFramesCaptured() const { return writer.frames(); }
    size_t playbackFramesProcessed() const { return reader.framesProcessed(); }
    size_t playbackFramesTotal() const { return reader.framesTotal(); }
    float playbackFileSampleRate() const { return reader.fileSampleRate(); }

    Writer writer;
    Reader reader;

  private:
    static Tape *&live_() {
        static Tape *t = nullptr;
        return t;
    }

    float sampleRate_ = 48000.f;
    bool looping_ = false;
};

} // namespace crone

#endif // CRONE_TAPE_H
