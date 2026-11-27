#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/resource.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static double seconds(struct timeval time) {
    return time.tv_sec + time.tv_usec / 1e6;
}

int main(int argc, char **argv) {
    if (argc < 4) return 1;
    int out = open(argv[1], O_CREAT | O_TRUNC | O_WRONLY, 0600);
    int err = open(argv[2], O_CREAT | O_TRUNC | O_WRONLY, 0600);
    if (out == -1 || err == -1) return 1;
    struct timespec start, end;
    if (clock_gettime(CLOCK_MONOTONIC, &start)) return 1;
    pid_t pid = fork();
    if (pid == -1) return 1;
    if (!pid) {
        if (dup2(out, STDOUT_FILENO) < 0 || dup2(err, STDERR_FILENO) < 0) _exit(126);
        close(out);
        close(err);
        execv(argv[3], &argv[3]);
        _exit(127);
    }
    close(out);
    close(err);
    int status;
    struct rusage usage;
    pid_t done;
    do {
        done = wait4(pid, &status, 0, &usage);
    } while (done < 0 && errno == EINTR);
    if (done != pid || clock_gettime(CLOCK_MONOTONIC, &end)) return 1;
    double wall = end.tv_sec-start.tv_sec + (end.tv_nsec-start.tv_nsec)/1e9;
    printf("{\"commandSeconds\":%.9f,\"userSeconds\":%.6f,\"systemSeconds\":%.6f,"
           "\"rssBytes\":%ld,\"fsInputBlocks\":%ld,\"fsOutputBlocks\":%ld,"
           "\"majorFaults\":%ld,\"minorFaults\":%ld,\"status\":%d,\"signal\":%d}\n",
           wall, seconds(usage.ru_utime), seconds(usage.ru_stime), usage.ru_maxrss,
           usage.ru_inblock, usage.ru_oublock, usage.ru_majflt, usage.ru_minflt,
           WIFEXITED(status) ? WEXITSTATUS(status) : -1,
           WIFSIGNALED(status) ? WTERMSIG(status) : 0);
    return 0;
}
