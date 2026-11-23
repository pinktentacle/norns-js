// E9-163 — the floor under every key you press.
//
// The user's first priority for this project is sound: fidelity, and no
// delay between a gesture and what it does. Nothing here had ever asked
// the browser how long a sample takes to reach a speaker, so the whole
// of the tuning so far has been on the other end of the problem.
//
// What is testable is the arithmetic and the wording — the two numbers
// mean different things, one of them is unknown for the first few
// seconds, and some browsers never answer at all. Each of those has to
// read as what it is rather than as a zero.

import { describe, expect, it } from "vitest";
import {
  describeDeviceLatency,
  describeGraphLatency,
  describeMeasuredLatency,
} from "../src/ui/audio-latency.js";

describe("what the graph adds", () => {
  it("says the milliseconds and the frames behind them", () => {
    // One render quantum at 48 kHz: 128 / 48000 = 2.666… ms.
    const line = describeGraphLatency(128 / 48000, 48000);
    expect(line).toContain("2.7 ms in the graph");
    expect(line).toContain("48000 Hz");
    expect(line).toContain("(128 frames)");
  });

  // The frame count is the number anyone changing this would change; the
  // milliseconds depend on the rate the device happened to choose, so a
  // line with only one of the two cannot be acted on.
  it("keeps the frames right when the device picked another rate", () => {
    const line = describeGraphLatency(128 / 44100, 44100);
    expect(line).toContain("2.9 ms");
    expect(line).toContain("44100 Hz");
    expect(line).toContain("(128 frames)");
  });

  it("does not write 1 frames", () => {
    expect(describeGraphLatency(1 / 48000, 48000)).toContain("(1 frame)");
  });
});

describe("what the device adds", () => {
  it("adds the two together, because that is the figure that is felt", () => {
    const line = describeDeviceLatency(0.002667, 0.08);
    expect(line).toContain("80.0 ms more to the device");
    expect(line).toContain("82.7 ms in all");
  });

  // A zero here is not a fast machine, it is a browser that has not
  // answered — Firefox does not implement `outputLatency` at all, and
  // Chrome reads zero until audio has actually flowed. Printing "0.0 ms"
  // would be the instrument reporting its own silence as good news.
  it("says it does not know, rather than reporting nothing as zero", () => {
    const line = describeDeviceLatency(0.002667, 0);
    expect(line).toContain("does not say");
    expect(line).not.toContain("0.0 ms");
  });

  it("treats a missing reading the same as a zero one", () => {
    expect(describeDeviceLatency(0.002667, Number.NaN)).toContain("does not say");
    expect(describeDeviceLatency(0.002667, -1)).toContain("does not say");
  });
});

// E9-202 — a Pixel was told 29 ms while it was playing 52 ms late.
describe("what the browser measured", () => {
  it("gives the measured figure as the floor, and the estimate beside it", () => {
    const line = describeMeasuredLatency(0.052, 0.024);
    expect(line).toContain("52.0 ms from the graph to the speaker, measured by the browser");
    expect(line).toContain("its estimate for the device alone is 24.0 ms");
    // The two are not added: the measurement already runs from the graph.
    expect(line).not.toContain("in all");
  });

  it("leaves the estimate out where the browser has none", () => {
    expect(describeMeasuredLatency(0.052, 0)).not.toContain("estimate");
  });
});
