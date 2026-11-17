// There is no filesystem in a browser — but "no filesystem" and "this file
// does not exist" are not the same answer, and Lua already has a word for the
// second one.
//
// The first version of this shim threw a bare Error for everything. That broke
// boot in a way that took a while to read: `core/screen.lua:13` calls
// `loadfile(_path.display_settings)`, whose contract is to return `nil, err`
// when the file is missing. Fengari implements that by catching Node's ENOENT
// — so a throw of the wrong SHAPE became a Lua error whose message was just
// the path, with nothing saying what had gone wrong.
//
// So reads report a properly formed ENOENT, which is both what Node does and
// what is true: the file is not there. norns handles it exactly as it handles
// a first boot on real hardware, before any settings have been saved.
//
// Writes report EROFS instead, because "read-only" is the honest distinction
// and a caller that cannot tell them apart would retry forever. The real
// filesystem is E6-01.

function nodeError(code: string, errno: number, syscall: string, path?: string): never {
  const e = new Error(
    `${code}: ${code === "ENOENT" ? "no such file or directory" : "read-only file system"}, ` +
      `${syscall}${path ? ` '${path}'` : ""}`,
  ) as NodeJS.ErrnoException;
  e.code = code;
  e.errno = errno;
  e.syscall = syscall;
  if (path) e.path = path;
  throw e;
}

const missing = (syscall: string) => (path?: unknown): never =>
  nodeError("ENOENT", -2, syscall, typeof path === "string" ? path : undefined);
const readOnly = (syscall: string) => (path?: unknown): never =>
  nodeError("EROFS", -30, syscall, typeof path === "string" ? path : undefined);

export const readFileSync = missing("open");
export const openSync = missing("open");
export const statSync = missing("stat");
export const lstatSync = missing("lstat");
export const readdirSync = missing("scandir");
export const readSync = missing("read");
export const fstatSync = missing("fstat");
export const realpathSync = missing("realpath");

export const writeFileSync = readOnly("open");
export const writeSync = readOnly("write");
export const appendFileSync = readOnly("open");
export const unlinkSync = readOnly("unlink");
export const renameSync = readOnly("rename");
export const mkdirSync = readOnly("mkdir");
export const mkdtempSync = readOnly("mkdtemp");

/** Closing something that was never opened is harmless, so this does not throw. */
export const closeSync = (): void => {};
export const existsSync = (): boolean => false;
export const constants = { O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 64, O_EXCL: 128 };

export default {
  readFileSync, openSync, statSync, lstatSync, readdirSync, readSync, fstatSync,
  realpathSync, writeFileSync, writeSync, appendFileSync, unlinkSync, renameSync,
  mkdirSync, mkdtempSync, closeSync, existsSync, constants,
};
