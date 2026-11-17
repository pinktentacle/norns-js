// norns-js: libsndfile's C++ handle, backed by PCM that JavaScript supplies.
//
// WHY NOT COMPILE LIBSNDFILE. A browser already has a decoder for every
// format it supports — `AudioContext.decodeAudioData` handles WAV, AIFF,
// FLAC, mp3, ogg and m4a — and shipping libsndfile to wasm would be a second
// decoder doing a worse job of a subset. So decoding and encoding stay in
// JavaScript and this header is the seam.
//
// HOW THE SEAM WORKS. A read is in two steps, because `readf` is synchronous
// and the audio thread cannot wait for a file:
//
//   1. the main thread reads the bytes out of the VFS, decodes them, and
//      pushes the frames it needs into the registry below, under the path;
//   2. the worklet runs upstream's `readBufferMono` unchanged, and this
//      handle serves it from memory.
//
// A write is the same in reverse: upstream's `writeBufferMono` fills a
// buffer here, and when it closes, the main thread takes the frames and
// encodes a WAV into the VFS.
//
// ONLY A WINDOW IS RESIDENT. `frames()` reports the file's TRUE length,
// because `readBufferMono` clamps against it — `clamp(frSrc, frames() - 1)`
// and `maxDurSrc = frames() - frSrc`. The resident range starts at
// `firstFrame`, which is where the caller asked to start. A seek outside it
// fails rather than returning the wrong audio, which would be a sample
// loaded from the wrong place in the file and nothing to say so.

#ifndef NORNSJS_SNDFILE_HH
#define NORNSJS_SNDFILE_HH

#include <cstddef>
#include <string>
#include <vector>

#include "sndfile.h"

namespace cronejs {

/** One file's resident PCM, interleaved. */
struct SoundFile {
    std::string path;
    std::vector<float> samples; // interleaved, `channels` per frame
    int channels = 0;
    int sampleRate = 0;
    int format = 0;
    /** The file's real length in frames, which may exceed what is resident. */
    long long totalFrames = 0;
    /** Which file frame `samples[0]` is. */
    long long firstFrame = 0;
    bool openForWrite = false;
    /** A write that has been closed: the main thread may take it. */
    bool finished = false;
};

/**
 * The registry. One map, on the audio thread, touched only between blocks —
 * the main thread reaches it through the `cronejs_file_*` entry points in
 * worklet.cpp, which run in the worklet's message handler.
 */
SoundFile *fileFind(const std::string &path);
SoundFile *filePreload(const std::string &path, int channels, int sampleRate, long long totalFrames,
                       long long firstFrame, long long residentFrames);
SoundFile *fileBeginWrite(const std::string &path, int channels, int sampleRate, int format);
void fileDrop(const std::string &path);
/** The next closed write waiting to be taken, or nullptr. */
SoundFile *fileNextFinished();
/** How many bytes of PCM the registry is holding. */
size_t fileResidentBytes();
/** crone's real sample rate, for the files it writes. See sndfile.cpp. */
void setEngineRate(int sr);

} // namespace cronejs

/**
 * libsndfile's `SndfileHandle`, reduced to what crone actually calls:
 * the two constructors, `frames`, `channels`, `samplerate`, `seek`, `readf`,
 * `writef`, `error` and `command`.
 */
class SndfileHandle {
  public:
    /** Open for reading. A path with nothing preloaded reads as 0 frames. */
    explicit SndfileHandle(const std::string &path) : file_(cronejs::fileFind(path)) { rewind(); }
    explicit SndfileHandle(const char *path) : file_(cronejs::fileFind(path ? path : "")) { rewind(); }

    /** Open for writing. Both spellings, because upstream uses both. */
    SndfileHandle(const std::string &path, int mode, int format, int channels, int samplerate) {
        open(path, mode, format, channels, samplerate);
    }
    SndfileHandle(const char *path, int mode, int format, int channels, int samplerate) {
        open(path ? path : "", mode, format, channels, samplerate);
    }

    /**
     * libsndfile's handle is contextually convertible to bool, and crone
     * relies on it: `if (not file) { ... }` is how every one of these guards
     * a failed open. Without the conversion the failure path never compiles;
     * with the WRONG sense it never runs, and a missing file reads as
     * silence into the buffer.
     */
    explicit operator bool() const { return file_ != nullptr; }

    ~SndfileHandle() {
        // Closing a write is what makes it visible to the main thread. A
        // handle that goes out of scope without this leaves a recording
        // nobody can collect.
        if (file_ != nullptr && file_->openForWrite) {
            file_->openForWrite = false;
            file_->finished = true;
        }
    }

    SndfileHandle(const SndfileHandle &) = delete;
    SndfileHandle &operator=(const SndfileHandle &) = delete;

    /** The file's real length, not the resident window. */
    long long frames() const { return file_ == nullptr ? 0 : file_->totalFrames; }
    int channels() const { return file_ == nullptr ? 0 : file_->channels; }
    int samplerate() const { return file_ == nullptr ? 0 : file_->sampleRate; }
    int format() const { return file_ == nullptr ? 0 : file_->format; }

    /** 0 is libsndfile's "no error"; anything else stops the caller. */
    int error() const { return file_ == nullptr ? 1 : 0; }

    /** `SFC_SET_CLIPPING` is the only one crone sends; clipping is JS's job. */
    int command(int, void *, int) { return 0; }

    long long seek(long long frames, int whence) {
        if (file_ == nullptr) return -1;
        long long target = whence == SF_SEEK_SET ? frames : pos_ + frames;
        long long resident = residentFrames();
        if (target < file_->firstFrame || target > file_->firstFrame + resident) {
            // Outside what the main thread preloaded. Returning -1 is what
            // libsndfile does for a seek past the end, and `readBufferMono`
            // checks it.
            return -1;
        }
        pos_ = target;
        return pos_;
    }

    long long readf(float *dst, long long frames) {
        if (file_ == nullptr || file_->channels == 0) return 0;
        long long resident = residentFrames();
        long long avail = file_->firstFrame + resident - pos_;
        if (avail <= 0) return 0;
        long long n = frames < avail ? frames : avail;
        const long long off = (pos_ - file_->firstFrame) * file_->channels;
        for (long long i = 0; i < n * file_->channels; ++i) dst[i] = file_->samples[(size_t)(off + i)];
        pos_ += n;
        return n;
    }

    /**
     * libsndfile's `read` counts ITEMS (samples), not frames; `readf` counts
     * frames. crone uses both, one line apart, and calls `read(ioBuf,
     * numSrcChan)` to fetch exactly one frame. Treating items as frames
     * there would read `channels` times too much and advance the position
     * `channels` times too far — a sample loaded at the wrong speed, from
     * the wrong place, with nothing to say so.
     */
    long long read(float *dst, long long items) {
        if (file_ == nullptr || file_->channels == 0) return 0;
        const long long frames = items / file_->channels;
        return readf(dst, frames) * file_->channels;
    }

    long long writef(const float *src, long long frames) {
        if (file_ == nullptr || !file_->openForWrite) return 0;
        const size_t at = file_->samples.size();
        file_->samples.resize(at + (size_t)(frames * file_->channels));
        for (long long i = 0; i < frames * file_->channels; ++i) file_->samples[at + (size_t)i] = src[i];
        file_->totalFrames += frames;
        return frames;
    }

  private:
    /**
     * Start at the first RESIDENT frame, not at frame 0.
     *
     * Only a window of the file is here, and it starts where the caller
     * asked to read from. Starting at 0 would put the position outside the
     * window on every file read from anywhere but the beginning — and
     * upstream seeks before reading anyway, so this only matters for the
     * read that does not.
     */
    void rewind() { pos_ = file_ == nullptr ? 0 : file_->firstFrame; }

    void open(const std::string &path, int mode, int format, int channels, int samplerate) {
        file_ = mode == SFM_WRITE ? cronejs::fileBeginWrite(path, channels, samplerate, format)
                                  : cronejs::fileFind(path);
        rewind();
    }

    long long residentFrames() const {
        return file_->channels == 0 ? 0 : (long long)(file_->samples.size() / (size_t)file_->channels);
    }

    cronejs::SoundFile *file_ = nullptr;
    long long pos_ = 0;
};

#endif
