// E9-277 — the info sheet's relay, on Cloudflare Pages. See tools/info-relay.mjs.
//
// A Pages Function, like `functions/gh-release/`: routes `/info-relay/*`
// here and nothing else.
import { relayInfo } from "../../tools/info-relay.mjs";

export const onRequest = ({ request }) =>
  relayInfo(new URL(request.url).pathname, {
    fetch: (url, init) => fetch(url, init),
    method: request.method,
    site: request.headers.get("Sec-Fetch-Site"),
  });
