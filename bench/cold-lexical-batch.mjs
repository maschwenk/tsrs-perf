// One cold command. Run with node bench/cold-lexical-batch.mjs <program> [args...].
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { once } from "node:events";

const [program, ...argv] = process.argv.slice(2);
if (!program) throw Error("expected a command");
if (program !== "--serve") {
  const env = { ...process.env };
  delete env.TSRS_BATCH_SOCKET;
  if (process.platform === "linux" && fs.existsSync("/usr/bin/python3")) {
    const launcher = path.join(import.meta.dirname, "cold-lexical-launch.py");
    if (fs.existsSync(launcher)) {
      process.execve("/usr/bin/python3", ["python3", launcher, process.execPath, import.meta.filename, program, ...argv], env);
    }
  }
  process.execve("/usr/bin/env", ["env", "--", program, ...argv], env);
}
const [directory, parent, parentStart, readyFd] = argv;
const socket = path.join(directory, "scanner.sock");
const cache = new Map();
const pending = new Set();
const capacity = 64 << 20;
const maxRecord = 4 << 20;
const maxKeys = 4096;
const metrics = { hits: 0, producers: 0, bypasses: 0, entries: 0, storedBytes: 0, servedBytes: 0 };
const sizeWord = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const server = net.createServer((peer) => {
  let header = Buffer.alloc(0), chunks = [], length = 0, expected, key;
  peer.setTimeout(2000, () => peer.destroy());
  peer.on("error", () => peer.destroy());
  peer.on("data", (data) => {
    if (expected === undefined) {
      header = Buffer.concat([header, data]);
      if (header.length < 33) return;
      key = header.subarray(1, 33).toString("hex");
      if (header[0] === 71) {
        const entry = cache.get(key);
        if (entry) {
          metrics.hits++;
          metrics.servedBytes += entry.length;
          peer.write(sizeWord(entry.length));
          peer.end(entry);
        } else if (!pending.has(key) && cache.size + pending.size < maxKeys && metrics.storedBytes < capacity) {
          pending.add(key);
          metrics.producers++;
          peer.end(sizeWord(0xffffffff));
        } else {
          metrics.bypasses++;
          peer.end(sizeWord(0));
        }
        return;
      }
      if (header[0] !== 80 || !pending.has(key)) return peer.destroy();
      if (header.length < 37) return;
      expected = header.readUInt32LE(33);
      if (!expected || expected > maxRecord || expected % 12 || expected + metrics.storedBytes > capacity) return peer.destroy();
      data = header.subarray(37);
      header = Buffer.alloc(0);
    }
    length += data.length;
    if (length > expected) return peer.destroy();
    chunks.push(data);
    if (length === expected) {
      if (pending.delete(key) && metrics.storedBytes + length <= capacity) {
        cache.set(key, Buffer.concat(chunks, length));
        metrics.entries++;
        metrics.storedBytes += length;
      }
      chunks = [];
      peer.end();
    }
  });
});
server.maxConnections = 32;
server.listen(socket);
await once(server, "listening");
fs.writeSync(Number(readyFd), "1");
fs.closeSync(Number(readyFd));
function finish() {
  if (process.env.TSRS_BATCH_STATS) fs.writeFileSync(process.env.TSRS_BATCH_STATS, JSON.stringify(metrics));
  server.close();
  fs.rmSync(directory, { recursive: true, force: true });
  process.exit(0);
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(signal, finish);
function jobIsAlive() {
  try {
    const stat = fs.readFileSync(`/proc/${parent}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
    return fields[19] === parentStart && fields[0] !== "Z" && fields[0] !== "X" && fs.existsSync(directory);
  } catch {
    return false;
  }
}
setInterval(() => { if (!jobIsAlive()) finish(); }, 20);
