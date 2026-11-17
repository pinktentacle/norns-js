// E7-08 — what this is, who wrote the parts, and where the source is.
//
// Not decoration and not a courtesy. norns-js is **AGPL-3.0-or-later**, and
// §13 is the clause that makes this file exist: when the software is
// *interacted with over a network* — which a web page is, always — users
// must be offered the Corresponding Source. A LICENSE file in a repository
// nobody can find does not do that. A visible link from the running program
// does.
//
// THE LINK IS A BUILD INPUT, not a constant here, because the repository
// this is served from is a deployment decision. `VITE_SOURCE_URL` carries
// it, and `vite.config.ts` REFUSES A PRODUCTION BUILD without one: an
// obligation that only produces a note is an obligation that ships broken.
// In a dev build the panel says it is unset, which is the truth and is
// exactly what someone about to deploy needs to see.

export interface Component {
  readonly what: string;
  readonly who: string;
  readonly licence: string;
}

/**
 * The parts, and the terms they arrive under.
 *
 * Only what is actually SHIPPED to a browser. Development tools are not
 * distributed and are not here; the bundled scripts are not here either,
 * because they are an aggregate with their own list (`LICENCES.md`)
 * and the panel points at it separately.
 */
export const COMPONENTS: readonly Component[] = [
  { what: "norns", who: "monome", licence: "GPL-3.0" },
  { what: "SuperCollider", who: "James McCartney and contributors", licence: "GPL-3.0-or-later" },
  { what: "sc3-plugins", who: "the SuperCollider community", licence: "GPL-2.0-or-later" },
  { what: "STK", who: "Perry R. Cook and Gary P. Scavone", licence: "MIT-like" },
  { what: "nova-simd", who: "Tim Blechmann", licence: "GPL-2.0-or-later" },
  { what: "mi-UGens", who: "Volker Böhm", licence: "GPL-3.0" },
  { what: "Mutable Instruments eurorack", who: "Émilie Gillet", licence: "MIT" },
  { what: "PortedPlugins", who: "Mads Kjeldgaard and contributors", licence: "GPL-3.0-or-later" },
  { what: "DaisySP", who: "Electrosmith", licence: "MIT" },
  { what: "DaisySP-LGPL", who: "Electrosmith", licence: "LGPL-2.1-or-later" },
  { what: "Eigen", who: "the Eigen authors", licence: "MPL-2.0" },
  { what: "FFTW", who: "Matteo Frigo and Steven G. Johnson, MIT", licence: "GPL-2.0-or-later" },
  { what: "ByteBeat, PulsePTR, TrianglePTR, FormantTriPTR", who: "their authors", licence: "GPL-3.0-or-later" },
  { what: "softcut-lib", who: "monome", licence: "GPL-3.0" },
  { what: "fengari", who: "Benoit Giannangeli, Daurnimator", licence: "MIT" },
  { what: "cairo", who: "the cairo authors", licence: "LGPL-2.1 / MPL-1.1" },
  { what: "pixman", who: "the pixman authors", licence: "MIT" },
  { what: "FreeType", who: "David Turner, Robert Wilhelm, Werner Lemberg", licence: "FTL / GPL-2.0" },
  { what: "Ace", who: "Ajax.org B.V.", licence: "BSD-3-Clause" },
];

/**
 * E9-75 — NINE OF THESE NINETEEN WERE NOT HERE, and that is the reason to
 * generate the list rather than keep it.
 *
 * `tools/build-notices.mjs` walks what the build actually links and reads
 * each licence out of `third_party/`; writing it found STK, nova-simd,
 * PortedPlugins, DaisySP, DaisySP-LGPL, Eigen, FFTW, sc-plugins-extra and
 * softcut-lib missing from this panel, and sc3-plugins called GPL-3.0 when
 * its own files say GPL-2.0-or-later. This array is the short form for the
 * gear; `public/NOTICES.txt` is the long one, with every text in full, and
 * the panel links it.
 */
export const COPYRIGHT = "© 2026 pinktentacle";

/**
 * Named so that nobody has to wonder, and so that nobody is implied.
 *
 * This is the one sentence a project built on somebody else's product name
 * owes them. It costs nothing and it is the difference between naming a
 * thing and claiming it.
 */
export const TRADEMARK =
  "not a monome product. monome, norns, Mutable Instruments and all other " +
  "product names are trademarks of their respective owners, named only to " +
  "say what this is built on and what it works with. No affiliation or " +
  "endorsement is implied.";

export const LICENCE = "AGPL-3.0-or-later";

/**
 * The source URL, or null when the build did not supply one.
 *
 * Read through `import.meta.env` so it is substituted at build time and can
 * differ per deployment. Null is a reportable state rather than an empty
 * string, so the panel can say "not configured" instead of rendering a link
 * to nowhere.
 */
export function sourceUrl(): string | null {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  const url = env?.["VITE_SOURCE_URL"]?.trim();
  return url ? url : null;
}
