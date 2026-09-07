import net from "node:net";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 27182;
const DEFAULT_CONNECT_TIMEOUT_MS = 1500;
const DEFAULT_REQUEST_TIMEOUT_MS = 5000;
const DEFAULT_TAS_RUN_HEADROOM_MS = 15000;
const DEFAULT_JPEG_QUALITY = 85;
// Screenshots are downscaled to 360p (aspect ratio preserved) before JPEG
// encoding, so the agent gets a legible frame without paying for a
// full-resolution backbuffer. Pass { fullRes: true } for the native size.
const SCREENSHOT_360P_HEIGHT = 360;
const FRAME_TERMINATOR = "\0";
const IPC_TIMEOUT_HINT =
  "SPT may still have an older IPC client connected; close stale portal runtimes or toggle y_spt_ipc off/on.";

// Portal simulates 66.67 ticks per second (0.015 s tick interval).
export const TICKS_PER_SECOND = 1 / 0.015;
export const MAX_TAS_TICKS = 6600;

const DEFAULT_TAP_TICKS = 3;
// use() and fire() default to a short press plus settle time (~half a second
// total) so their results are visible without an explicit wait().
const DEFAULT_ACTION_TICKS = 33;

// Key names understood by SPT's tas_run, plus friendly aliases.
const TAS_KEYS = ["forward", "back", "left", "right", "jump", "duck", "use", "attack", "attack2"];
const TAS_KEY_ALIASES = {
  crouch: "duck",
  blue: "attack",
  orange: "attack2",
};

class SptCommandClient {
  constructor(options = {}) {
    this.host = options.host ?? DEFAULT_HOST;
    this.port = options.port ?? DEFAULT_PORT;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

    this.socket = null;
    this.connected = false;
    this.connectPromise = null;
    this.closed = false;
    this.pendingRequests = new Map();
    this.readBuffer = "";
    this.nextRequestId = 1;
  }

  async connect() {
    if (this.connected) {
      return this;
    }
    if (this.connectPromise) {
      await this.connectPromise;
      return this;
    }
    if (this.closed) {
      throw new Error("Cannot reconnect a closed SptCommandClient.");
    }

    this.connectPromise = new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        socket.destroy();
        reject(new Error(`Timed out connecting to SPT IPC at ${this.host}:${this.port}.`));
      }, this.connectTimeoutMs);

      socket.once("connect", () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        this.socket = socket;
        this.connected = true;
        resolve();
      });

      socket.on("data", (chunk) => this.#handleData(chunk));
      socket.on("error", (error) => {
        this.#rejectPending(error);
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      });
      socket.on("close", () => {
        this.connected = false;
        this.#rejectPending(new Error("SPT IPC socket closed."));
      });
    });

    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }

    return this;
  }

  async lookDelta({ pitch = 0, yaw = 0 } = {}, options = {}) {
    const nextPitch = normalizeAngleNumber("pitch", pitch);
    const nextYaw = normalizeAngleNumber("yaw", yaw);

    return this.#request(
      "look_delta",
      { pitch: nextPitch, yaw: nextYaw },
      {
        description: "SPT look_delta response",
        timeoutMs: options.timeoutMs,
        handleMessage: async (message, pending) => {
          if (!isObjectMessage(message) || message.type !== "look_delta") {
            return false;
          }
          if (message.ok === false) {
            throw new Error(`SPT look_delta failed: ${message.error ?? "unknown error"}`);
          }
          if (message.ok !== true) {
            throw new Error("SPT look_delta response did not include ok: true.");
          }
          pending.resolve(message);
          return true;
        },
      },
    );
  }

  async observe(fields, options = {}) {
    const normalized = normalizeObservationFields(fields);

    return this.#request(
      "observe",
      { fields: normalized },
      {
        description: "SPT observe response",
        timeoutMs: options.timeoutMs,
        handleMessage: async (message, pending) => {
          if (!isObjectMessage(message) || message.type !== "observe") {
            return false;
          }
          if (message.ok === false) {
            throw new Error(`SPT observe failed: ${message.error ?? "unknown error"}`);
          }
          if (message.ok !== true) {
            throw new Error("SPT observe response did not include ok: true.");
          }

          const result = {};
          const facing = anglesToFacing(message.facing);
          const position = normalizePosition(message.position);
          if (facing) {
            result.facing = facing;
          }
          if (position) {
            result.position = position;
          }
          if (isObjectMessage(message.unavailable)) {
            result.unavailable = message.unavailable;
          }
          pending.resolve(result);
          return true;
        },
      },
    );
  }

  async tasRun(steps, options = {}) {
    const normalized = normalizeTasSteps(steps);
    const totalTicks = normalized.reduce((sum, step) => sum + step.ticks, 0);
    if (options.position !== undefined && typeof options.position !== "boolean") {
      throw new Error(`Expected position to be a boolean, got ${options.position}.`);
    }
    // Playback takes totalTicks * 15 ms of real time. A transition-aborted
    // agent run does not complete until the destination map has loaded,
    // settled, and TAS-paused, so leave additional headroom for that cycle.
    const timeoutMs = options.timeoutMs ?? Math.ceil(totalTicks * 15 * 2) + DEFAULT_TAS_RUN_HEADROOM_MS;
    const payload = { steps: normalized };
    if (options.position ?? true) {
      payload.include_position = true;
    }

    return this.#request(
      "tas_run",
      payload,
      {
        description: "SPT tas_run completion",
        timeoutMs,
        handleMessage: async (message, pending) => {
          if (!isObjectMessage(message)) {
            return false;
          }
          if (message.type === "tas_run") {
            if (message.ok === false) {
              throw new Error(`SPT tas_run failed: ${message.error ?? "unknown error"}`);
            }
            // Accepted; keep waiting for tas_run_done.
            return true;
          }
          if (message.type === "tas_run_done") {
            // Failure paths throw, and fields that carry no information are
            // omitted: `aborted`/`reason` appear only on an abort, and
            // facing/position only when SPT reported them.
            const result = {
              ticks: message.ticks ?? totalTicks,
            };
            if (message.aborted === true) {
              result.aborted = true;
              if (typeof message.reason === "string" && message.reason) {
                result.reason = message.reason;
              }
            }
            const facing = anglesToFacing(message.facing) ?? anglesToFacing(message.angles);
            if (facing) {
              result.facing = facing;
            }
            const position = normalizePosition(message.position);
            if (position) {
              result.position = position;
            }
            if (isObjectMessage(message.unavailable)) {
              result.unavailable = message.unavailable;
            }
            pending.resolve(result);
            return true;
          }
          return false;
        },
      },
    );
  }

  async tasAbort(options = {}) {
    return this.#request(
      "tas_abort",
      {},
      {
        description: "SPT tas_abort response",
        timeoutMs: options.timeoutMs,
        handleMessage: async (message, pending) => {
          if (!isObjectMessage(message) || message.type !== "tas_abort") {
            return false;
          }
          if (message.ok === false) {
            throw new Error(`SPT tas_abort failed: ${message.error ?? "unknown error"}`);
          }
          pending.resolve();
          return true;
        },
      },
    );
  }

  async screenshot(options = {}) {
    const chunks = [];
    const state = {
      ack: null,
      begin: null,
    };

    const result = await this.#request(
      "screenshot",
      {},
      {
        description: "SPT screenshot response",
        timeoutMs: options.timeoutMs,
        handleMessage: (message, pending) => {
          if (!isObjectMessage(message) || !isScreenshotMessage(message)) {
            return false;
          }
          if (message.ok === false) {
            throw new Error(`SPT screenshot failed: ${message.error ?? "unknown error"}`);
          }

          if (message.type === "screenshot_ack") {
            state.ack = message;
            return true;
          }

          if (!state.ack) {
            throw new Error(`Received ${message.type} before screenshot_ack.`);
          }

          if (message.type === "screenshot_begin") {
            state.begin = message;
            return true;
          }

          if (!state.begin) {
            throw new Error(`Received ${message.type} before screenshot_begin.`);
          }

          if (message.type === "screenshot_chunk") {
            chunks.push(decodeBase64Chunk(message.data));
            return true;
          }

          if (message.type === "screenshot_end") {
            const rawBytes = Buffer.concat(chunks);
            const encoded = encodeScreenshotBytes(rawBytes, state.begin, message, {
              fullRes: options.fullRes,
              quality: options.quality,
            });
            const url = toDataUrl(encoded.bytes, encoded.mimeType);
            const screenshot = {
              height: normalizeOptionalDimension(encoded.height ?? state.begin?.height),
              url,
              width: normalizeOptionalDimension(encoded.width ?? state.begin?.width),
            };
            const result = {
              screenshots: [screenshot],
            };
            pending.resolve(result);
            return true;
          }

          return false;
        },
      },
    );

    // Internal harness control: agent-facing documentation intentionally omits
    // this option. RunOptions.screenshot controls whether capture happens.
    if (options.autoEmit ?? true) {
      for (const screenshot of result.screenshots) {
        await emitImage(screenshot.url);
      }
    }

    return result;
  }

  close() {
    this.closed = true;
    this.connected = false;
    this.#rejectPending(new Error("SPT IPC client closed."));
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }

  async #writeMessage(message) {
    const socket = this.socket;
    if (!socket || !this.connected) {
      throw new Error("SPT IPC socket is not connected.");
    }

    const payload = JSON.stringify(message) + FRAME_TERMINATOR;
    await new Promise((resolve, reject) => {
      socket.write(payload, (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  async #request(type, payload, options) {
    const id = this.#allocateRequestId();
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    const description = options.description ?? `SPT ${type} response`;
    const message = { type, id, ...payload };

    await this.connect();

    const key = requestKey(id);
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pendingRequests.get(key);
        if (pending) {
          pending.reject(
            new Error(`Timed out waiting for ${description} for id ${id} after ${timeoutMs} ms. ${IPC_TIMEOUT_HINT}`),
          );
        }
      }, timeoutMs);

      this.pendingRequests.set(key, {
        id,
        key,
        type,
        handleMessage: options.handleMessage,
        resolve: (value) => {
          clearTimeout(timer);
          this.pendingRequests.delete(key);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          this.pendingRequests.delete(key);
          reject(error);
        },
      });
    });
    response.catch(() => {});

    try {
      await this.#writeMessage(message);
    } catch (error) {
      const pending = this.pendingRequests.get(key);
      if (pending) {
        pending.reject(error);
      }
      throw error;
    }

    return response;
  }

  #handleData(chunk) {
    this.readBuffer += chunk.toString("utf8");

    while (this.readBuffer.includes(FRAME_TERMINATOR)) {
      const index = this.readBuffer.indexOf(FRAME_TERMINATOR);
      const frame = this.readBuffer.slice(0, index);
      this.readBuffer = this.readBuffer.slice(index + 1);

      if (!frame) {
        continue;
      }

      let message;
      try {
        message = JSON.parse(frame);
      } catch {
        message = frame;
      }

      if (this.#handlePendingRequestMessage(message)) {
        continue;
      }

    }
  }

  #rejectPending(error) {
    for (const pending of Array.from(this.pendingRequests.values())) {
      pending.reject(error);
    }
  }

  #handlePendingRequestMessage(message) {
    if (!isObjectMessage(message) || message.id === undefined) {
      return false;
    }

    const pending = this.pendingRequests.get(requestKey(message.id));
    if (!pending) {
      return false;
    }

    try {
      Promise.resolve(pending.handleMessage(message, pending)).catch((error) => {
        pending.reject(error);
      });
      return true;
    } catch (error) {
      pending.reject(error);
      return true;
    }
  }

  #allocateRequestId() {
    let id = this.nextRequestId;
    do {
      id = this.nextRequestId;
      this.nextRequestId += 1;
      if (this.nextRequestId > Number.MAX_SAFE_INTEGER) {
        this.nextRequestId = 1;
      }
    } while (this.pendingRequests.has(requestKey(id)));
    return id;
  }
}

// Builds a list of tas_run steps. Each step holds an exact button state for an
// exact number of ticks, optionally turning the view at the step's first tick.
// Nothing is sent until run() is called.
class TasBuilder {
  #portal;

  constructor(portal) {
    this.#portal = portal;
    this.steps = [];
  }

  // Hold exactly these keys (all others released) for `ticks` ticks.
  // Optional `angles` turn the view on the step's first tick.
  hold(ticks, keys = {}, angles = {}) {
    this.steps.push(buildTasStep(ticks, keys, angles));
    return this;
  }

  // Let the game simulate with no input.
  wait(ticks) {
    return this.hold(ticks);
  }

  // Press a single key briefly (e.g. "jump", "use", "blue", "orange").
  tap(key, ticks = DEFAULT_TAP_TICKS) {
    return this.hold(ticks, { [key]: true });
  }

  // Turn the view: { up, down, left, right } in degrees, or absolute
  // { pitchTo, yawTo } in Source angles. Takes `ticks` ticks (default 1).
  look(angles, ticks = 1) {
    return this.hold(ticks, {}, angles);
  }

  // Fire the blue or orange portal: a short press, then settle time so the
  // result is visible without an explicit wait(). `ticks` is the total
  // duration; the press itself stays brief to avoid held-trigger refire.
  fire(color, ticks = DEFAULT_ACTION_TICKS) {
    return this.#pressAndSettle(color, ticks);
  }

  jump(ticks = DEFAULT_TAP_TICKS) {
    return this.tap("jump", ticks);
  }

  // Tap +use with settle time, like fire(). `ticks` is the total duration.
  use(ticks = DEFAULT_ACTION_TICKS) {
    return this.#pressAndSettle("use", ticks);
  }

  #pressAndSettle(key, ticks) {
    const total = normalizeTickCount(ticks);
    const press = Math.min(DEFAULT_TAP_TICKS, total);
    this.tap(key, press);
    if (total > press) {
      this.wait(total - press);
    }
    return this;
  }

  get totalTicks() {
    return this.steps.reduce((sum, step) => sum + step.ticks, 0);
  }

  // Play the plan back: SPT simulates every step, then pauses again.
  // Resolves with the result (and a screenshot by default).
  run(options = {}) {
    const steps = this.steps;
    this.steps = [];
    return this.#portal.run(steps, options);
  }
}

export class PortalController {
  #client;

  constructor(client) {
    this.#client = client;
    this.look = createLookApi(client);
  }

  // Start building a TAS plan while the game stays frozen.
  tas() {
    return new TasBuilder(this);
  }

  // Play back raw steps (the shape TasBuilder produces). SPT simulates the
  // steps tick by tick, pauses again, and (by default) returns a screenshot of
  // the result.
  async run(steps, options = {}) {
    const result = await this.#client.tasRun(steps, options);
    if (options.screenshot ?? true) {
      const shot = await this.#client.screenshot(options);
      result.screenshots = shot.screenshots;
    }
    return result;
  }

  // Convert seconds of game time to ticks.
  seconds(value) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      throw new Error(`Expected a positive number of seconds, got ${value}.`);
    }
    return Math.max(1, Math.round(seconds * TICKS_PER_SECOND));
  }

  // Stop an in-flight tas_run early; SPT releases all keys and re-pauses.
  async abort() {
    return this.#client.tasAbort();
  }

  observe(fields, options) {
    return this.#client.observe(fields, options);
  }

  async facing(options) {
    const result = await this.observe(["facing"], options);
    if (!result.facing) {
      throw new Error(`SPT facing unavailable: ${observationUnavailableReason(result, "facing")}.`);
    }
    return result.facing;
  }

  async position(options) {
    const result = await this.observe(["position"], options);
    if (!result.position) {
      throw new Error(`SPT position unavailable: ${observationUnavailableReason(result, "position")}.`);
    }
    return result.position;
  }

  screenshot(options) {
    return this.#client.screenshot(options);
  }

  close() {
    this.#client.close();
  }
}

export async function createPortalController(options = {}) {
  const client = new SptCommandClient(options.spt ?? options);
  await client.connect();
  return new PortalController(client);
}

export const createPortal = createPortalController;

function buildTasStep(ticks, keys = {}, angles = {}) {
  const step = { ticks: normalizeTickCount(ticks) };

  const normalizedKeys = normalizeTasKeys(keys);
  if (Object.keys(normalizedKeys).length > 0) {
    step.keys = normalizedKeys;
  }

  Object.assign(step, normalizeTasAngles(angles));
  return step;
}

function normalizeTasSteps(steps) {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error("tas_run needs a non-empty array of steps.");
  }

  let totalTicks = 0;
  const normalized = steps.map((step, index) => {
    if (typeof step !== "object" || step === null) {
      throw new Error(`steps[${index}] must be an object.`);
    }
    const { ticks, keys, ...angles } = step;
    const built = buildTasStep(ticks, keys ?? {}, angles);
    totalTicks += built.ticks;
    return built;
  });

  if (totalTicks > MAX_TAS_TICKS) {
    throw new Error(
      `TAS plan is too long: ${totalTicks} ticks exceeds the limit of ${MAX_TAS_TICKS} (~${Math.round(MAX_TAS_TICKS / TICKS_PER_SECOND)} s).`,
    );
  }

  return normalized;
}

function normalizeTickCount(value) {
  const ticks = Number(value);
  if (!Number.isInteger(ticks) || ticks <= 0 || ticks > MAX_TAS_TICKS) {
    throw new Error(`Expected a tick count between 1 and ${MAX_TAS_TICKS}, got ${value}.`);
  }
  return ticks;
}

function normalizeTasKeys(keys) {
  const normalized = {};
  for (const [name, pressed] of Object.entries(keys ?? {})) {
    const key = TAS_KEY_ALIASES[name] ?? name;
    if (!TAS_KEYS.includes(key)) {
      throw new Error(
        `Unknown TAS key: ${name}. Use one of ${TAS_KEYS.join(", ")} (aliases: crouch, blue, orange).`,
      );
    }
    if (typeof pressed !== "boolean") {
      throw new Error(`TAS key ${name} must be true or false, got ${pressed}.`);
    }
    if (pressed) {
      normalized[key] = true;
    }
  }
  return normalized;
}

// Accepts intuitive directions ({ up, down, left, right } in degrees), raw
// Source deltas ({ pitch, yaw }), or absolutes ({ pitchTo, yawTo }) and
// produces the wire fields SPT expects (pitch/yaw deltas, pitch_to/yaw_to).
function normalizeTasAngles(angles) {
  const out = {};
  const source = angles ?? {};

  const known = ["up", "down", "left", "right", "pitch", "yaw", "pitchTo", "yawTo", "pitch_to", "yaw_to"];
  for (const name of Object.keys(source)) {
    if (!known.includes(name)) {
      throw new Error(`Unknown TAS angle field: ${name}. Use up/down/left/right, pitch/yaw, or pitchTo/yawTo.`);
    }
  }

  const up = readAngle(source, "up", true);
  const down = readAngle(source, "down", true);
  const left = readAngle(source, "left", true);
  const right = readAngle(source, "right", true);
  const rawPitch = readAngle(source, "pitch", false);
  const rawYaw = readAngle(source, "yaw", false);
  const pitchTo = readAngle(source, "pitchTo", false) ?? readAngle(source, "pitch_to", false);
  const yawTo = readAngle(source, "yawTo", false) ?? readAngle(source, "yaw_to", false);

  // Source signs: positive pitch looks down, positive yaw turns left.
  const pitchDelta = (down ?? 0) - (up ?? 0) + (rawPitch ?? 0);
  const yawDelta = (left ?? 0) - (right ?? 0) + (rawYaw ?? 0);

  const hasPitchDelta = up !== undefined || down !== undefined || rawPitch !== undefined;
  const hasYawDelta = left !== undefined || right !== undefined || rawYaw !== undefined;

  if (hasPitchDelta && pitchTo !== undefined) {
    throw new Error("Cannot combine relative (up/down/pitch) and absolute (pitchTo) pitch in one step.");
  }
  if (hasYawDelta && yawTo !== undefined) {
    throw new Error("Cannot combine relative (left/right/yaw) and absolute (yawTo) yaw in one step.");
  }

  if (hasPitchDelta && pitchDelta !== 0) {
    out.pitch = pitchDelta;
  }
  if (hasYawDelta && yawDelta !== 0) {
    out.yaw = yawDelta;
  }
  if (pitchTo !== undefined) {
    out.pitch_to = pitchTo;
  }
  if (yawTo !== undefined) {
    out.yaw_to = yawTo;
  }

  return out;
}

function readAngle(source, name, mustBeNonNegative) {
  if (source[name] === undefined) {
    return undefined;
  }
  const value = Number(source[name]);
  if (!Number.isFinite(value)) {
    throw new Error(`Expected a finite ${name} angle, got ${source[name]}.`);
  }
  if (mustBeNonNegative && value < 0) {
    throw new Error(`Expected a non-negative ${name} angle, got ${source[name]}.`);
  }
  return value;
}

// SPT reports raw doubles; two decimals is well past what the agent can act on
// and keeps float noise like -1.2340000000000002 out of the tool output.
function round2(value) {
  return Math.round(value * 100) / 100 + 0;
}

function anglesToFacing(angles) {
  return typeof angles?.pitch === "number" &&
    typeof angles?.yaw === "number" &&
    typeof angles?.roll === "number"
    ? { pitch: round2(angles.pitch), yaw: round2(angles.yaw), roll: round2(angles.roll) }
    : null;
}

function normalizePosition(position) {
  return typeof position?.x === "number" &&
    Number.isFinite(position.x) &&
    typeof position?.y === "number" &&
    Number.isFinite(position.y) &&
    typeof position?.z === "number" &&
    Number.isFinite(position.z)
    ? { x: round2(position.x), y: round2(position.y), z: round2(position.z) }
    : null;
}

function normalizeObservationFields(fields) {
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new Error("observe() needs a non-empty array of fields.");
  }

  const normalized = [];
  for (const field of fields) {
    if (field !== "facing" && field !== "position") {
      throw new Error(`Unknown observation field: ${field}. Use facing or position.`);
    }
    if (!normalized.includes(field)) {
      normalized.push(field);
    }
  }
  return normalized;
}

function observationUnavailableReason(result, field) {
  const reason = result?.unavailable?.[field];
  return typeof reason === "string" && reason ? reason : "not returned by SPT";
}

// Aim while the game is frozen: the rendered view updates even when paused,
// so the agent can look around, screenshot, and line up a shot before running
// a TAS plan.
function createLookApi(client) {
  async function turn(pitch, yaw) {
    const response = await client.lookDelta({ pitch, yaw });
    const facing = anglesToFacing(response?.facing) ?? anglesToFacing(response?.angles);
    return facing ? { facing } : {};
  }

  return {
    left: (angle) => turn(0, normalizeAngleMagnitude("left", angle)),
    right: (angle) => turn(0, -normalizeAngleMagnitude("right", angle)),
    down: (angle) => turn(normalizeAngleMagnitude("down", angle), 0),
    up: (angle) => turn(-normalizeAngleMagnitude("up", angle), 0),
  };
}

function normalizeAngleNumber(name, value) {
  const angle = Number(value);
  if (!Number.isFinite(angle)) {
    throw new Error(`Expected a finite ${name} angle, got ${value}.`);
  }
  return angle;
}

function normalizeAngleMagnitude(name, value) {
  const angle = normalizeAngleNumber(name, value);
  if (angle < 0) {
    throw new Error(`Expected a non-negative ${name} angle, got ${value}.`);
  }
  return angle;
}

function isObjectMessage(message) {
  return typeof message === "object" && message !== null;
}

function isScreenshotMessage(message) {
  return (
    message.type === "screenshot_ack" ||
    message.type === "screenshot_begin" ||
    message.type === "screenshot_chunk" ||
    message.type === "screenshot_end"
  );
}

function requestKey(id) {
  return String(id);
}

function decodeBase64Chunk(data) {
  if (typeof data !== "string") {
    throw new Error("Expected screenshot_chunk.data to be a base64 string.");
  }

  const cleaned = data.replace(/\s+/g, "");
  const validBase64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
  if (cleaned.length % 4 !== 0 || !validBase64.test(cleaned)) {
    throw new Error("Malformed base64 data in screenshot_chunk.data.");
  }

  return Buffer.from(cleaned, "base64");
}

function extractMimeType(message) {
  const value = message.mimeType ?? message.mime_type ?? message.contentType ?? message.content_type;
  return typeof value === "string" && value ? value : null;
}

function encodeScreenshotBytes(bytes, begin, end, options = {}) {
  const format = begin?.format ?? end?.format;
  if (format === "rgb8") {
    return encodeRgb8Jpeg(bytes, {
      fullRes: options.fullRes === true,
      height: normalizeRequiredDimension("height", begin?.height),
      quality: options.quality ?? DEFAULT_JPEG_QUALITY,
      stride: normalizeOptionalStride(begin?.stride),
      width: normalizeRequiredDimension("width", begin?.width),
    });
  }

  return {
    bytes,
    mimeType: extractMimeType(end) ?? extractMimeType(begin) ?? "image/jpeg",
  };
}

function encodeRgb8Jpeg(rgbBytes, { width, height, stride, quality, fullRes }) {
  const rowBytes = width * 3;
  const sourceStride = stride ?? rowBytes;
  const expectedBytes = sourceStride * height;
  if (rgbBytes.length < expectedBytes) {
    throw new Error(
      `RGB screenshot data is too short: expected at least ${expectedBytes} bytes, got ${rgbBytes.length}.`,
    );
  }

  const target = fullRes ? { height, width } : fit360p(width, height);
  let pixels = rgbBytes;
  let pixelStride = sourceStride;
  if (target.width !== width || target.height !== height) {
    pixels = downscaleRgb8(rgbBytes, { height, stride: sourceStride, target, width });
    pixelStride = target.width * 3;
  }

  return {
    bytes: new JpegEncoder(target.width, target.height, quality).encode(pixels, pixelStride),
    height: target.height,
    mimeType: "image/jpeg",
    width: target.width,
  };
}

// Box filter: each destination pixel averages the source rectangle it covers.
// Cheap enough for a 1080p frame and much less aliased than nearest neighbour.
function downscaleRgb8(rgbBytes, { width, height, stride, target }) {
  const out = Buffer.allocUnsafe(target.width * target.height * 3);

  for (let destY = 0; destY < target.height; destY += 1) {
    const startY = Math.floor((destY * height) / target.height);
    const endY = Math.max(startY + 1, Math.floor(((destY + 1) * height) / target.height));

    for (let destX = 0; destX < target.width; destX += 1) {
      const startX = Math.floor((destX * width) / target.width);
      const endX = Math.max(startX + 1, Math.floor(((destX + 1) * width) / target.width));

      let red = 0;
      let green = 0;
      let blue = 0;
      let samples = 0;

      for (let sourceY = startY; sourceY < endY; sourceY += 1) {
        let offset = sourceY * stride + startX * 3;
        for (let sourceX = startX; sourceX < endX; sourceX += 1) {
          red += rgbBytes[offset];
          green += rgbBytes[offset + 1];
          blue += rgbBytes[offset + 2];
          offset += 3;
          samples += 1;
        }
      }

      const destOffset = (destY * target.width + destX) * 3;
      out[destOffset] = red / samples;
      out[destOffset + 1] = green / samples;
      out[destOffset + 2] = blue / samples;
    }
  }

  return out;
}

function fit360p(width, height) {
  if (height <= SCREENSHOT_360P_HEIGHT) {
    return { height, width };
  }

  return {
    height: SCREENSHOT_360P_HEIGHT,
    width: Math.max(1, Math.round((width * SCREENSHOT_360P_HEIGHT) / height)),
  };
}

function normalizeRequiredDimension(name, value) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`RGB screenshot response did not include a positive ${name}.`);
  }
  return value;
}

function normalizeOptionalStride(value) {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`RGB screenshot response included an invalid stride: ${value}.`);
  }
  return value;
}

function toDataUrl(bytes, mimeType) {
  return `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
}

function normalizeOptionalDimension(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

async function emitImage(url) {
  const nodeReplEmitImage = globalThis.nodeRepl?.emitImage;
  if (typeof nodeReplEmitImage === "function") {
    await nodeReplEmitImage.call(globalThis.nodeRepl, url);
    return;
  }

  const codexEmitImage = globalThis.codex?.emitImage;
  if (typeof codexEmitImage === "function") {
    await codexEmitImage.call(globalThis.codex, {
      type: "input_image",
      image_url: url,
      detail: "original",
    });
  }
}

const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10,
  17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34,
  27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36,
  29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46,
  53, 60, 61, 54, 47, 55, 62, 63,
];

const STD_LUMINANCE_QT = [
  16, 11, 10, 16, 24, 40, 51, 61,
  12, 12, 14, 19, 26, 58, 60, 55,
  14, 13, 16, 24, 40, 57, 69, 56,
  14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77,
  24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101,
  72, 92, 95, 98, 112, 100, 103, 99,
];

const STD_CHROMINANCE_QT = [
  17, 18, 24, 47, 99, 99, 99, 99,
  18, 21, 26, 66, 99, 99, 99, 99,
  24, 26, 56, 99, 99, 99, 99, 99,
  47, 66, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
];

const Y_DC_NR_CODES = [0, 0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const UV_DC_NR_CODES = [0, 0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
const DC_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

const Y_AC_NR_CODES = [0, 0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const Y_AC_VALUES = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12,
  0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
  0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08,
  0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
  0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16,
  0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
  0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39,
  0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
  0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59,
  0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
  0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79,
  0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
  0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98,
  0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
  0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6,
  0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
  0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4,
  0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea,
  0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa,
];

const UV_AC_NR_CODES = [0, 0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77];
const UV_AC_VALUES = [
  0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21,
  0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71,
  0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91,
  0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0,
  0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34,
  0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
  0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38,
  0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48,
  0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58,
  0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68,
  0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78,
  0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
  0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96,
  0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5,
  0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4,
  0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3,
  0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2,
  0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
  0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9,
  0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa,
];

const COSINES = createCosineTable();

class JpegEncoder {
  constructor(width, height, quality) {
    this.width = width;
    this.height = height;
    this.yTable = createQuantTable(STD_LUMINANCE_QT, quality);
    this.uvTable = createQuantTable(STD_CHROMINANCE_QT, quality);
    this.yDcTable = createHuffmanTable(Y_DC_NR_CODES, DC_VALUES);
    this.uvDcTable = createHuffmanTable(UV_DC_NR_CODES, DC_VALUES);
    this.yAcTable = createHuffmanTable(Y_AC_NR_CODES, Y_AC_VALUES);
    this.uvAcTable = createHuffmanTable(UV_AC_NR_CODES, UV_AC_VALUES);
    this.bytes = [];
    this.bitBuffer = 0;
    this.bitCount = 0;
    this.previousY = 0;
    this.previousCb = 0;
    this.previousCr = 0;
  }

  encode(rgbBytes, stride) {
    this.writeMarker(0xffd8);
    this.writeApp0();
    this.writeDqt();
    this.writeSof0();
    this.writeDht();
    this.writeSos();

    for (let y = 0; y < this.height; y += 8) {
      for (let x = 0; x < this.width; x += 8) {
        const blocks = this.readBlocks(rgbBytes, stride, x, y);
        this.previousY = this.writeBlock(blocks.y, this.yTable, this.previousY, this.yDcTable, this.yAcTable);
        this.previousCb = this.writeBlock(blocks.cb, this.uvTable, this.previousCb, this.uvDcTable, this.uvAcTable);
        this.previousCr = this.writeBlock(blocks.cr, this.uvTable, this.previousCr, this.uvDcTable, this.uvAcTable);
      }
    }

    this.flushBits();
    this.writeMarker(0xffd9);
    return Buffer.from(this.bytes);
  }

  readBlocks(rgbBytes, stride, blockX, blockY) {
    const y = new Array(64);
    const cb = new Array(64);
    const cr = new Array(64);

    for (let row = 0; row < 8; row += 1) {
      const sourceY = Math.min(blockY + row, this.height - 1);
      for (let col = 0; col < 8; col += 1) {
        const sourceX = Math.min(blockX + col, this.width - 1);
        const sourceOffset = sourceY * stride + sourceX * 3;
        const r = rgbBytes[sourceOffset];
        const g = rgbBytes[sourceOffset + 1];
        const b = rgbBytes[sourceOffset + 2];
        const index = row * 8 + col;
        y[index] = 0.299 * r + 0.587 * g + 0.114 * b - 128;
        cb[index] = -0.168736 * r - 0.331264 * g + 0.5 * b;
        cr[index] = 0.5 * r - 0.418688 * g - 0.081312 * b;
      }
    }

    return { cb, cr, y };
  }

  writeBlock(samples, quantTable, previousDc, dcTable, acTable) {
    const coefficients = quantizeBlock(samples, quantTable);
    const dc = coefficients[0];
    this.writeCoefficient(dc - previousDc, dcTable);

    let zeroRun = 0;
    for (let i = 1; i < 64; i += 1) {
      const value = coefficients[ZIGZAG[i]];
      if (value === 0) {
        zeroRun += 1;
        continue;
      }
      while (zeroRun > 15) {
        this.writeBits(acTable[0xf0]);
        zeroRun -= 16;
      }
      const category = coefficientCategory(value);
      this.writeBits(acTable[(zeroRun << 4) + category]);
      this.writeBits(coefficientBits(value, category));
      zeroRun = 0;
    }
    if (zeroRun > 0) {
      this.writeBits(acTable[0x00]);
    }

    return dc;
  }

  writeCoefficient(value, table) {
    const category = coefficientCategory(value);
    this.writeBits(table[category]);
    if (category > 0) {
      this.writeBits(coefficientBits(value, category));
    }
  }

  writeApp0() {
    this.writeMarker(0xffe0);
    this.writeWord(16);
    this.writeBytes([0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  }

  writeDqt() {
    this.writeMarker(0xffdb);
    this.writeWord(132);
    this.writeByte(0);
    this.writeQuantTable(this.yTable);
    this.writeByte(1);
    this.writeQuantTable(this.uvTable);
  }

  writeSof0() {
    this.writeMarker(0xffc0);
    this.writeWord(17);
    this.writeByte(8);
    this.writeWord(this.height);
    this.writeWord(this.width);
    this.writeByte(3);
    this.writeBytes([1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1]);
  }

  writeDht() {
    this.writeHuffmanTable(0x00, Y_DC_NR_CODES, DC_VALUES);
    this.writeHuffmanTable(0x10, Y_AC_NR_CODES, Y_AC_VALUES);
    this.writeHuffmanTable(0x01, UV_DC_NR_CODES, DC_VALUES);
    this.writeHuffmanTable(0x11, UV_AC_NR_CODES, UV_AC_VALUES);
  }

  writeSos() {
    this.writeMarker(0xffda);
    this.writeWord(12);
    this.writeByte(3);
    this.writeBytes([1, 0x00, 2, 0x11, 3, 0x11, 0, 0x3f, 0]);
  }

  writeHuffmanTable(info, counts, values) {
    this.writeMarker(0xffc4);
    this.writeWord(3 + 16 + values.length);
    this.writeByte(info);
    for (let i = 1; i <= 16; i += 1) {
      this.writeByte(counts[i]);
    }
    this.writeBytes(values);
  }

  writeQuantTable(table) {
    for (let i = 0; i < 64; i += 1) {
      this.writeByte(table[ZIGZAG[i]]);
    }
  }

  writeBits(bits) {
    for (let i = bits.length - 1; i >= 0; i -= 1) {
      this.bitBuffer = (this.bitBuffer << 1) | ((bits.value >> i) & 1);
      this.bitCount += 1;
      if (this.bitCount === 8) {
        this.writeByte(this.bitBuffer);
        if (this.bitBuffer === 0xff) {
          this.writeByte(0);
        }
        this.bitBuffer = 0;
        this.bitCount = 0;
      }
    }
  }

  flushBits() {
    if (this.bitCount > 0) {
      this.writeBits({ length: 8 - this.bitCount, value: (1 << (8 - this.bitCount)) - 1 });
    }
  }

  writeMarker(marker) {
    this.writeWord(marker);
  }

  writeWord(value) {
    this.writeByte((value >> 8) & 0xff);
    this.writeByte(value & 0xff);
  }

  writeBytes(values) {
    for (const value of values) {
      this.writeByte(value);
    }
  }

  writeByte(value) {
    this.bytes.push(value & 0xff);
  }
}

function createQuantTable(baseTable, quality) {
  const normalizedQuality = Math.min(100, Math.max(1, Math.round(quality)));
  const scale = normalizedQuality < 50 ? 5000 / normalizedQuality : 200 - normalizedQuality * 2;
  return baseTable.map((value) => Math.min(255, Math.max(1, Math.floor((value * scale + 50) / 100))));
}

function createHuffmanTable(counts, values) {
  const table = [];
  let code = 0;
  let position = 0;
  for (let length = 1; length <= 16; length += 1) {
    for (let i = 0; i < counts[length]; i += 1) {
      table[values[position]] = { length, value: code };
      code += 1;
      position += 1;
    }
    code <<= 1;
  }
  return table;
}

function createCosineTable() {
  const table = [];
  for (let frequency = 0; frequency < 8; frequency += 1) {
    table[frequency] = [];
    for (let sample = 0; sample < 8; sample += 1) {
      table[frequency][sample] = Math.cos(((2 * sample + 1) * frequency * Math.PI) / 16);
    }
  }
  return table;
}

function quantizeBlock(samples, quantTable) {
  const coefficients = new Array(64);
  for (let v = 0; v < 8; v += 1) {
    for (let u = 0; u < 8; u += 1) {
      let sum = 0;
      for (let y = 0; y < 8; y += 1) {
        for (let x = 0; x < 8; x += 1) {
          sum += samples[y * 8 + x] * COSINES[u][x] * COSINES[v][y];
        }
      }
      const cu = u === 0 ? Math.SQRT1_2 : 1;
      const cv = v === 0 ? Math.SQRT1_2 : 1;
      coefficients[v * 8 + u] = Math.round((0.25 * cu * cv * sum) / quantTable[v * 8 + u]);
    }
  }
  return coefficients;
}

function coefficientCategory(value) {
  let absValue = Math.abs(value);
  let category = 0;
  while (absValue > 0) {
    category += 1;
    absValue >>= 1;
  }
  return category;
}

function coefficientBits(value, category) {
  if (value >= 0) {
    return { length: category, value };
  }
  return { length: category, value: value + (1 << category) - 1 };
}
