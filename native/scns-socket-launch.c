/*
 * scns-socket-launch — launchd socket-activation shim for the SCNS broker.
 *
 * launchd owns the listening socket declared under the plist `Sockets`
 * key (name "Listeners"). This tiny helper is the launchd `Program`; it:
 *   1. retrieves the inherited socket fd(s) via launch_activate_socket(3),
 *   2. moves the first fd to a fixed number (3) with close-on-exec cleared,
 *   3. exports SCNS_LISTEN_FD=3, and
 *   4. exec's the real program (node dist/cli.js start …).
 *
 * Because launchd keeps the socket open across a `launchctl kickstart -k`
 * process swap, the kernel queues incoming connections during the restart —
 * so a client sees zero dropped connections (no ECONNREFUSED) instead of the
 * gap the old bootout→bootstrap path leaves while nothing holds :3456.
 *
 * If there is no launchd socket (dev / manual run), the helper exports nothing
 * and exec's the child, which falls back to listen(port).
 *
 * Build (macOS): cc -O2 -o dist/native/scns-socket-launch native/scns-socket-launch.c
 * (launch_activate_socket lives in libSystem — no extra link flags needed.)
 */
#include <launch.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#ifndef SCNS_TARGET_FD
#define SCNS_TARGET_FD 3
#endif

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: %s <program> [args...]\n", argv[0]);
    return 2;
  }

  const char *sock_name = getenv("SCNS_SOCKET_NAME");
  if (sock_name == NULL || sock_name[0] == '\0') sock_name = "Listeners";

  int *fds = NULL;
  size_t cnt = 0;
  int err = launch_activate_socket(sock_name, &fds, &cnt);

  if (err == 0 && cnt > 0) {
    int src = fds[0];
    if (src != SCNS_TARGET_FD) {
      if (dup2(src, SCNS_TARGET_FD) < 0) {
        perror("[scns-socket-launch] dup2");
      } else {
        close(src);
      }
    }
    /* Clear FD_CLOEXEC so the fd survives execv into node. */
    int flags = fcntl(SCNS_TARGET_FD, F_GETFD);
    if (flags >= 0) fcntl(SCNS_TARGET_FD, F_SETFD, flags & ~FD_CLOEXEC);

    char buf[16];
    snprintf(buf, sizeof(buf), "%d", SCNS_TARGET_FD);
    setenv("SCNS_LISTEN_FD", buf, 1);
  } else {
    fprintf(stderr,
            "[scns-socket-launch] launch_activate_socket(\"%s\") err=%d cnt=%zu — "
            "no inherited socket, falling back to port listen\n",
            sock_name, err, cnt);
  }
  if (fds != NULL) free(fds);

  execv(argv[1], &argv[1]);
  /* Only reached if execv failed. */
  fprintf(stderr, "[scns-socket-launch] execv(%s) failed: %s\n", argv[1], strerror(errno));
  return 127;
}
