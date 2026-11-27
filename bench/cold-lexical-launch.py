"""Start the private broker without adding a child to the command's wait set."""
import os
import select
import shutil
import signal
import sys
import tempfile

node, server, command, *args = sys.argv[1:]
env = os.environ.copy()
env.pop("TSRS_BATCH_SOCKET", None)


def start_broker(directory):
    pid = os.getpid()
    with open(f"/proc/{pid}/stat", "rb") as stat:
        start = stat.read().rsplit(b") ", 1)[1].split()[19].decode("ascii")
    pid_r, pid_w = os.pipe()
    ready_r, ready_w = os.pipe()
    try:
        helper = os.fork()
        if helper == 0:
            try:
                os.close(pid_r)
                os.close(ready_r)
                broker = os.fork()
                if broker:
                    os.write(pid_w, str(broker).encode("ascii"))
                    os._exit(0)
                os.close(pid_w)
                with open(os.devnull, "r+b", buffering=0) as quiet:
                    for fd in (0, 1, 2):
                        os.dup2(quiet.fileno(), fd)
                os.set_inheritable(ready_w, True)
                os.execv(node, [node, server, "--serve", directory, str(pid), start, str(ready_w)])
            except BaseException:
                os._exit(1)
        os.close(pid_w)
        os.close(ready_w)
        _, status = os.waitpid(helper, 0)
        if status:
            return False
        broker = int(os.read(pid_r, 64))
        # PID 1 and child subreapers can adopt the grandchild. Reap it before
        # executing the original command, which may itself call waitpid(-1).
        try:
            reaped, _ = os.waitpid(broker, os.WNOHANG)
        except ChildProcessError:
            pass
        else:
            if not reaped:
                os.kill(broker, signal.SIGKILL)
                os.waitpid(broker, 0)
            return False
        return bool(select.select([ready_r], [], [], 2)[0]) and os.read(ready_r, 1) == b"1"
    finally:
        for fd in (pid_r, pid_w, ready_r, ready_w):
            try:
                os.close(fd)
            except OSError:
                pass


directory = None
try:
    directory = tempfile.mkdtemp(prefix="tsrs-batch-")
    if start_broker(directory):
        env["TSRS_BATCH_SOCKET"] = os.path.join(directory, "scanner.sock")
except (OSError, ValueError):
    pass
if directory and "TSRS_BATCH_SOCKET" not in env:
    shutil.rmtree(directory, ignore_errors=True)
os.execve("/usr/bin/env", ["env", "--", command, *args], env)

