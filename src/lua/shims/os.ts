// `luaconf.js:60` calls this to decide the path separator. A browser is not
// win32, and that is the only thing the answer is used for.
export function platform(): string {
  return "browser";
}
export const EOL = "\n";
export default { platform, EOL };
