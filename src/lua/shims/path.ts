// `loadlib.js:161` resolves a module path against the cwd. Lua module loading
// in norns-js goes through the searcher in host.ts, not through loadlib's file
// paths, so this only has to be well behaved, not complete.
export function resolve(...parts: string[]): string {
  const joined = parts.filter(Boolean).join("/");
  const absolute = joined.startsWith("/");
  const out: string[] = [];
  for (const segment of joined.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") out.pop();
    else out.push(segment);
  }
  return (absolute ? "/" : "") + out.join("/");
}
export function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}
export const sep = "/";
export default { resolve, dirname, sep };
