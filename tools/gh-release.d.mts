// Types for gh-release.mjs, which stays plain JavaScript so Cloudflare,
// Node and Electron can all load it as it is.
export declare const RELAY_PREFIX: "/gh-release/";
export declare const RELAY_HEADER: "X-Norns-Relay";
export declare function releaseTarget(pathname: string): string | null;
export declare function relayRelease(
  pathname: string,
  opts: {
    fetch: (url: string, init: RequestInit) => Promise<Response>;
    method?: string;
    site?: string | null;
  },
): Promise<Response>;
