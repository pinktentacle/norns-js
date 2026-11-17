# Node builtins, shimmed for the browser

Fengari is a Node-shaped CommonJS package. Four builtins are reached while it
loads or runs, each from one or two lines:

| module | what fengari uses | where |
|---|---|---|
| `os` | `platform()` | `luaconf.js:60`, to pick the path separator |
| `path` | `resolve()` | `loadlib.js:161` |
| `fs` | `readFileSync`, `openSync`, … | `liolib.js:3`, `lauxlib.js:901`, `loslib.js:487` |
| `buffer` | `Buffer.from` | `lbaselib.js:115`, inside `print` |

The alternative was `fengari-web`, the authors' browser bundle. It was not
taken because it would mean the page and the tests running **different copies
of the Lua interpreter**, and a divergence there is the kind that shows up as
a script behaving differently in a browser than on hardware — the exact
failure this project chose Fengari to avoid.

So: one interpreter, aliased builtins, and every shim fails loudly rather than
returning something plausible. `fs` in particular throws, because a silent
empty read would look like "the file is empty" to Lua. The real filesystem is
E6-01.
