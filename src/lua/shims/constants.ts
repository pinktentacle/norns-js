// The legacy Node `constants` module, for `tmp` — a dependency fengari pulls
// in for `os.tmpname`. It reads both shapes the module has had over the years:
// flat (`O_CREAT`) and nested (`os.errno.EBADF`), picking whichever exists.
//
// The values are Linux's. Nothing in norns-js opens a file through this path
// — `fs.ts` refuses every call — so they only have to be present and
// self-consistent, not correct for any particular kernel.
const errno = { EBADF: 9, ENOENT: 2, EEXIST: 17, EACCES: 13, EPERM: 1 };
const fileFlags = { O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 64, O_EXCL: 128, O_TRUNC: 512 };

export const O_RDONLY = fileFlags.O_RDONLY;
export const O_WRONLY = fileFlags.O_WRONLY;
export const O_RDWR = fileFlags.O_RDWR;
export const O_CREAT = fileFlags.O_CREAT;
export const O_EXCL = fileFlags.O_EXCL;
export const O_TRUNC = fileFlags.O_TRUNC;
export const EBADF = errno.EBADF;
export const ENOENT = errno.ENOENT;
export const os = { errno };
export const fs = fileFlags;

export default { ...fileFlags, ...errno, os, fs };
