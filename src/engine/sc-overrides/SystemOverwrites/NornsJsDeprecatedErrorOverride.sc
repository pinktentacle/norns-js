// norns-js: a deprecated method keeps working, as it does on a norns.
//
// E9-263 — WHAT BROKE. `phonotype` made no sound. Every engine command it
// has goes through `msg[1].asInt`, and `asInt` has been deprecated since
// SuperCollider 3.11 (`deprecated/3.11/deprecated-3.11.sc`):
//
//     asInt {
//         this.deprecated(thisMethod, this.class.findMethod(\asInteger));
//         ^this.asInteger;
//     }
//
// `Integer.findMethod(\asInteger)` is nil — `findMethod` looks in that one
// class, and `asInteger` lives further up. The SuperCollider this build
// pins builds the warning with `alternateMethod.ownerClass.name` and no
// check, so the WARNING throws "Nil does not understand the message
// 'ownerClass'", the command handler is abandoned, and `set_param` never
// reaches the synth. On a norns (3.13) the same call prints a deprecation
// warning and returns the integer.
//
// And behind that, a second one: the pinned `throw` calls `reportError`
// without ever taking a backtrace, so the report itself fails, the guard in
// `Exception.new` prints "Attempting to construct and error while reporting
// one" and HALTS the thread — the handler is abandoned all the same.
//
// WHAT THIS DOES. Builds the same error with or without an alternative,
// and says it as a one-line warning, once per method rather than on every
// call: an engine that calls `asInt` in a command handler would otherwise
// print it for every encoder detent. Then returns, as 3.13 does.

+ DeprecatedError {

	*new { |receiver, method, alternateMethod|
		var thisThrow = this.class.findMethod(\throw);
		var nameOf = { |m|
			if(m.isNil) { "?" } {
				"%-%".format(if(m.ownerClass.isNil) { "?" } { m.ownerClass.name }, m.name)
			}
		};
		^super.new(
			what: if(alternateMethod.isNil) {
				"The method '%' is deprecated.".format(nameOf.(method))
			} {
				"The method '%' is deprecated, instead use '%'.".format(nameOf.(method), nameOf.(alternateMethod))
			},
			callFrameAnnotations: if(alternateMethod.isNil) { [] } {
				["Replace this with '*.%".format(alternateMethod.name)]
			},
			receiver: receiver,
			methodBeforeBacktraceStart: { |m| m === thisThrow or: { m == method } },
		)
			.method_(method)
			.alternateMethod_(alternateMethod)
	}

	throw {
		var said = Library.at(\nornsJs, \deprecationsSaid);
		if(said.isNil) {
			said = Set.new;
			Library.put(\nornsJs, \deprecationsSaid, said);
		};
		if(said.includes(this.what).not) {
			said.add(this.what);
			("WARNING: " ++ this.what).postln;
		};
		if (Error.debug) { this.halt }
	}
}
