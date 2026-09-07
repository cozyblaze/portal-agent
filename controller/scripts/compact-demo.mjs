#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HEADER_SIZE = 1072;
const DEMO_PROTOCOL = 3;
const COMMAND = {
  signon: 1,
  packet: 2,
  synctick: 3,
  consolecmd: 4,
  usercmd: 5,
  datatables: 6,
  stop: 7,
  stringtables: 8,
};

function fail(message) {
  throw new Error(message);
}

function readSizedPayload(bytes, cursor, recordStart, label) {
  if (cursor + 4 > bytes.length) {
    fail(`Truncated ${label} size at byte ${recordStart}.`);
  }
  const size = bytes.readInt32LE(cursor);
  if (size < 0 || cursor + 4 + size > bytes.length) {
    fail(`Invalid ${label} payload size ${size} at byte ${recordStart}.`);
  }
  return { end: cursor + 4 + size, payloadStart: cursor + 4, payloadSize: size };
}

export function parseDemo(bytes) {
  if (bytes.length < HEADER_SIZE || bytes.subarray(0, 7).toString("ascii") !== "HL2DEMO") {
    fail("Input is not a Source HL2DEMO file.");
  }
  const protocol = bytes.readInt32LE(8);
  if (protocol !== DEMO_PROTOCOL) {
    fail(`Unsupported demo protocol ${protocol}; this tool currently supports protocol 3 only.`);
  }

  const records = [];
  let offset = HEADER_SIZE;
  let lastTick = 0;
  let repairedStop = false;

  while (offset < bytes.length) {
    const start = offset;
    const command = bytes[offset];

    // A few Portal recordings finish with dem_stop and only three bytes of its
    // four-byte tick. Playback treats EOF as the end anyway; normalize it when
    // writing the compacted copy.
    if (command === COMMAND.stop && bytes.length - start < 5) {
      const raw = Buffer.alloc(5);
      raw[0] = COMMAND.stop;
      raw.writeInt32LE(lastTick, 1);
      records.push({ command, tick: lastTick, raw, repaired: true });
      repairedStop = true;
      offset = bytes.length;
      break;
    }

    if (start + 5 > bytes.length) {
      fail(`Truncated command header at byte ${start}.`);
    }
    const tick = bytes.readInt32LE(start + 1);
    lastTick = tick;
    offset = start + 5;

    let payloadStart = offset;
    let payloadSize = 0;

    switch (command) {
      case COMMAND.signon:
      case COMMAND.packet: {
        // democmdinfo_t (76 bytes), incoming/outgoing sequence (8 bytes),
        // then a length-prefixed network payload.
        const sized = readSizedPayload(bytes, offset + 84, start, "packet");
        ({ end: offset, payloadStart, payloadSize } = sized);
        break;
      }
      case COMMAND.synctick:
        break;
      case COMMAND.consolecmd:
      case COMMAND.datatables:
      case COMMAND.stringtables: {
        const sized = readSizedPayload(bytes, offset, start, "command");
        ({ end: offset, payloadStart, payloadSize } = sized);
        break;
      }
      case COMMAND.usercmd: {
        // outgoing sequence, then a length-prefixed encoded CUserCmd.
        const sized = readSizedPayload(bytes, offset + 4, start, "usercmd");
        ({ end: offset, payloadStart, payloadSize } = sized);
        break;
      }
      case COMMAND.stop:
        break;
      default:
        fail(`Unknown demo command ${command} at byte ${start}.`);
    }

    records.push({
      command,
      tick,
      raw: bytes.subarray(start, offset),
      payload: bytes.subarray(payloadStart, payloadStart + payloadSize),
    });
    if (command === COMMAND.stop) {
      break;
    }
  }

  return { records, repairedStop };
}

function modalIdlePayload(packetRecords, minimumPackets) {
  const counts = new Map();
  for (const record of packetRecords) {
    // Real snapshots are much larger. Paused Portal frames carry a repeated
    // 1-4 byte net-channel idle payload.
    if (record.payload.length > 4) {
      continue;
    }
    const key = record.payload.toString("hex");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  let bestKey;
  let bestCount = 0;
  for (const [key, count] of counts) {
    if (count > bestCount) {
      bestKey = key;
      bestCount = count;
    }
  }
  return bestCount >= minimumPackets ? bestKey : undefined;
}

export function compactDemo(bytes, { minimumPackets = 8 } = {}) {
  if (!Number.isInteger(minimumPackets) || minimumPackets < 2) {
    fail("minimumPackets must be an integer of at least 2.");
  }

  const { records, repairedStop } = parseDemo(bytes);
  const kept = [];
  let removedPackets = 0;
  let removedUsercmds = 0;
  let compactedTickGroups = 0;

  for (let groupStart = 0; groupStart < records.length; ) {
    let groupEnd = groupStart + 1;
    while (groupEnd < records.length && records[groupEnd].tick === records[groupStart].tick) {
      groupEnd += 1;
    }
    const group = records.slice(groupStart, groupEnd);
    const packets = group.filter((record) => record.command === COMMAND.packet);
    const idleKey = modalIdlePayload(packets, minimumPackets);

    if (idleKey === undefined) {
      kept.push(...group);
      groupStart = groupEnd;
      continue;
    }

    compactedTickGroups += 1;
    const idlePackets = packets.filter((record) => record.payload.toString("hex") === idleKey);
    const lastIdlePacket = idlePackets.at(-1);
    const usercmds = group.filter((record) => record.command === COMMAND.usercmd);
    const firstUsercmd = usercmds[0];
    const lastUsercmd = usercmds.at(-1);

    for (const record of group) {
      if (record.command === COMMAND.packet && record.payload.toString("hex") === idleKey) {
        if (record === lastIdlePacket) {
          kept.push(record);
        } else {
          removedPackets += 1;
        }
        continue;
      }
      if (record.command === COMMAND.usercmd) {
        if (record === firstUsercmd || record === lastUsercmd) {
          kept.push(record);
        } else {
          removedUsercmds += 1;
        }
        continue;
      }
      kept.push(record);
    }
    groupStart = groupEnd;
  }

  const header = Buffer.from(bytes.subarray(0, HEADER_SIZE));
  const oldFrames = header.readInt32LE(1064);
  header.writeInt32LE(oldFrames - removedPackets, 1064);
  const output = Buffer.concat([header, ...kept.map((record) => record.raw)]);

  // Verify that our own parser can consume the complete result before it is
  // allowed to reach disk.
  parseDemo(output);

  return {
    output,
    stats: {
      compactedTickGroups,
      oldBytes: bytes.length,
      newBytes: output.length,
      oldFrames,
      newFrames: oldFrames - removedPackets,
      removedPackets,
      removedUsercmds,
      repairedStop,
    },
  };
}

function parseArgs(argv) {
  const positional = [];
  let dryRun = false;
  let force = false;
  let minimumPackets = 8;

  for (const arg of argv) {
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--force") {
      force = true;
    } else if (arg.startsWith("--min-packets=")) {
      minimumPackets = Number(arg.slice("--min-packets=".length));
    } else if (arg.startsWith("-")) {
      fail(`Unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length < 1 || positional.length > 2) {
    fail("Usage: npm run compact-demo -- <input.dem> [output.dem] [--dry-run] [--force]");
  }
  if (!dryRun && positional.length !== 2) {
    fail("An output path is required unless --dry-run is used.");
  }
  return { input: positional[0], output: positional[1], dryRun, force, minimumPackets };
}

function formatStats(stats) {
  const percent = stats.oldBytes === 0 ? 0 : ((stats.oldBytes - stats.newBytes) / stats.oldBytes) * 100;
  return [
    `Compacted tick groups: ${stats.compactedTickGroups}`,
    `Demo packet frames: ${stats.oldFrames} -> ${stats.newFrames}`,
    `Removed usercmd records: ${stats.removedUsercmds}`,
    `Size: ${stats.oldBytes} -> ${stats.newBytes} bytes (${percent.toFixed(1)}% smaller)`,
    stats.repairedStop ? "Repaired a truncated final dem_stop record." : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const inputBytes = fs.readFileSync(args.input);
    const { output, stats } = compactDemo(inputBytes, { minimumPackets: args.minimumPackets });
    console.log(formatStats(stats));
    if (!args.dryRun) {
      if (fs.existsSync(args.output) && !args.force) {
        fail(`Output already exists: ${args.output} (pass --force to replace it)`);
      }
      fs.writeFileSync(args.output, output, { flag: args.force ? "w" : "wx" });
      console.log(`Wrote ${path.resolve(args.output)}`);
    }
  } catch (error) {
    console.error(`compact-demo: ${error.message}`);
    process.exitCode = 1;
  }
}
