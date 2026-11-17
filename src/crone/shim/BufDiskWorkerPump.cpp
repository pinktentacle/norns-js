// norns-js: BufDiskWorker's thread, replaced by a pump in the render
// callback — and nothing else about it changed.
//
// Upstream `init()` starts a `std::thread` running `workLoop()`, which waits
// on a condition variable and runs whole jobs. An AudioWorkletGlobalScope
// cannot spawn a thread, which is the obvious problem; the one that matters
// more is that `workLoop` is private and infinite, so there is no way to ask
// it for one job.
//
// WHAT IS NOT REIMPLEMENTED HERE. `clearBuffer`, `clearBufferWithFade`,
// `copyBuffer`, `readBufferMono`, `readBufferStereo`, `writeBufferMono`,
// `writeBufferStereo` and `render` are upstream's, compiled unchanged. They
// are worth keeping: `raisedCosFade` and `mixFade` are what a softcut buffer
// copy sounds like at its seams, and a plausible reimplementation would be
// audibly wrong in a way nobody would think to check.
//
// So this file is the dispatch out of `workLoop`'s switch, plus two things
// upstream does not need:
//
// THE FRAME BUDGET. A full `buffer_clear` is 2 x 2^24 frames — 33.5 million
// float stores, tens of milliseconds. Upstream pays that on a background
// thread and nobody hears it. Here the only thread is the audio one, so a
// whole clear in one block is a dropout. `Clear` is split: it is a range,
// and clearing [a,b) then [b,c) is exactly clearing [a,c).
//
// WHAT IS NOT SPLIT, and why: `ClearWithFade` and `Copy` fade their edges, so
// chunking them would apply a fade at every chunk boundary — a comb of
// ramps through the middle of the buffer. `Read`, `Write` and `Render` are
// bounded by what the script asked for, which is seconds, not minutes. Those
// run whole, and a long one costs a dropout. That is a real divergence from
// hardware and it is in research/crone-port.md.

#include "BufDiskWorker.h"

#include <emscripten.h>

namespace {
/**
 * Whether a job is half-done.
 *
 * At namespace scope rather than beside `current` below, because
 * `nornsjsPending` has to see it: a queue of zero with a clear still running
 * is not "finished", and a caller that waits on the queue alone would
 * measure a buffer that is half cleared.
 */
bool busy = false;
} // namespace

namespace crone {

void BufDiskWorker::nornsjsSetup(int sr) {
    sampleRate = sr;
    // Deliberately NOT `init(sr)`: that starts the thread.
}

bool BufDiskWorker::nornsjsRunJob(int frameBudget) {
    // The job in progress, and how much of it is left. Static locals inside
    // a member function, because `Job` is a private nested type and this is
    // the only place that can name it.
    static Job current;
    static float remainingStart = 0; // for a split Clear, in seconds
    static float remainingDur = 0;

    if (!busy) {
        if (jobQ.empty()) return false;
        current = jobQ.front();
        jobQ.pop();
        busy = true;
        remainingStart = current.startDst;
        remainingDur = current.dur;
        if (current.type == JobType::Clear) {
            // `dur < 0` means "to the end of the buffer". Resolve it now, so
            // the split has a length to work with.
            const BufDesc &b = bufs[current.bufIdx[0]];
            const float bufDur = sampleRate > 0 ? (float)b.frames / (float)sampleRate : 0.f;
            if (remainingDur < 0) remainingDur = bufDur - remainingStart;
            if (remainingStart < 0) remainingStart = 0;
        }
    }

    switch (current.type) {
    case JobType::Clear: {
        const float budgetSec = sampleRate > 0 ? (float)frameBudget / (float)sampleRate : remainingDur;
        const float chunk = remainingDur > budgetSec ? budgetSec : remainingDur;
        clearBuffer(bufs[current.bufIdx[0]], remainingStart, chunk);
        remainingStart += chunk;
        remainingDur -= chunk;
        // Floating point: stop on "no useful amount left" rather than on
        // exactly zero, or a clear ends with a few thousand one-frame jobs.
        if (remainingDur > 1e-4f) return true;
        break;
    }
    case JobType::ClearWithFade:
        clearBufferWithFade(bufs[current.bufIdx[0]], current.startDst, current.dur, current.fadeTime,
                            current.preserve);
        break;
    case JobType::Copy:
        copyBuffer(bufs[current.bufIdx[0]], bufs[current.bufIdx[1]], current.startSrc, current.startDst,
                   current.dur, current.fadeTime, current.preserve, current.reverse);
        break;
    case JobType::ReadMono:
        readBufferMono(current.path, bufs[current.bufIdx[0]], current.startSrc, current.startDst,
                       current.dur, current.chan, current.preserve, current.mix);
        break;
    case JobType::ReadStereo:
        readBufferStereo(current.path, bufs[current.bufIdx[0]], bufs[current.bufIdx[1]], current.startSrc,
                         current.startDst, current.dur, current.preserve, current.mix);
        break;
    case JobType::WriteMono:
        writeBufferMono(current.path, bufs[current.bufIdx[0]], current.startSrc, current.dur);
        break;
    case JobType::WriteStereo:
        writeBufferStereo(current.path, bufs[current.bufIdx[0]], bufs[current.bufIdx[1]], current.startSrc,
                          current.dur);
        break;
    case JobType::Render:
        render(bufs[current.bufIdx[0]], current.startSrc, current.dur, (size_t)current.samples,
               current.renderCallback);
        break;
    }

    busy = false;
    return !jobQ.empty();
}

size_t BufDiskWorker::nornsjsPending() {
    return jobQ.size() + (busy ? 1u : 0u);
}

} // namespace crone
