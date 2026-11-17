// emcc with -o *.mjs emits a MODULARIZE+ESM factory; main() runs when called.
import Module from './build/screen-test.mjs'
await Module()
