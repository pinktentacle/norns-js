// E9-257 — softcut.reset() puts the input filter's cutoff back to 16000.
//
// softcut-lib's Voice::reset keeps the LAST cutoff a script set, so a script
// that turned it down silenced the next one's recording. The patch is on
// norns' own Lua (src/lua/patches.ts); this runs that Lua.

import { describe, expect, it } from "vitest";
import { bootedHost } from "./support/script-harness.js";

describe("softcut.reset", () => {
  it("sets every voice's input filter cutoff to the default, after crone's own reset", () => {
    const h = bootedHost();
    const before = h.host.output.length;
    const err = h.host.run(`
      local seen = {}
      _norns.cut_reset = function() seen[#seen + 1] = "reset" end
      _norns.cut_param = function(name, voice, value)
        if name == "pre_filter_fc" then seen[#seen + 1] = voice .. ":" .. value end
      end
      softcut.reset()
      print("SEEN " .. table.concat(seen, ","))
    `);
    expect(err, `softcut.reset failed: ${err}`).toBeFalsy();
    const said = h.host.output.slice(before).join("");
    expect(said).toContain("SEEN reset,1:16000,2:16000,3:16000,4:16000,5:16000,6:16000");
  });
});
