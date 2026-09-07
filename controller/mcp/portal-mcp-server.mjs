#!/usr/bin/env node
// Self-contained stdio MCP server for the Portal plugin.
//
// Speaks JSON-RPC 2.0 over newline-delimited stdin/stdout (the MCP stdio
// transport) with zero external dependencies. It holds ONE persistent
// PortalController for the life of the process, so the SPT IPC socket survives
// between tool invocations. TAS playback is handled by SPT and pauses again
// after the planned ticks.
//
// Tools exposed:
//   portal_exec       Run a snippet of JS against the live `portal` controller.
//   portal_documentation Return the supported `portal` JavaScript API reference.
//   portal_screenshot Capture a screenshot and return it or save it to a file.
//
// All diagnostics go to stderr; stdout carries ONLY framed JSON-RPC.

// Must come first: locks down networking and scrubs the environment before
// any other module loads or any portal_exec snippet can run.
import "./hardening.mjs";

import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createPortalController } from "../index.mjs";

const SERVER_NAME = "portal";
const SERVER_VERSION = "0.1.0";
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

const SPT_OPTIONS = {
  host: process.env.PORTAL_SPT_HOST || "127.0.0.1",
  port: process.env.PORTAL_SPT_PORT ? Number(process.env.PORTAL_SPT_PORT) : 27182,
};

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const DATA_IMAGE_URL_RE = /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi;
const EXACT_DATA_IMAGE_URL_RE = /^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/i;
const PORTAL_DOCUMENTATION = readFileSync(
  new URL("./portal-documentation.md", import.meta.url),
  "utf8",
);

// --- Persistent controller -------------------------------------------------

let controller = null;
let connecting = null;

async function getPortal() {
  if (controller) {
    return controller;
  }
  if (!connecting) {
    connecting = createPortalController({ spt: SPT_OPTIONS })
      .then((created) => {
        controller = created;
        connecting = null;
        return created;
      })
      .catch((error) => {
        connecting = null;
        throw error;
      });
  }
  return connecting;
}

function dropController() {
  if (controller) {
    try {
      controller.close();
    } catch {
      // ignore
    }
  }
  controller = null;
}

// --- Image capture hook ----------------------------------------------------
// index.mjs' screenshot() auto-emits by calling globalThis.nodeRepl.emitImage(url).
// We install that hook so screenshots taken from inside portal_exec are
// captured and returned as MCP image content. `capturedImages` is safe as a
// module-global because tool calls are serialized through `callQueue`.

let capturedImages = [];

globalThis.nodeRepl = {
  emitImage(url) {
    if (typeof url === "string") {
      capturedImages.push(url);
    }
  },
  write(text) {
    process.stderr.write(`[portal_exec] ${text}\n`);
  },
};

function dataUrlToImageContent(url) {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(url);
  if (!match) {
    return null;
  }
  return { type: "image", mimeType: match[1], data: match[2] };
}

// --- Tool implementations --------------------------------------------------

async function runExec({ code }) {
  if (typeof code !== "string" || !code.trim()) {
    throw new Error("portal_exec requires a non-empty `code` string.");
  }

  const portal = await getPortal();
  globalThis.portal = portal;
  capturedImages = [];

  const fn = new AsyncFunction("portal", `"use strict";\n${code}`);
  const value = await fn(portal);

  const content = [];
  const imageUrls = capturedImages.slice();
  if (value !== undefined) {
    const text = stringifyResult(value, imageUrls);
    if (text !== null) {
      content.push({ type: "text", text });
    }
  }
  for (const url of imageUrls) {
    const image = dataUrlToImageContent(url);
    if (image) {
      content.push(image);
    }
  }
  if (content.length === 0) {
    content.push({ type: "text", text: "ok" });
  }
  return { content };
}

async function runScreenshot({ savePath } = {}) {
  if (savePath !== undefined && (typeof savePath !== "string" || !savePath.trim())) {
    throw new Error("portal_screenshot `savePath` must be a non-empty string.");
  }

  const portal = await getPortal();
  capturedImages = [];
  // Explicit captures return the native backbuffer; only the automatic
  // screenshots that ride along with portal_exec results are downscaled.
  const result = await portal.screenshot({ fullRes: true });
  const content = [];

  if (savePath !== undefined) {
    const shot = result.screenshots?.[0];
    const image = shot ? dataUrlToImageContent(shot.url) : null;
    if (!image) {
      throw new Error("Screenshot captured but no image data returned.");
    }

    const absolutePath = resolve(savePath);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, Buffer.from(image.data, "base64"));
    return {
      content: [{ type: "text", text: `Screenshot saved to ${absolutePath}` }],
    };
  }

  for (const shot of result.screenshots ?? []) {
    const image = dataUrlToImageContent(shot.url);
    if (image) {
      content.push(image);
    }
  }
  if (content.length === 0) {
    content.push({ type: "text", text: "Screenshot captured but no image data returned." });
  }
  return { content };
}

function runDocumentation() {
  return { content: [{ type: "text", text: PORTAL_DOCUMENTATION }] };
}

function stringifyResult(value, imageUrls = []) {
  if (typeof value === "string") {
    if (EXACT_DATA_IMAGE_URL_RE.test(value)) {
      addImageUrl(imageUrls, value);
      return null;
    }
    return sanitizeImageDataUrls(value, imageUrls) || null;
  }

  let text;
  try {
    // JSON.stringify natively honors toJSON, prints shared (non-circular)
    // references, and throws only on true cycles; the replacer just diverts
    // image data URLs into `imageUrls` and keeps BigInt from throwing.
    text = JSON.stringify(value, imageStrippingReplacer(imageUrls), 2);
  } catch {
    text = sanitizeImageDataUrls(String(value), imageUrls);
  }

  if (text == null || text === "") {
    return null;
  }
  if (isScreenshotOnlyResult(value) && imageUrls.length > 0) {
    return null;
  }
  return text;
}

function imageStrippingReplacer(imageUrls) {
  return (key, value) => {
    // Screenshot entries carry nothing the agent needs beyond the image
    // itself, so once the urls are diverted into image content the whole
    // array is dropped instead of leaving `{ width, height }` residue.
    if (key === "screenshots" && isScreenshotEntryArray(value)) {
      for (const entry of value) {
        addImageUrl(imageUrls, entry.url);
      }
      return undefined;
    }
    if (typeof value === "string") {
      if (EXACT_DATA_IMAGE_URL_RE.test(value)) {
        addImageUrl(imageUrls, value);
        return undefined; // drops the key in objects; arrays get null
      }
      return sanitizeImageDataUrls(value, imageUrls);
    }
    if (typeof value === "bigint") {
      return `${value}n`;
    }
    return value;
  };
}

function sanitizeImageDataUrls(text, imageUrls) {
  return text.replace(DATA_IMAGE_URL_RE, (url) => {
    addImageUrl(imageUrls, url);
    return "";
  });
}

function addImageUrl(imageUrls, url) {
  if (dataUrlToImageContent(url) && !imageUrls.includes(url)) {
    imageUrls.push(url);
  }
}

function isScreenshotEntryArray(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        typeof entry.url === "string" &&
        EXACT_DATA_IMAGE_URL_RE.test(entry.url),
    )
  );
}

function isScreenshotOnlyResult(value) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    Array.isArray(value.screenshots)
  );
}

const TOOLS = [
  {
    name: "portal_exec",
    description:
      "Run async JavaScript against Portal through SPT; `portal` is in scope. Use `return <value>` " +
      "for text results. Screenshots are returned as images.\n" +
      "TAS: `const t = portal.tas()`, queue inputs, then `await t.run(options)` (~67 ticks/s). " +
      "`t.hold(ticks, keys, angles?)` holds the exact key set; keys are forward, back, left, right, " +
      "jump, duck, use, attack, attack2 (aliases: crouch, blue, orange). Helpers: wait, tap, jump, " +
      "use, fire, and look. Angles use relative up/down/left/right or absolute pitchTo/yawTo.\n" +
      "A run returns `{ ticks, aborted?, reason?, facing?, position? }` plus a 360p screenshot. " +
      "Run options include `{ screenshot: false, position: false, fullRes: true }`.\n" +
      "While paused: `portal.look.left/right/up/down(degrees)`, `portal.facing()`, `portal.position()`, " +
      "`portal.observe(['facing', 'position'])`, and `portal.screenshot()`. Also available: " +
      "`portal.run(steps)`, `portal.seconds(s)`, and `portal.abort()`.",
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "JavaScript executed as an async function body with `portal` in scope.",
        },
      },
      required: ["code"],
    },
  },
  {
    name: "portal_documentation",
    description:
      "Return the complete supported JavaScript API reference for the `portal` object used inside " +
      "portal_exec. Call this when exact methods, arguments, option fields, or result types are needed.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "portal_screenshot",
    description:
      "Capture a full-resolution screenshot of Portal through SPT. By default it is returned as " +
      "an image. Pass `savePath` to save the JPEG to that file instead, without returning the " +
      "image to the agent. ",
    inputSchema: {
      type: "object",
      properties: {
        savePath: {
          type: "string",
          description:
            "Optional file path where the JPEG should be saved instead of returned; " +
            "relative paths use the MCP server's working directory, missing parent directories are " +
            "created, and existing files are overwritten.",
        },
      },
    },
  },
];

async function callTool(name, args) {
  switch (name) {
    case "portal_exec":
      return runExec(args ?? {});
    case "portal_documentation":
      return runDocumentation();
    case "portal_screenshot":
      return runScreenshot(args ?? {});
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// --- JSON-RPC plumbing -----------------------------------------------------

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

// Serialize tool calls so capturedImages never interleaves between requests.
let callQueue = Promise.resolve();

async function handleMessage(msg) {
  if (msg === null || typeof msg !== "object") {
    return;
  }
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;

  switch (method) {
    case "initialize": {
      const protocolVersion = params?.protocolVersion ?? DEFAULT_PROTOCOL_VERSION;
      sendResult(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
      return;
    }
    case "notifications/initialized":
    case "initialized":
      return; // notification, no response
    case "ping":
      if (isRequest) sendResult(id, {});
      return;
    case "tools/list":
      sendResult(id, { tools: TOOLS });
      return;
    case "tools/call": {
      const name = params?.name;
      const args = params?.arguments;
      callQueue = callQueue.then(async () => {
        try {
          const result = await callTool(name, args);
          sendResult(id, result);
        } catch (error) {
          // Drop a potentially-dead controller so the next call reconnects.
          if (/socket|connect|closed|ECONN|timed out/i.test(String(error?.message))) {
            dropController();
          }
          sendResult(id, {
            content: [{ type: "text", text: `Error: ${error?.message ?? String(error)}` }],
            isError: true,
          });
        }
      });
      return;
    }
    default:
      if (isRequest) {
        sendError(id, -32601, `Method not found: ${method}`);
      }
      return;
  }
}

// --- stdin line framing ----------------------------------------------------

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newline).replace(/\r$/, "");
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) {
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      process.stderr.write(`[portal-mcp] failed to parse line: ${error}\n`);
      continue;
    }
    Promise.resolve(handleMessage(parsed)).catch((error) => {
      process.stderr.write(`[portal-mcp] handler error: ${error}\n`);
    });
  }
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  dropController();
}

process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

process.stderr.write(`[portal-mcp] ${SERVER_NAME} v${SERVER_VERSION} ready (SPT ${SPT_OPTIONS.host}:${SPT_OPTIONS.port})\n`);
