// norns-js: streaming from disk becomes playing from memory.
//
// WHY NOT JUST BUILD libsndfile. It is the obvious fix and it does not work,
// for a reason that has nothing to do with decoding: **scsynth is a separate
// wasm module with its own MEMFS**, and a script's sound files live in the
// VFS on the main thread. A scsynth that could decode would still have
// nothing to open — and this build's scsynth does not even expose `FS`, so
// there is no way to put a file where it could look.
//
// Even if both of those were solved, the file would have to be written into
// scsynth's memory before the cue, which means it is fully resident — so
// "streaming from disk" would save nothing at all. The whole point of
// `VDiskIn` is not paying for the file in RAM, and here you pay either way.
//
// WHAT HAPPENS INSTEAD. `Buffer.cueSoundFile` loads the WHOLE file through
// the path `NornsJsBufferOverride.sc` already built — the browser decodes
// it, the samples go in with `/b_setn` — and `VDiskIn` and `DiskIn` compile
// to `PlayBuf` over that buffer. Timber's own non-streaming voices are
// already `PlayBuf` on a loaded buffer, so this is the engine's other mode,
// not a new one.
//
// The substitution is exact in the parts that matter:
//
//   * `VDiskIn`'s `rate` and `PlayBuf`'s `rate` are both frames of buffer
//     per frame of output, so a rate computed for one is right for the
//     other. Timber does its own sample-rate arithmetic and hands over a
//     ratio.
//   * `loop` wraps the file for `VDiskIn` and the buffer for `PlayBuf`, and
//     the buffer now holds the whole file, so they are the same wrap.
//   * the cue's `startFrame` is honoured by loading FROM that frame, which
//     is what `Buffer.read` already takes, so `PlayBuf` starting at 0 is
//     starting where the cue asked.
//
// AND WHERE IT IS NOT: at the end of a non-looping file, `VDiskIn` outputs
// silence and `PlayBuf` holds its last frame. Timber gates its voices with
// an envelope, so the held frame is never heard; a script that relied on
// the silence would hear a click.
//
// THE COST IS MEMORY, and it is worth saying out loud: a sample that was
// streamed because it is long is now resident in full. An hour of stereo at
// 48 kHz is about 700 MB and will not load. Timber only streams samples
// over its own length threshold, so the short ones were never affected.
//
// `DiskOut` is NOT overridden. It writes a file, and there is nowhere to
// write one; it stays refused by the SynthDef check with its own message.

+ Buffer {

	*cueSoundFile { arg server, path, startFrame = 0, numChannels = 2, bufferSize = 32768, completionMessage;
		var buf;
		server = server ? Server.default;
		// `numChannels` and `bufferSize` are the cue's ring geometry and have
		// no meaning once the file is resident: the buffer takes the file's
		// own channel count, which is what the caller wanted anyway.
		buf = Buffer.read(server, path, startFrame, -1, { arg b;
			var msg;
			// The completion message is sent AFTER the samples are in, not
			// with the request. On hardware it rides along with `/b_read`
			// and arrives when the read completes; here the read completes
			// in the browser, so this is the same moment by another route.
			msg = completionMessage.value(b);
			if (msg.notNil) { b.server.listSendMsg(msg) };
		});
		^buf
	}
}

+ VDiskIn {

	*ar { arg numChannels, bufnum = 0, rate = 1, loop = 0, sendID = 0;
		^PlayBuf.ar(numChannels, bufnum, rate, 1, 0, loop, 0);
	}
}

+ DiskIn {

	*ar { arg numChannels, bufnum, loop = 0;
		^PlayBuf.ar(numChannels, bufnum, 1, 1, 0, loop, 0);
	}
}
