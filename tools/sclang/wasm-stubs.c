/* emscripten 3.1.61 declares wait4() in <sys/wait.h> but ships no
 * implementation; SC's CI pins 4.0.18, where it exists. The only caller is
 * sc_pclose() in common/sc_popen.cpp, and sc_popen() cannot work under wasm
 * anyway - there is no fork(). So this is unreachable, not a behaviour change.
 *
 * Supplying it here keeps third_party/supercollider pristine: no local patch
 * to the SC tree, just one extra object on the link line.
 */
#include <errno.h>
#include <sys/resource.h>
#include <sys/wait.h>

/* Weak: emscripten 4.x does implement wait4(), and a strong definition here
 * would be a duplicate symbol. Weak lets libc's win when it exists. */
__attribute__((weak)) pid_t wait4(pid_t pid, int* status, int options, struct rusage* rusage) {
    (void)pid;
    (void)status;
    (void)options;
    (void)rusage;
    errno = ENOSYS;
    return -1;
}
