// E9-227 — the relay, on Cloudflare Pages. See tools/gh-release.mjs.
//
// A Pages Function: `wrangler pages deploy` compiles every file under
// `functions/` at the root of the tree it is run from, and routes
// `/gh-release/*` here and nothing else — the rest of the site is still
// served as static files, and costs no function call.
import { relayRelease } from "../../tools/gh-release.mjs";

export const onRequest = ({ request }) =>
  relayRelease(new URL(request.url).pathname, {
    fetch: (url, init) => fetch(url, init),
    method: request.method,
    site: request.headers.get("Sec-Fetch-Site"),
  });
