#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { createPortalController } from "../index.mjs";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 27182;
const DEFAULT_REQUEST_TIMEOUT_MS = 5000;

async function main(argv) {
  const { options, args } = parseArgs(argv);

  if (options.help || args.length === 0) {
    printHelp();
    return 0;
  }

  const portal = await createPortalController({
    host: options.host,
    port: options.port,
    requestTimeoutMs: options.requestTimeoutMs,
  });

  try {
    await runCommand(portal, args);
    return 0;
  } finally {
    portal.close();
  }
}

async function runCommand(portal, args) {
  const [command, ...rest] = args;

  if (["left", "right", "up", "down"].includes(command)) {
    const [angle] = requireArity(rest, 1, `${command} <degrees>`);
    const { facing } = await portal.look[command](Number(angle));
    printOk(`${command} ${angle} -> facing ${JSON.stringify(facing)}`);
    return;
  }

  if (command === "screenshot") {
    const [path] = requireArity(rest, 1, "screenshot <path>");
    const screenshot = await portal.screenshot({ autoEmit: false });
    const image = screenshot.screenshots[0];
    const bytes = bytesFromDataUrl(image.url);
    await writeFile(path, bytes);
    printOk(`screenshot ${path} (${bytes.length} bytes)`);
    return;
  }

  if (command === "abort") {
    requireArity(rest, 0, "abort");
    await portal.abort();
    printOk("abort");
    return;
  }

  if (command === "wait") {
    const [ticks] = requireArity(rest, 1, "wait <ticks>");
    const result = await portal.tas().wait(Number(ticks)).run({ screenshot: false });
    printOk(`wait ${ticks} -> ${JSON.stringify(result)}`);
    return;
  }

  if (command === "run") {
    const [path] = requireArity(rest, 1, "run <steps.json>");
    const steps = JSON.parse(await readFile(path, "utf8"));
    const result = await portal.run(steps, { screenshot: false });
    printOk(`run ${path} -> ${JSON.stringify(result)}`);
    return;
  }

  if (command === "demo") {
    requireArity(rest, 0, "demo");
    // Walk forward a second, turn left while walking, hop, and stop.
    const result = await portal
      .tas()
      .hold(67, { forward: true })
      .hold(33, { forward: true }, { left: 45 })
      .jump()
      .wait(45)
      .run({ screenshot: false });
    printOk(`demo -> ${JSON.stringify(result)}`);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

function parseArgs(argv) {
  const options = {
    help: false,
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
  };
  const args = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "-h" || arg === "--help") {
      options.help = true;
      continue;
    }
    if (arg === "--host") {
      options.host = requireOptionValue(argv, (index += 1), "--host");
      continue;
    }
    if (arg === "--port") {
      options.port = parsePort(requireOptionValue(argv, (index += 1), "--port"));
      continue;
    }
    if (arg === "--request-timeout") {
      options.requestTimeoutMs = parsePositiveInteger(
        requireOptionValue(argv, (index += 1), "--request-timeout"),
        "request timeout",
      );
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    }

    args.push(arg);
  }

  return { options, args };
}

function requireOptionValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

function requireArity(args, expected, usage) {
  if (args.length !== expected) {
    throw new Error(`Usage: ${usage}`);
  }
  return args;
}

function parsePort(value) {
  const port = parsePositiveInteger(value, "port");
  if (port > 65535) {
    throw new Error(`Port must be between 1 and 65535, got ${value}.`);
  }
  return port;
}

function parsePositiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${label} must be a positive integer, got ${value}.`);
  }
  return number;
}

function printOk(message) {
  console.log(`ok: ${message}`);
}

function bytesFromDataUrl(url) {
  const match = /^data:[^;,]+;base64,([A-Za-z0-9+/=]+)$/.exec(url);
  if (!match) {
    throw new Error("Screenshot response did not include a JPEG data URL.");
  }
  return Buffer.from(match[1], "base64");
}

function printHelp() {
  console.log(`Portal manual SPT tester (TAS playback protocol)

TAS commands play back through SourcePauseTool and pause again automatically.

Usage:
  node scripts/manual-test.mjs [options] left <degrees>       turn while frozen
  node scripts/manual-test.mjs [options] right <degrees>
  node scripts/manual-test.mjs [options] up <degrees>
  node scripts/manual-test.mjs [options] down <degrees>
  node scripts/manual-test.mjs [options] screenshot <path>
  node scripts/manual-test.mjs [options] abort                 stop an active tas_run
  node scripts/manual-test.mjs [options] wait <ticks>          simulate N ticks
  node scripts/manual-test.mjs [options] run <steps.json>      play a raw step array
  node scripts/manual-test.mjs [options] demo                  canned walk/turn/jump plan

Options:
  --host <host>          SPT IPC host. Default: ${DEFAULT_HOST}
  --port <port>          SPT IPC port. Default: ${DEFAULT_PORT}
  --request-timeout <ms> Typed request timeout. Default: ${DEFAULT_REQUEST_TIMEOUT_MS}

Example steps.json:
  [
    { "ticks": 67, "keys": { "forward": true } },
    { "ticks": 1, "left": 30 },
    { "ticks": 3, "keys": { "blue": true } }
  ]
`);
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  },
);
