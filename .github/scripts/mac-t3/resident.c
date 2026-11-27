#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

// mincore observes residency without reading file contents or populating pages.
int main(int argc, char **argv) {
    long page_size = sysconf(_SC_PAGESIZE);
    if (page_size <= 0 || argc < 2) return 1;
    putchar('[');
    for (int arg = 1; arg < argc; arg++) {
        int fd = open(argv[arg], O_RDONLY | O_CLOEXEC);
        struct stat meta;
        if (fd == -1 || fstat(fd, &meta) == -1 || !S_ISREG(meta.st_mode) || meta.st_size <= 0) {
            perror(argv[arg]);
            return 2;
        }
        size_t len = (size_t)meta.st_size;
        size_t pages = (len - 1) / (size_t)page_size + 1;
        char *vec = calloc(pages, 1);
        void *map = mmap(NULL, len, PROT_NONE, MAP_PRIVATE, fd, 0);
        if (vec == NULL || map == MAP_FAILED || mincore(map, len, vec) == -1) {
            perror("mincore");
            return 3;
        }
        size_t present = 0;
        for (size_t i = 0; i < pages; i++) present += vec[i] & 1;
        printf("%s{\"pages\":%zu,\"resident\":%zu}", arg == 1 ? "" : ",", pages, present);
        free(vec);
        if (munmap(map, len) == -1 || close(fd) == -1) return 4;
    }
    puts("]");
    return 0;
}
