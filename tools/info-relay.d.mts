// Types for info-relay.mjs, which stays plain JavaScript so Cloudflare,
// Node and Electron can all load it as it is.
export declare const INFO_PREFIX: "/info-relay/";
export declare const INFO_HEADER: "X-Norns-Relay";
export declare function infoTarget(
  pathname: string,
): { kind: "ping" } | { kind: "lines" | "img"; url: string } | null;
export declare function relayInfo(
  pathname: string,
  opts: {
    fetch: (url: string, init: RequestInit) => Promise<Response>;
    method?: string;
    site?: string | null;
  },
): Promise<Response>;
