// One cold command. Run with node bench/cold-lexical-batch.mjs <program> [args...].
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fork } from "node:child_process";
import { once } from "node:events";

const [program, ...argv] = process.argv.slice(2);
if (!program) throw Error("expected a command");
if (program !== "--serve") {
  const env = { ...process.env };
  delete env.TSRS_BATCH_SOCKET;
  let directory, broker, timer;
  try {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "tsrs-batch-"));
    broker = fork(import.meta.filename, ["--serve", directory, String(process.pid)], {
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(["timeout"]), 2000); });
    const [ready] = await Promise.race([once(broker, "message"), once(broker, "exit"), timeout]);
    if (ready !== "ready") throw Error("batch broker unavailable");
    broker.disconnect();
    env.TSRS_BATCH_SOCKET = path.join(directory, "scanner.sock");
  } catch {
    broker?.kill();
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  } finally {
    clearTimeout(timer);
  }
  // Preserve the real command's PID, stdio, exit status and signals.
  process.execve("/usr/bin/env", ["env", "--", program, ...argv], env);
}
const [directory, parent] = argv;
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
process.send("ready");
function finish() {
  if (process.env.TSRS_BATCH_STATS) fs.writeFileSync(process.env.TSRS_BATCH_STATS, JSON.stringify(metrics));
  server.close();
  fs.rmSync(directory, { recursive: true, force: true });
  process.exit(0);
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(signal, finish);
setInterval(() => { if (process.ppid !== Number(parent)) finish(); }, 20);
