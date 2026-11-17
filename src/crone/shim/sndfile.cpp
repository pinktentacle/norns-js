// The file registry behind shim/sndfile.hh, and the entry points the main
// thread uses to fill and empty it.
//
// Everything here runs on the audio thread: the registry is touched by
// `SndfileHandle` from inside a disk job, and by the `cronejs_file_*`
// functions from the worklet's message handler, which is the same thread
// between two render blocks. So there is no lock, and there must not be one.
//
// It does allocate. That is unavoidable — the whole point is to hold PCM
// that arrived from somewhere else — but it never allocates while a block is
// rendering: a preload is a message, and a disk job only ever appends to a
// buffer that was sized by one.

#include "sndfile.hh"

#include <algorithm>
#include <map>

#include <emscripten.h>

namespace cronejs {

namespace {

std::map<std::string, SoundFile> &registry() {
    // Function-local, so it is constructed on first use rather than racing
    // crone's own globals.
    static std::map<std::string, SoundFile> r;
    return r;
}

} // namespace

SoundFile *fileFind(const std::string &path) {
    auto it = registry().find(path);
    if (it == registry().end()) return nullptr;
    // A write that is still open is not readable: handing its half-filled
    // buffer to a reader would return a recording that is shorter than it
    // will be, which looks like a truncated file.
    if (it->second.openForWrite) return nullptr;
    return &it->second;
}

SoundFile *filePreload(const std::string &path, int channels, int sampleRate, long long totalFrames,
                       long long firstFrame, long long residentFrames) {
    SoundFile &f = registry()[path];
    f.path = path;
    f.channels = channels;
    f.sampleRate = sampleRate;
    f.totalFrames = totalFrames;
    f.firstFrame = firstFrame;
    f.openForWrite = false;
    f.finished = false;
    f.samples.assign((size_t)(residentFrames * channels), 0.f);
    return &f;
}

namespace {
/** crone's actual rate, which is the AudioContext's. 0 until init. */
int engineRate = 0;
} // namespace

void setEngineRate(int sr) {
    engineRate = sr;
}

SoundFile *fileBeginWrite(const std::string &path, int channels, int sampleRate, int format) {
    SoundFile &f = registry()[path];
    f.path = path;
    f.channels = channels;
    // THE RATE libsndfile IS TOLD IS IGNORED, and this is not a liberty.
    // `BufDiskWorker.cpp:447` and `:498` are both `const int sr = 48000;` —
    // hardcoded, because norns' hardware engine is always 48 kHz and the
    // constant is correct there. A browser's AudioContext is whatever the
    // output device is, which on this machine is 44100. Writing the
    // buffer's samples with a header that says 48000 produces a file that
    // plays 8.8% fast and 8.8% short, and nothing anywhere says so: it was
    // measured as a one-second write decoding back as 40516 frames.
    //
    // So the file is labelled with the rate the samples are actually at.
    f.sampleRate = engineRate > 0 ? engineRate : sampleRate;
    f.format = format;
    f.totalFrames = 0;
    f.firstFrame = 0;
    f.openForWrite = true;
    f.finished = false;
    f.samples.clear();
    return &f;
}

void fileDrop(const std::string &path) {
    registry().erase(path);
}

SoundFile *fileNextFinished() {
    for (auto &entry : registry()) {
        if (entry.second.finished) return &entry.second;
    }
    return nullptr;
}

size_t fileResidentBytes() {
    size_t total = 0;
    for (const auto &entry : registry()) total += entry.second.samples.size() * sizeof(float);
    return total;
}

} // namespace cronejs

extern "C" {

/**
 * Make room for a file the main thread is about to copy in.
 *
 * Returns a pointer into the wasm heap for `residentFrames * channels`
 * floats, interleaved, or 0 if the allocation would be unreasonable.
 *
 * THE CAP IS NOT ARBITRARY and it is not a safety blanket. This build has
 * `ALLOW_MEMORY_GROWTH` off (ADR-04e: growth detaches every view, and this
 * runs in an audio callback), so the heap is 320 MB and softcut's two
 * buffers are 134 MB of it. A full-buffer `buffer_read_mono` would ask for
 * another 134 MB of PCM on top — 349 seconds per channel is what softcut
 * holds — and the allocation would fail somewhere less convenient than here.
 * 96 MB is about 8 minutes of stereo at 48 kHz, which is longer than
 * anything a script loads into softcut.
 */
EMSCRIPTEN_KEEPALIVE float *cronejs_file_preload(const char *path, int channels, int sampleRate,
                                                 double totalFrames, double firstFrame,
                                                 double residentFrames) {
    constexpr double MAX_BYTES = 96.0 * 1024 * 1024;
    if (channels < 1 || residentFrames < 0) return nullptr;
    if (residentFrames * channels * 4.0 > MAX_BYTES) return nullptr;
    auto *f = cronejs::filePreload(path, channels, sampleRate, (long long)totalFrames,
                                   (long long)firstFrame, (long long)residentFrames);
    return f->samples.empty() ? nullptr : f->samples.data();
}

/** The path of the next closed write, or an empty string. */
EMSCRIPTEN_KEEPALIVE const char *cronejs_file_finished() {
    auto *f = cronejs::fileNextFinished();
    return f == nullptr ? "" : f->path.c_str();
}

EMSCRIPTEN_KEEPALIVE float *cronejs_file_data(const char *path) {
    auto it = cronejs::fileFind(path);
    return it == nullptr || it->samples.empty() ? nullptr : it->samples.data();
}
EMSCRIPTEN_KEEPALIVE double cronejs_file_frames(const char *path) {
    auto it = cronejs::fileFind(path);
    return it == nullptr ? 0 : (double)it->totalFrames;
}
EMSCRIPTEN_KEEPALIVE int cronejs_file_channels(const char *path) {
    auto it = cronejs::fileFind(path);
    return it == nullptr ? 0 : it->channels;
}
EMSCRIPTEN_KEEPALIVE int cronejs_file_rate(const char *path) {
    auto it = cronejs::fileFind(path);
    return it == nullptr ? 0 : it->sampleRate;
}
/** The libsndfile format word crone asked for; JS encodes to match. */
EMSCRIPTEN_KEEPALIVE int cronejs_file_format(const char *path) {
    auto it = cronejs::fileFind(path);
    return it == nullptr ? 0 : it->format;
}

EMSCRIPTEN_KEEPALIVE void cronejs_file_drop(const char *path) {
    cronejs::fileDrop(path);
}

/** For the memory report: PCM held here is heap softcut cannot have. */
EMSCRIPTEN_KEEPALIVE void cronejs_set_engine_rate(int sr) {
    cronejs::setEngineRate(sr);
}

EMSCRIPTEN_KEEPALIVE double cronejs_file_bytes() {
    return (double)cronejs::fileResidentBytes();
}

} // extern "C"
