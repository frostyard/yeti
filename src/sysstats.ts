import os from "node:os";
import fs from "node:fs";
import { WORK_DIR } from "./config.js";

/** A small at-a-glance host health snapshot for the dashboard Overview. */
export interface SystemStats {
  cpuPercent: number | null; // 0-100 busy%, null until a second sample exists
  cpuCount: number;
  load: [number, number, number]; // 1/5/15-minute load averages
  memTotal: number; // bytes
  memUsed: number; // bytes (total - available)
  diskTotal: number; // bytes (filesystem holding the yeti data dir)
  diskUsed: number; // bytes
}

// CPU% is derived from the delta between consecutive samples of aggregate CPU
// times, so the first call has no baseline and returns null.
let lastCpu: { idle: number; total: number } | null = null;

function sampleCpu(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    for (const t of Object.values(cpu.times)) total += t;
    idle += cpu.times.idle;
  }
  return { idle, total };
}

/** Available memory: prefer Linux MemAvailable (excludes reclaimable cache), else os.freemem(). */
function availableMem(): number {
  try {
    const m = fs.readFileSync("/proc/meminfo", "utf8").match(/^MemAvailable:\s+(\d+)\s*kB/m);
    if (m) return parseInt(m[1], 10) * 1024;
  } catch {
    /* not Linux / unreadable */
  }
  return os.freemem();
}

export function getSystemStats(): SystemStats {
  const sample = sampleCpu();
  let cpuPercent: number | null = null;
  if (lastCpu) {
    const idleDelta = sample.idle - lastCpu.idle;
    const totalDelta = sample.total - lastCpu.total;
    if (totalDelta > 0) {
      cpuPercent = Math.max(0, Math.min(100, Math.round((1 - idleDelta / totalDelta) * 100)));
    }
  }
  lastCpu = sample;

  const memTotal = os.totalmem();
  const memUsed = Math.max(0, memTotal - availableMem());

  let diskTotal = 0;
  let diskUsed = 0;
  try {
    const s = fs.statfsSync(WORK_DIR);
    diskTotal = s.blocks * s.bsize;
    diskUsed = diskTotal - s.bavail * s.bsize; // bavail = space usable by non-root
  } catch {
    /* statfs unavailable — leave zeros */
  }

  return {
    cpuPercent,
    cpuCount: os.cpus().length,
    load: os.loadavg() as [number, number, number],
    memTotal,
    memUsed,
    diskTotal,
    diskUsed,
  };
}
