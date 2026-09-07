import { AsyncLocalStorage } from "node:async_hooks";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import test from "node:test";
import * as portalModule from "./index.mjs";
import { MAX_TAS_TICKS, createPortalController } from "./index.mjs";
import { closePortalRuntime, setupPortalRuntime } from "./scripts/portal-client.mjs";

const FRAME_TERMINATOR = "\0";

test("raw SPT command client is not exported", () => {
  assert.equal("SptCommandClient" in portalModule, false);
});

test("connecting does not send pause commands", async () => {
  const { close, port, seen } = await createMockSptServer();

  const portal = await createPortalController({
    host: "127.0.0.1",
    port,
  });

  try {
    assert.equal("freeze" in portal, false);
    assert.equal("resume" in portal, false);
  } finally {
    portal.close();
    await close();
  }

  assert.deepEqual(seen, []);
});

test("tas builder produces protocol steps and run() waits for tas_run_done", async () => {
  const { close, port, seen } = await createMockSptServer(({ message, write }) => {
    if (message.type === "tas_run") {
      write({ type: "tas_run", id: message.id, ok: true, steps: message.steps.length });
      write({
        type: "tas_run_done",
        id: message.id,
        ok: true,
        aborted: false,
        ticks: 74,
        angles: { pitch: 5, yaw: 135, roll: 12.5 },
      });
    }
  });

  const portal = await createPortalController({
    host: "127.0.0.1",
    port,
    requestTimeoutMs: 500,
  });

  try {
    const result = await portal
      .tas()
      .hold(67, { forward: true, crouch: true })
      .look({ left: 30 })
      .fire("blue")
      .jump()
      .run({ screenshot: false });

    assert.deepEqual(result, {
      ticks: 74,
      facing: { pitch: 5, yaw: 135, roll: 12.5 },
    });
  } finally {
    portal.close();
    await close();
  }

  assert.deepEqual(seen, [
    {
      type: "tas_run",
      id: 1,
      include_position: true,
      steps: [
        { ticks: 67, keys: { forward: true, duck: true } },
        { ticks: 1, yaw: 30 },
        { ticks: 3, keys: { attack: true } },
        { ticks: 30 },
        { ticks: 3, keys: { jump: true } },
      ],
    },
  ]);
});

test("run() takes an automatic screenshot after playback by default", async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const { close, port, seen } = await createMockSptServer(({ message, write }) => {
    if (message.type === "tas_run") {
      write({ type: "tas_run", id: message.id, ok: true });
      write({ type: "tas_run_done", id: message.id, ok: true, ticks: 10 });
    }
    if (message.type === "screenshot") {
      write({ type: "screenshot_ack", id: message.id });
      write({ type: "screenshot_begin", id: message.id, width: 2, height: 2 });
      write({ type: "screenshot_chunk", id: message.id, data: jpeg.toString("base64") });
      write({ type: "screenshot_end", id: message.id });
    }
  });

  const portal = await createPortalController({
    host: "127.0.0.1",
    port,
    requestTimeoutMs: 500,
  });

  try {
    const result = await portal.run([{ ticks: 10 }], { autoEmit: false });
    assert.equal(result.screenshots.length, 1);
    assert.equal(result.screenshots[0].url.startsWith("data:image/jpeg;base64,"), true);
  } finally {
    portal.close();
    await close();
  }

  assert.equal(seen[0].type, "tas_run");
  assert.equal(seen[1].type, "screenshot");
});

test("run() requests and returns final position by default", async () => {
  const { close, port, seen } = await createMockSptServer(({ message, write }) => {
    if (message.type === "tas_run") {
      write({ type: "tas_run", id: message.id, ok: true });
      write({
        type: "tas_run_done",
        id: message.id,
        ok: true,
        ticks: 8,
        facing: { pitch: -4, yaw: 75, roll: -6 },
        position: { x: 10.5, y: -20.25, z: 32 },
      });
    }
  });

  const portal = await createPortalController({
    host: "127.0.0.1",
    port,
    requestTimeoutMs: 500,
  });

  try {
    const result = await portal.run([{ ticks: 8 }], { screenshot: false });
    assert.deepEqual(result.facing, { pitch: -4, yaw: 75, roll: -6 });
    assert.deepEqual(result.position, { x: 10.5, y: -20.25, z: 32 });
    await portal.run([{ ticks: 1 }], { position: false, screenshot: false });
    await assert.rejects(
      () => portal.run([{ ticks: 1 }], { position: "yes", screenshot: false }),
      /position to be a boolean/,
    );
  } finally {
    portal.close();
    await close();
  }

  assert.deepEqual(seen, [
    {
      type: "tas_run",
      id: 1,
      steps: [{ ticks: 8 }],
      include_position: true,
    },
    {
      type: "tas_run",
      id: 2,
      steps: [{ ticks: 1 }],
    },
  ]);
});

test("friendly angles convert to Source-sign wire fields", async () => {
  const sent = [];
  const { close, port, seen } = await createMockSptServer(({ message, write }) => {
    if (message.type === "tas_run") {
      sent.push(message.steps);
      write({ type: "tas_run", id: message.id, ok: true });
      write({ type: "tas_run_done", id: message.id, ok: true, ticks: 4 });
    }
  });

  const portal = await createPortalController({
    host: "127.0.0.1",
    port,
    requestTimeoutMs: 500,
  });

  try {
    await portal.run(
      [
        { ticks: 1, left: 15 },
        { ticks: 1, right: 5, up: 2 },
        { ticks: 1, down: 3 },
        { ticks: 1, pitchTo: -10, yawTo: 90 },
      ],
      { screenshot: false },
    );
  } finally {
    portal.close();
    await close();
  }

  assert.deepEqual(sent, [
    [
      { ticks: 1, yaw: 15 },
      { ticks: 1, yaw: -5, pitch: -2 },
      { ticks: 1, pitch: 3 },
      { ticks: 1, pitch_to: -10, yaw_to: 90 },
    ],
  ]);
  assert.equal(seen.length, 1);
});

test("step validation rejects bad ticks, keys, and angle mixes", async () => {
  const { close, port } = await createMockSptServer(() => {});

  const portal = await createPortalController({
    host: "127.0.0.1",
    port,
    requestTimeoutMs: 500,
  });

  try {
    await assert.rejects(() => portal.run([], {}), /non-empty array/);
    await assert.rejects(() => portal.run([{ ticks: 0 }]), /tick count between 1 and/);
    await assert.rejects(() => portal.run([{ ticks: 1.5 }]), /tick count between 1 and/);
    await assert.rejects(() => portal.run([{ ticks: MAX_TAS_TICKS + 1 }]), /tick count between 1 and/);
    await assert.rejects(
      () => portal.run([{ ticks: MAX_TAS_TICKS }, { ticks: 1 }]),
      /TAS plan is too long/,
    );
    await assert.rejects(() => portal.run([{ ticks: 1, keys: { strafe: true } }]), /Unknown TAS key: strafe/);
    await assert.rejects(() => portal.run([{ ticks: 1, keys: { forward: 1 } }]), /must be true or false/);
    await assert.rejects(() => portal.run([{ ticks: 1, spin: 90 }]), /Unknown TAS angle field: spin/);
    await assert.rejects(() => portal.run([{ ticks: 1, left: -10 }]), /non-negative left angle/);
    await assert.rejects(
      () => portal.run([{ ticks: 1, left: 5, yawTo: 90 }]),
      /Cannot combine relative .* and absolute/,
    );
    assert.throws(() => portal.tas().wait(0), /tick count between 1 and/);
  } finally {
    portal.close();
    await close();
  }
});

test("tas_run failure responses reject the run", async () => {
  const { close, port } = await createMockSptServer(({ message, write }) => {
    if (message.type === "tas_run") {
      write({ type: "tas_run", id: message.id, ok: false, error: "a tas_run is already active" });
    }
  });

  const portal = await createPortalController({
    host: "127.0.0.1",
    port,
    requestTimeoutMs: 500,
  });

  try {
    await assert.rejects(
      () => portal.run([{ ticks: 5 }], { screenshot: false }),
      /SPT tas_run failed: a tas_run is already active/,
    );
  } finally {
    portal.close();
    await close();
  }
});

test("aborted playback resolves with aborted: true and the abort reason", async () => {
  const { close, port, seen } = await createMockSptServer(({ message, write }) => {
    if (message.type === "tas_run") {
      write({ type: "tas_run", id: message.id, ok: true });
      write({
        type: "tas_run_done",
        id: message.id,
        ok: true,
        aborted: true,
        reason: "aborted by client",
        ticks: 12,
      });
    }
    if (message.type === "tas_abort") {
      write({ type: "tas_abort", id: message.id, ok: true });
    }
  });

  const portal = await createPortalController({
    host: "127.0.0.1",
    port,
    requestTimeoutMs: 500,
  });

  try {
    const result = await portal.run([{ ticks: 500 }], { screenshot: false });
    assert.equal(result.aborted, true);
    assert.equal(result.reason, "aborted by client");
    assert.equal(result.ticks, 12);

    const abort = await portal.abort();
    assert.equal(abort, undefined);
  } finally {
    portal.close();
    await close();
  }

  assert.equal(seen[1].type, "tas_abort");
});

test("seconds() converts game time to ticks", async () => {
  const { close, port } = await createMockSptServer(() => {});
  const portal = await createPortalController({
    host: "127.0.0.1",
    port,
  });

  try {
    assert.equal(portal.seconds(1), 67);
    assert.equal(portal.seconds(0.5), 33);
    assert.equal(portal.seconds(0.001), 1);
    assert.throws(() => portal.seconds(0), /positive number of seconds/);
    assert.throws(() => portal.seconds(-2), /positive number of seconds/);
  } finally {
    portal.close();
    await close();
  }
});

test("relative look sends typed deltas with Portal sign mapping", async () => {
  const { close, port, seen } = await createMockSptServer(({ message, write }) => {
    if (message.type === "look_delta") {
      write({
        type: "look_delta",
        id: message.id,
        ok: true,
        old_angles: { pitch: 0, yaw: 90, roll: 0 },
        angles: { pitch: message.pitch, yaw: 90 + message.yaw, roll: 0 },
      });
    }
  });

  const portal = await createPortalController({
    host: "127.0.0.1",
    port,
    requestTimeoutMs: 500,
  });

  try {
    const response = await portal.look.left(15);
    await portal.look.right(5);
    await portal.look.down(2.5);
    await portal.look.up(1.25);
    assert.deepEqual(response, { facing: { pitch: 0, yaw: 105, roll: 0 } });
  } finally {
    portal.close();
    await close();
  }

  assert.deepEqual(seen, [
    { type: "look_delta", id: 1, pitch: 0, yaw: 15 },
    { type: "look_delta", id: 2, pitch: 0, yaw: -5 },
    { type: "look_delta", id: 3, pitch: 2.5, yaw: 0 },
    { type: "look_delta", id: 4, pitch: -1.25, yaw: 0 },
  ]);
});

test("relative look rejects SPT failure responses", async () => {
  const { close, port, seen } = await createMockSptServer(({ message, write }) => {
    if (message.type === "look_delta") {
      write({ type: "look_delta", id: message.id, ok: false, error: "angles unavailable" });
    }
  });

  const portal = await createPortalController({
    host: "127.0.0.1",
    port,
    requestTimeoutMs: 500,
  });

  try {
    await assert.rejects(() => portal.look.left(12), /SPT look_delta failed: angles unavailable/);
  } finally {
    portal.close();
    await close();
  }

  assert.deepEqual(seen, [{ type: "look_delta", id: 1, pitch: 0, yaw: 12 }]);
});

test("facing(), position(), and observe() read flat observations while paused", async () => {
  const { close, port, seen } = await createMockSptServer(({ message, write }) => {
    if (message.type === "observe") {
      const response = { type: "observe", id: message.id, ok: true };
      if (message.fields.includes("facing")) {
        response.facing = { pitch: 3, yaw: -45, roll: 7.5 };
      }
      if (message.fields.includes("position")) {
        response.position = { x: 100, y: 200.5, z: -12 };
      }
      write(response);
    }
  });

  const portal = await createPortalController({
    host: "127.0.0.1",
    port,
    requestTimeoutMs: 500,
  });

  try {
    assert.deepEqual(await portal.facing(), { pitch: 3, yaw: -45, roll: 7.5 });
    assert.deepEqual(await portal.position(), { x: 100, y: 200.5, z: -12 });
    assert.deepEqual(await portal.observe(["position", "facing", "position"]), {
      facing: { pitch: 3, yaw: -45, roll: 7.5 },
      position: { x: 100, y: 200.5, z: -12 },
    });
    await assert.rejects(() => portal.observe([]), /non-empty array/);
    await assert.rejects(() => portal.observe(["velocity"]), /Unknown observation field/);
  } finally {
    portal.close();
    await close();
  }

  assert.deepEqual(seen, [
    { type: "observe", id: 1, fields: ["facing"] },
    { type: "observe", id: 2, fields: ["position"] },
    { type: "observe", id: 3, fields: ["position", "facing"] },
  ]);
});

test("observations round to two decimals", async () => {
  const { close, port } = await createMockSptServer(({ message, write }) => {
    if (message.type === "observe") {
      write({
        type: "observe",
        id: message.id,
        ok: true,
        facing: { pitch: -1.2340000000000002, yaw: 44.999, roll: -9.876 },
        position: { x: 100.005, y: -0.001, z: 12.344 },
      });
    }
  });

  const portal = await createPortalController({
    host: "127.0.0.1",
    port,
    requestTimeoutMs: 500,
  });

  try {
    assert.deepEqual(await portal.observe(["facing", "position"]), {
      facing: { pitch: -1.23, yaw: 45, roll: -9.88 },
      position: { x: 100.01, y: 0, z: 12.34 },
    });
  } finally {
    portal.close();
    await close();
  }
});

test("position() reports the SPT permission denial explicitly", async () => {
  const { close, port } = await createMockSptServer(({ message, write }) => {
    if (message.type === "observe") {
      write({
        type: "observe",
        id: message.id,
        ok: true,
        unavailable: { position: "disabled" },
      });
    }
  });

  const portal = await createPortalController({
    host: "127.0.0.1",
    port,
    requestTimeoutMs: 500,
  });

  try {
    await assert.rejects(() => portal.position(), /SPT position unavailable: disabled/);
  } finally {
    portal.close();
    await close();
  }
});

test("setup closes stale global portal before opening a fresh SPT client", async () => {
  const closed = [];
  const globals = {
    portal: {
      close: () => closed.push("old"),
      tas: () => {},
      screenshot: () => {},
    },
  };
  const { close, port, seen } = await createMockSptServer(() => {});

  try {
    const portal = await setupPortalRuntime({
      globals,
      spt: {
        host: "127.0.0.1",
        port,
      },
    });

    assert.deepEqual(closed, ["old"]);
    assert.equal(globals.portal, portal);
    assert.deepEqual(seen, []);
  } finally {
    await closePortalRuntime({ globals });
    await close();
  }
});

test("screenshot returns and emits Computer Use-style screenshot entries", async () => {
  const firstChunk = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  const secondChunk = Buffer.from("screenshot bytes");
  const expected = Buffer.concat([firstChunk, secondChunk]);
  const execContext = new AsyncLocalStorage();
  const emittedImages = [];
  const previousNodeRepl = globalThis.nodeRepl;
  globalThis.nodeRepl = {
    emitImage: async (image) => {
      assert.equal(execContext.getStore(), "active");
      emittedImages.push(image);
    },
  };

  const { close, port, seen } = await createMockSptServer(({ message, write }) => {
    if (message.type === "screenshot") {
      write({ type: "screenshot_ack", id: message.id });
      write({ type: "screenshot_begin", id: message.id, width: 4, height: 3 });
      write({ type: "screenshot_chunk", id: message.id, data: firstChunk.toString("base64") });
      write({ type: "screenshot_chunk", id: message.id, data: secondChunk.toString("base64") });
      write({ type: "screenshot_end", id: message.id });
    }
  });

  const portal = await createPortalController({
    host: "127.0.0.1",
    port,
    requestTimeoutMs: 500,
  });

  try {
    const screenshot = await execContext.run("active", () => portal.screenshot());
    const expectedUrl = `data:image/jpeg;base64,${expected.toString("base64")}`;
    assert.equal("bytes" in screenshot, false);
    assert.equal("mimeType" in screenshot, false);
    assert.equal("url" in screenshot, false);
    assert.equal("id" in screenshot, false);
    assert.deepEqual(screenshot.screenshots, [
      {
        height: 3,
        url: expectedUrl,
        width: 4,
      },
    ]);
    assert.deepEqual(emittedImages, [expectedUrl]);
  } finally {
    if (previousNodeRepl === undefined) {
      delete globalThis.nodeRepl;
    } else {
      globalThis.nodeRepl = previousNodeRepl;
    }
    portal.close();
    await close();
  }

  assert.deepEqual(seen, [{ type: "screenshot", id: 1 }]);
});

test("portal_exec returns screenshot data only as image content", { timeout: 5000 }, async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const { close, port } = await createMockSptServer(({ message, write }) => {
    if (message.type === "tas_run") {
      write({ type: "tas_run", id: message.id, ok: true });
      write({
        type: "tas_run_done",
        id: message.id,
        ok: true,
        ticks: 1,
        angles: { pitch: 2, yaw: 90, roll: 0 },
      });
    }
    if (message.type === "screenshot") {
      write({ type: "screenshot_ack", id: message.id });
      write({ type: "screenshot_begin", id: message.id, width: 2, height: 2 });
      write({ type: "screenshot_chunk", id: message.id, data: jpeg.toString("base64") });
      write({ type: "screenshot_end", id: message.id });
    }
  });
  const mcp = createMcpTestServer({ port });

  try {
    const response = await mcp.request("tools/call", {
      name: "portal_exec",
      arguments: {
        code: "return await portal.screenshot();",
      },
    });

    const content = response.result.content;
    const text = content.find((item) => item.type === "text");
    const image = content.find((item) => item.type === "image");

    assert.equal(text, undefined);
    assert.equal(image.mimeType, "image/jpeg");
    assert.equal(image.data, jpeg.toString("base64"));

    const runResponse = await mcp.request("tools/call", {
      name: "portal_exec",
      arguments: {
        code: "return await portal.run([{ ticks: 1 }]);",
      },
    });
    const runContent = runResponse.result.content;
    const runText = runContent.find((item) => item.type === "text");
    const runImage = runContent.find((item) => item.type === "image");

    assert.ok(runText.text.includes('"ticks": 1'));
    assert.ok(runText.text.includes('"facing"'));
    assert.equal(runText.text.includes('"ok"'), false);
    assert.equal(runText.text.includes('"screenshots"'), false);
    assert.equal(runText.text.includes("data:image"), false);
    assert.equal(runImage.mimeType, "image/jpeg");
    assert.equal(runImage.data, jpeg.toString("base64"));
  } finally {
    await mcp.close();
    await close();
  }
});

test("portal_screenshot creates parent directories and saves without returning image content", async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x12, 0x34, 0xff, 0xd9]);
  const { close, port } = await createMockSptServer(({ message, write }) => {
    if (message.type === "screenshot") {
      write({ type: "screenshot_ack", id: message.id });
      write({ type: "screenshot_begin", id: message.id, width: 4, height: 3 });
      write({ type: "screenshot_chunk", id: message.id, data: jpeg.toString("base64") });
      write({ type: "screenshot_end", id: message.id });
    }
  });
  const directory = await mkdtemp(path.join(tmpdir(), "portal-screenshot-test-"));
  const savePath = path.join(directory, "missing", "nested", "capture.jpg");
  const mcp = createMcpTestServer({ port });

  try {
    const listed = await mcp.request("tools/list");
    const tool = listed.result.tools.find((entry) => entry.name === "portal_screenshot");
    assert.equal(tool.inputSchema.properties.savePath.type, "string");

    const response = await mcp.request("tools/call", {
      name: "portal_screenshot",
      arguments: { savePath },
    });

    assert.equal(response.result.isError, undefined);
    assert.deepEqual(response.result.content, [
      { type: "text", text: `Screenshot saved to ${path.resolve(savePath)}` },
    ]);
    assert.deepEqual(await readFile(savePath), jpeg);

    const imageResponse = await mcp.request("tools/call", {
      name: "portal_screenshot",
      arguments: {},
    });
    assert.deepEqual(imageResponse.result.content, [
      { type: "image", mimeType: "image/jpeg", data: jpeg.toString("base64") },
    ]);
  } finally {
    await mcp.close();
    await close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("portal_screenshot rejects an empty savePath before connecting to SPT", async () => {
  const { close, port } = await createMockSptServer(() => {
    assert.fail("invalid portal_screenshot arguments must not connect to SPT");
  });
  const mcp = createMcpTestServer({ port });

  try {
    const response = await mcp.request("tools/call", {
      name: "portal_screenshot",
      arguments: { savePath: "  " },
    });
    assert.equal(response.result.isError, true);
    assert.match(response.result.content[0].text, /savePath.*non-empty string/);
  } finally {
    await mcp.close();
    await close();
  }
});

test("portal_documentation exposes the supported API without connecting to SPT", async () => {
  const { close, port } = await createMockSptServer(() => {
    assert.fail("portal_documentation must not connect to SPT");
  });
  const mcp = createMcpTestServer({ port });

  try {
    const listed = await mcp.request("tools/list");
    assert.ok(listed.result.tools.some((tool) => tool.name === "portal_documentation"));
    const execTool = listed.result.tools.find((tool) => tool.name === "portal_exec");
    assert.doesNotMatch(execTool.description, /portal\.close/);

    const response = await mcp.request("tools/call", {
      name: "portal_documentation",
      arguments: {},
    });
    assert.equal(response.result.content.length, 1);
    assert.equal(response.result.content[0].type, "text");
    assert.match(response.result.content[0].text, /interface PortalController/);
    assert.match(response.result.content[0].text, /position\?: boolean/);
    assert.match(response.result.content[0].text, /type TasRunResult/);
    assert.match(response.result.content[0].text, /complete button state/);
    assert.doesNotMatch(response.result.content[0].text, /close\(\): void/);
    assert.doesNotMatch(response.result.content[0].text, /autoEmit|emit\?:/);
  } finally {
    await mcp.close();
    await close();
  }
});

test("portal_exec stringifies shared references and toJSON values faithfully", { timeout: 5000 }, async () => {
  const { close, port } = await createMockSptServer(() => {});
  const mcp = createMcpTestServer({ port });

  try {
    const shared = await mcp.request("tools/call", {
      name: "portal_exec",
      arguments: { code: "const f = { pitch: 1 }; return { a: f, b: f };" },
    });
    const sharedText = shared.result.content.find((item) => item.type === "text").text;
    assert.deepEqual(JSON.parse(sharedText), { a: { pitch: 1 }, b: { pitch: 1 } });

    const date = await mcp.request("tools/call", {
      name: "portal_exec",
      arguments: { code: "return { when: new Date(0), n: 3 };" },
    });
    const dateText = date.result.content.find((item) => item.type === "text").text;
    assert.deepEqual(JSON.parse(dateText), { when: "1970-01-01T00:00:00.000Z", n: 3 });

    const circular = await mcp.request("tools/call", {
      name: "portal_exec",
      arguments: { code: "const c = {}; c.self = c; return c;" },
    });
    const circularText = circular.result.content.find((item) => item.type === "text").text;
    assert.equal(circularText, "[object Object]");
  } finally {
    await mcp.close();
    await close();
  }
});

test("portal_exec cannot terminate local processes", async () => {
  const { close, port } = await createMockSptServer(() => {});
  const mcp = createMcpTestServer({ port });

  try {
    const response = await mcp.request("tools/call", {
      name: "portal_exec",
      arguments: {
        code: `
          const importedProcess = (await import("node:process")).default;
          const attempts = [
            ["kill", () => process.kill(process.pid, 0)],
            ["exit", () => process.exit(0)],
            ["abort", () => process.abort()],
            ["reallyExit", () => process.reallyExit(0)],
            ["_kill", () => importedProcess._kill(importedProcess.pid, 0)],
          ];
          return Object.fromEntries(attempts.map(([name, attempt]) => {
            try {
              attempt();
              return [name, { blocked: false }];
            } catch (error) {
              return [name, {
                blocked: error?.code === "ERR_PROCESS_TERMINATION_BLOCKED",
                code: error?.code,
                name: error?.name,
              }];
            }
          }));
        `,
      },
    });

    assert.equal(response.result.isError, undefined);
    const results = JSON.parse(response.result.content[0].text);
    assert.deepEqual(Object.keys(results), ["kill", "exit", "abort", "reallyExit", "_kill"]);
    for (const result of Object.values(results)) {
      assert.deepEqual(result, {
        blocked: true,
        code: "ERR_PROCESS_TERMINATION_BLOCKED",
        name: "ProcessTerminationBlockedError",
      });
    }

    const followUp = await mcp.request("ping");
    assert.deepEqual(followUp.result, {});
  } finally {
    await mcp.close();
    await close();
  }
});

test("screenshot converts SPT rgb8 payloads into JPEG data URLs", async () => {
  const rawRgb = Buffer.from([
    0xff,
    0x00,
    0x00,
    0x00,
    0xff,
    0x00,
  ]);

  const { close, port } = await createMockSptServer(({ message, write }) => {
    if (message.type === "screenshot") {
      write({ type: "screenshot_ack", id: message.id });
      write({
        type: "screenshot_begin",
        id: message.id,
        width: 2,
        height: 1,
        format: "rgb8",
        stride: 6,
      });
      write({ type: "screenshot_chunk", id: message.id, data: rawRgb.toString("base64") });
      write({ type: "screenshot_end", id: message.id });
    }
  });

  const portal = await createPortalController({
    host: "127.0.0.1",
    port,
    requestTimeoutMs: 500,
  });

  try {
    const screenshot = await portal.screenshot({ autoEmit: false });
    const url = screenshot.screenshots[0].url;
    const bytes = bytesFromDataUrl(url);

    assert.equal(url.startsWith("data:image/jpeg;base64,"), true);
    assert.deepEqual(Array.from(bytes.subarray(0, 4)), [0xff, 0xd8, 0xff, 0xe0]);
    assert.deepEqual(Array.from(bytes.subarray(-2)), [0xff, 0xd9]);
    assert.equal(bytes.includes(Buffer.from("JFIF", "ascii")), true);
    assertWellFormedJpegSegments(bytes);
  } finally {
    portal.close();
    await close();
  }
});

test("screenshot downscales rgb8 payloads to 360p unless fullRes is set", async () => {
  const width = 1280;
  const height = 720;
  const rawRgb = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      // Left half red, right half blue, so an averaged downscale keeps the split.
      rawRgb[offset + (x < width / 2 ? 0 : 2)] = 0xff;
    }
  }

  const { close, port } = await createMockSptServer(({ message, write }) => {
    if (message.type === "screenshot") {
      write({ type: "screenshot_ack", id: message.id });
      write({ type: "screenshot_begin", id: message.id, width, height, format: "rgb8" });
      write({ type: "screenshot_chunk", id: message.id, data: rawRgb.toString("base64") });
      write({ type: "screenshot_end", id: message.id });
    }
  });

  const portal = await createPortalController({
    host: "127.0.0.1",
    port,
    requestTimeoutMs: 2000,
  });

  try {
    const { screenshots } = await portal.screenshot({ autoEmit: false });
    assert.equal(screenshots[0].width, 640);
    assert.equal(screenshots[0].height, 360);

    const bytes = bytesFromDataUrl(screenshots[0].url);
    assertWellFormedJpegSegments(bytes);
    assert.deepEqual(Array.from(readJpegFrameSize(bytes)), [360, 640]);

    const full = await portal.screenshot({ autoEmit: false, fullRes: true });
    assert.equal(full.screenshots[0].width, 1280);
    assert.equal(full.screenshots[0].height, 720);
    assert.deepEqual(Array.from(readJpegFrameSize(bytesFromDataUrl(full.screenshots[0].url))), [720, 1280]);
  } finally {
    portal.close();
    await close();
  }
});

test("screenshot rejects malformed chunk data", async () => {
  const { close, port } = await createMockSptServer(({ message, write }) => {
    if (message.type === "screenshot") {
      write({ type: "screenshot_ack", id: message.id });
      write({ type: "screenshot_begin", id: message.id });
      write({ type: "screenshot_chunk", id: message.id, data: "not-base64!" });
    }
  });

  const portal = await createPortalController({
    host: "127.0.0.1",
    port,
    requestTimeoutMs: 500,
  });

  try {
    await assert.rejects(() => portal.screenshot(), /Malformed base64 data in screenshot_chunk\.data/);
  } finally {
    portal.close();
    await close();
  }
});

test("screenshot times out when the response is incomplete", async () => {
  const { close, port } = await createMockSptServer(({ message, write }) => {
    if (message.type === "screenshot") {
      write({ type: "screenshot_ack", id: message.id });
      write({ type: "screenshot_begin", id: message.id });
    }
  });

  const portal = await createPortalController({
    host: "127.0.0.1",
    port,
    requestTimeoutMs: 50,
  });

  try {
    await assert.rejects(() => portal.screenshot(), /Timed out waiting for SPT screenshot response/);
  } finally {
    portal.close();
    await close();
  }
});

async function createMockSptServer(onMessage) {
  const seen = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";

    socket.on("data", (chunk) => {
      buffer += chunk;
      while (buffer.includes(FRAME_TERMINATOR)) {
        const index = buffer.indexOf(FRAME_TERMINATOR);
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!frame) {
          continue;
        }

        const message = JSON.parse(frame);
        seen.push(message);
        Promise.resolve(
          onMessage?.({
            message,
            seen,
            socket,
            write: (response) => writeFrame(socket, response),
          }),
        ).catch((error) => socket.destroy(error));
      }
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    close: () =>
      new Promise((resolve, reject) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      }),
    port,
    seen,
  };
}

function writeFrame(socket, message) {
  socket.write(`${JSON.stringify(message)}${FRAME_TERMINATOR}`);
}

function createMcpTestServer({ port }) {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./mcp/portal-mcp-server.mjs", import.meta.url))], {
    cwd: fileURLToPath(new URL(".", import.meta.url)),
    env: {
      ...process.env,
      PORTAL_SPT_HOST: "127.0.0.1",
      PORTAL_SPT_PORT: String(port),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let nextId = 1;
  let stdoutBuffer = "";
  let stderrBuffer = "";
  let closed = false;
  const pending = new Map();

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    while (stdoutBuffer.includes("\n")) {
      const index = stdoutBuffer.indexOf("\n");
      const line = stdoutBuffer.slice(0, index).replace(/\r$/, "");
      stdoutBuffer = stdoutBuffer.slice(index + 1);
      if (!line.trim()) {
        continue;
      }

      const message = JSON.parse(line);
      const request = pending.get(message.id);
      if (request) {
        clearTimeout(request.timer);
        pending.delete(message.id);
        request.resolve(message);
      }
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderrBuffer += chunk;
  });

  child.once("close", (code, signal) => {
    closed = true;
    const error = new Error(`MCP test server exited early (${code ?? signal}): ${stderrBuffer}`);
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  });

  return {
    request(method, params) {
      const id = nextId;
      nextId += 1;
      const payload = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Timed out waiting for MCP response to ${method}.`));
        }, 2000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(payload);
      });
    },
    close() {
      if (closed) {
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(graceTimer);
          clearTimeout(forceTimer);
          resolve();
        };
        const graceTimer = setTimeout(() => {
          if (!closed && !child.killed) {
            child.kill();
          }
        }, 100);
        const forceTimer = setTimeout(() => {
          if (!closed && !child.killed) {
            child.kill("SIGKILL");
          }
          finish();
        }, 1000);
        child.once("close", finish);
        if (closed) {
          finish();
          return;
        }
        if (!child.stdin.destroyed) {
          child.stdin.end();
        }
      });
    },
  };
}

function bytesFromDataUrl(url) {
  const match = /^data:[^;,]+;base64,([A-Za-z0-9+/=]+)$/.exec(url);
  if (!match) {
    throw new Error("Expected data URL.");
  }
  return Buffer.from(match[1], "base64");
}

// Returns [height, width] from the JPEG SOF0 header.
function readJpegFrameSize(bytes) {
  for (let offset = 2; offset + 9 < bytes.length; ) {
    assert.equal(bytes[offset], 0xff, `Expected JPEG marker at byte ${offset}.`);
    const marker = bytes[offset + 1];
    const length = bytes.readUInt16BE(offset + 2);
    if (marker === 0xc0) {
      return [bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 7)];
    }
    offset += 2 + length;
  }
  assert.fail("JPEG did not include an SOF0 marker.");
}

function assertWellFormedJpegSegments(bytes) {
  assert.deepEqual(Array.from(bytes.subarray(0, 2)), [0xff, 0xd8]);

  let offset = 2;
  while (offset < bytes.length) {
    assert.equal(bytes[offset], 0xff, `Expected JPEG marker at byte ${offset}.`);
    const marker = bytes[offset + 1];
    offset += 2;

    if (marker === 0xd9) {
      return;
    }

    assert.ok(offset + 2 <= bytes.length, `JPEG marker 0x${marker.toString(16)} is missing its length.`);
    const length = bytes.readUInt16BE(offset);
    assert.ok(length >= 2, `JPEG marker 0x${marker.toString(16)} has an invalid length.`);
    const payloadStart = offset + 2;
    const payloadEnd = offset + length;
    assert.ok(payloadEnd <= bytes.length, `JPEG marker 0x${marker.toString(16)} exceeds the file length.`);

    if (marker === 0xc4) {
      const counts = bytes.subarray(payloadStart + 1, payloadStart + 17);
      const symbolCount = counts.reduce((sum, value) => sum + value, 0);
      assert.equal(
        payloadEnd - (payloadStart + 17),
        symbolCount,
        "JPEG Huffman table symbol count must match the segment length.",
      );
    }

    if (marker === 0xda) {
      offset = payloadEnd;
      while (offset < bytes.length - 1) {
        if (bytes[offset] === 0xff) {
          if (bytes[offset + 1] === 0x00) {
            offset += 2;
            continue;
          }
          assert.equal(bytes[offset + 1], 0xd9, "JPEG entropy data contains an unexpected marker.");
          return;
        }
        offset += 1;
      }
      assert.fail("JPEG entropy data did not end with an EOI marker.");
    }

    offset = payloadEnd;
  }

  assert.fail("JPEG did not include an EOI marker.");
}
