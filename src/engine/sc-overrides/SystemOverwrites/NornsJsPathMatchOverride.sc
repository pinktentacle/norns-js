// norns-js E9-232: String:pathMatch, for the tree that is not in sclang's
// filesystem.
//
// `File.exists` and `SoundFile.openRead` already answer from the sound-file
// table the host writes at boot (NornsJsFileExistsOverride.sc,
// NornsJsSoundFileOverride.sc). A FOLDER could still not be listed: sclang's
// filesystem holds the class library and nothing else, so `PathName(dir)
// .entries`, `.files`, `.folders`, `.isFolder` and a glob like
// `(dir ++ "*.wav").pathMatch` came back empty for every sound folder in
// the dust tree.
//
// `pitter-patter`'s engine finds an mx.samples instrument by listing its
// folder and reading the note out of each file name. The list was empty,
// the closest note was nil, and every note was `60 < nil` — "Nil does not
// understand the message '<'" — with cello_pad sitting right there.
//
// All of PathName's listing goes through this one primitive, so this is
// the one place to answer: the real filesystem FIRST (so it can only turn
// an empty answer into a full one), then the table, for paths under
// `~/dust`. A folder is any path a known file sits below. What the table
// does not hold — a sound file added after boot, a non-WAV the page could
// not read a header from — is not listed, as before.

+ String {

	// The primitive, under a name the override can still reach (see
	// `File.nornsJsExistsReal`: a primitive is bound by its body).
	nornsJsPathMatchReal {
		_StringPathMatch
		^this.primitiveFailed
	}

	pathMatch {
		var real = this.nornsJsPathMatchReal;
		if (real.notEmpty) { ^real };
		// Not before `Library` exists: the table is cached there, and class
		// initialisation asks the filesystem before it does.
		if (Library.global.isNil) { ^real };
		^(SoundFile.nornsJsMatch(this) ? real)
	}
}

+ SoundFile {

	// A glob over the table: the files and folders directly inside one
	// folder whose names match the last segment. Nil when it is not about
	// `~/dust` or nothing matches.
	*nornsJsMatch { arg pattern;
		var table = SoundFile.nornsJsTable;
		var wantFolder = pattern.asString.last == $/;
		var tidy, cut, dir, leaf, rx, out;
		if (table.isNil) { ^nil };
		tidy = SoundFile.nornsJsTidy(pattern);
		if (tidy.beginsWith("/home/we/dust/").not) { ^nil };
		cut = tidy.findBackwards("/");
		if (cut.isNil or: { cut < 1 }) { ^nil };
		dir = tidy.copyFromStart(cut - 1);
		leaf = tidy.copyToEnd(cut + 1);
		rx = "^";
		leaf.do { arg c;
			var piece = case
				{ c == $* } { "[^/]*" }
				{ c == $? } { "[^/]" }
				{ "\\^$.|+()[]{}".includes(c) } { "\\" ++ c.asString }
				{ c.asString };
			rx = rx ++ piece;
		};
		rx = rx ++ "$";
		out = Set.new;
		table.keysDo { arg k;
			var s = k.asString, rest, i, child, name;
			if (s.beginsWith(dir ++ "/")) {
				rest = s.copyToEnd(dir.size + 1);
				i = rest.indexOf($/);
				child = if (i.isNil) { rest } { rest.copyFromStart(i - 1) ++ "/" };
				name = if (child.last == $/) { child.drop(-1) } { child };
				// The receiver of `matchRegexp` is the expression.
				if (rx.matchRegexp(name) and: { wantFolder.not or: { child.last == $/ } }) {
					out.add(dir ++ "/" ++ child);
				};
			};
		};
		if (out.isEmpty) { ^nil };
		^out.asArray.sort
	}
}
