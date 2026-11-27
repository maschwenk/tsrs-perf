"use strict";
const fs = require("node:fs");

// The NAPI-RS loader used by Oxc probes ldd, then Node's report, then a child process. Unknown hosts default to GNU.
function isMusl() {
    try {
        return fs.readFileSync("/usr/bin/ldd", "utf8").includes("musl");
    }
    catch {
        // ldd is not always installed at /usr/bin/ldd.
    }

    if (typeof process.report?.getReport === "function") {
        const excludeNetwork = process.report.excludeNetwork;
        try {
            process.report.excludeNetwork = true;
            const report = process.report.getReport();
            if (report?.header?.glibcVersionRuntime) return false;
            if (report?.sharedObjects?.some(file => file.includes("libc.musl-") || file.includes("ld-musl-"))) return true;
        }
        catch {
            // A disabled report or one with no libc evidence leaves the final ldd probe.
        }
        finally {
            process.report.excludeNetwork = excludeNetwork;
        }
    }

    try {
        return require("node:child_process").execFileSync("ldd", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).includes("musl");
    }
    catch (error) {
        // musl's ldd can print its version to stderr and exit nonzero.
        return `${error.stdout ?? ""}${error.stderr ?? ""}`.includes("musl");
    }
}

function getPlatformPackageName(os = process.platform, cpu = process.arch) {
    const suffix = os === "linux" ? (isMusl() ? "-musl" : "-gnu") : "";
    return `@tsrs/${os}-${cpu}${suffix}`;
}

exports.getPlatformPackageName = getPlatformPackageName;
