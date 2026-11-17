// Runs tools/screen/fingerprint.c under node and prints its transcript.
//
//   node tools/screen/fingerprint.mjs            > fp-wasm.txt
//   node tools/screen/fingerprint.mjs --full     > fp-wasm-full.txt
//
// Diff the result against a run of the same .c built natively on real norns:
//   gcc -O2 -o fingerprint fingerprint.c $(pkg-config --cflags --libs cairo freetype2) -lm
//   ./fingerprint --font ~/norns/resources/norns.ttf > fp-norns.txt
//   diff -u fp-wasm.txt fp-norns.txt
//
// Built with -sINVOKE_RUN=0 so main() runs exactly once, with our argv.
//
// Variant selectors. Each picks a differently-linked binary built from the
// IDENTICAL fingerprint.c, so a diff of two transcripts isolates exactly one
// library variable and nothing else:
//
//   --ft2104      FreeType 2.10.4 (norns' own) instead of emscripten's 2.13.3
//                 -- build-freetype-2104.sh, E0-17a
//   --pixman0400  pixman 0.40.0 (norns' own) instead of 0.42.2, both C-only
//                 -- build-pixman-0400.sh, E0-17c
//   --pxtrace     pixman 0.42.2 instrumented to log every composite entry
//                 point and fast-path selection to stderr -- trace-pixman.sh.
//                 stdout must still match fp-wasm.txt exactly.

const args = process.argv.slice(2)

const VARIANTS = [
  ['--ft2104', './build/fingerprint-ft2104.mjs'],
  ['--pixman0400', './build/fingerprint-pixman0400.mjs'],
  ['--pxtrace', './build/fingerprint-pxtrace.mjs'],
]

const selected = VARIANTS.filter(([flag]) => args.includes(flag))
if (selected.length > 1) {
  console.error(`pick at most one of: ${VARIANTS.map(([f]) => f).join(' ')}`)
  process.exit(2)
}

const entry = selected.length ? selected[0][1] : './build/fingerprint.mjs'
const passed = args.filter((a) => !VARIANTS.some(([flag]) => flag === a))

const { default: Module } = await import(entry)

const mod = await Module({ arguments: passed, noInitialRun: true })
mod.callMain(passed)
