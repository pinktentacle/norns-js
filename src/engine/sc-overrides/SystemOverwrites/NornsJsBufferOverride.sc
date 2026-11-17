// norns-js: Buffer.read, decoded by the browser instead of by libsndfile.
//
// WHY. scsynth is built `-DNO_LIBSNDFILE`, so `/b_allocRead` answers
// "scsynth compiled without libsndfile" and every `PlayBuf` on the result
// reports "Buffer UGen: no buffer data". Building libsndfile for wasm would
// ship a second decoder to do a worse job than the one already in the page:
// `AudioContext.decodeAudioData` reads WAV, AIFF, FLAC, mp3, ogg and m4a,
// which is MORE than libsndfile gives you, and it resamples to the context's
// rate on the way. E4-11 built exactly this seam for softcut's buffers; this
// is the same seam for scsynth's.
//
// AND THERE IS A SECOND REASON, which libsndfile would not have solved:
// scsynth is a separate wasm module with its own MEMFS. A script's sound
// files live in the VFS this port keeps on the main thread. Even a scsynth
// that could decode would have nothing to open.
//
// HOW. `/b_allocRead` is replaced by a round trip through matron:
//
//   sclang  /norns-js/buffer/read <bufnum> <path> <startFrame> <numFrames>
//   JS      read the file (fetching it if it has not arrived yet),
//           decodeAudioData, /b_alloc, then /b_setn in chunks
//   JS      /norns-js/buffer/done <bufnum> <frames> <channels> <rate>
//   sclang  fill in the Buffer and run its action
//
// The `done` message carries what `/b_query` would have: a caller's action
// reads `buf.numFrames` and `buf.numChannels` and must find them set, which
// is the whole reason `Buffer.read` takes an action rather than returning.
//
// NOT OVERRIDDEN: `cueSoundFile` and `DiskIn`, which stream from disk rather
// than loading. Those need a path scsynth can read from frame to frame, and
// there is not one. A script that reaches for them fails as it did before.

+ Buffer {

	*read { arg server, path, startFrame = 0, numFrames = -1, action, bufnum;
		var buf;
		server = server ? Server.default;
		bufnum ?? { bufnum = server.nextBufferNumber(1) };
		buf = super.newCopyArgs(server, bufnum).doOnInfo_(action).cache;
		buf.path = path;
		buf.startFrame = startFrame;
		Buffer.nornsJsRequest(buf, path, startFrame, numFrames);
		^buf;
	}

	*readChannel { arg server, path, startFrame = 0, numFrames = -1, channels, action, bufnum;
		// The channel list is CARRIED, not dropped. It used to be discarded
		// with a warning, and the warning understated it: Timber loads one
		// channel of a stereo file per sample slot, so getting both doubles
		// the frame stride and the sample plays at half speed — audibly
		// wrong, with no error anywhere to explain it.
		var buf;
		server = server ? Server.default;
		bufnum ?? { bufnum = server.nextBufferNumber(1) };
		buf = super.newCopyArgs(server, bufnum).doOnInfo_(action).cache;
		buf.path = path;
		buf.startFrame = startFrame;
		Buffer.nornsJsRequest(buf, path, startFrame, numFrames, channels);
		^buf;
	}

	*nornsJsRequest { arg buf, path, startFrame, numFrames, channels;
		Buffer.nornsJsListen;
		// `.put` and `.at` written out rather than `[]`: on a method call
		// the index-assignment syntax is a setter call, not a put, and the
		// difference is a silent no-op.
		Buffer.nornsJsPending.put(buf.bufnum, buf);
		// Port 0: this is not going to a socket, it is going to the host.
		// `NornsJsOscPortOverride` wraps anything with a port; here the
		// address is already in the matron-bound set, so it goes direct.
		// The channel list goes on the end as plain integers, so a reader
		// that does not know about it sees the message it always saw.
		buf.server.addr.nornsJsSendMsgDirect(
			*(['/norns-js/buffer/read', buf.bufnum, path.asString, startFrame, numFrames]
				++ (channels ?? []).asArray.collect(_.asInteger))
		);
	}

	*nornsJsListen {
		if (Buffer.nornsJsListening) { ^this };
		Buffer.nornsJsListening = true;
		OSCdef(\nornsJsBufferDone, { arg msg;
			var buf = Buffer.nornsJsPending.at(msg[1]);
			if (buf.notNil) {
				Buffer.nornsJsPending.removeAt(msg[1]);
				if (msg[2] > 0) {
					// `numFrames`, `numChannels` and `sampleRate` have no
					// setters: they are read from a /b_info reply. This is
					// that reply, by another route.
					buf.nornsJsSetInfo(msg[2], msg[3], msg[4]);
					buf.queryDone;
				} {
					("norns-js: " ++ buf.path.asString ++ " did not load").warn;
					// The action still runs. A script that waits for it and
					// never gets it hangs, which is worse than one that
					// finds an empty buffer and says so.
					buf.queryDone;
				};
			};
		}, '/norns-js/buffer/done');
	}

	nornsJsSetInfo { arg frames, channels, rate;
		numFrames = frames;
		numChannels = channels;
		sampleRate = rate;
	}

	// Class-side state, which an extension cannot declare as classvars — so
	// it lives in the class's own environment instead.
	// An extension cannot declare classvars, so the two pieces of class-side
	// state live in Library — SuperCollider's own place for exactly this.
	*nornsJsListening { ^Library.at(\nornsJs, \bufferListening) ? false }
	*nornsJsListening_ { arg v; Library.put(\nornsJs, \bufferListening, v) }
	*nornsJsPending {
		var d = Library.at(\nornsJs, \bufferPending);
		if (d.isNil) { d = IdentityDictionary.new; Library.put(\nornsJs, \bufferPending, d) };
		^d
	}
}
