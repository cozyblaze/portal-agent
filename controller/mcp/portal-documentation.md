# Portal JavaScript API Reference

This is the supported `portal` JavaScript API surface available inside
`portal_exec`. The `portal` object is already constructed and connected by the
MCP server.

```ts
interface PortalController {
  tas(): TasBuilder;                       // Start building a TAS plan.
  run(steps: NonEmptyTasSteps, options?: RunOptions): Promise<TasRunResult>; // Play 1..1000 raw steps.
  look: PortalLookApi;                     // Relative view turns while paused.
  facing(options?: RequestOptions): Promise<Facing>; // Read current view without changing it.
  position(options?: RequestOptions): Promise<Position>; // Read world-space player origin.
  observe(fields: NonEmptyObservationFields, options?: RequestOptions): Promise<Observation>;
  seconds(value: number): number;          // Positive finite seconds -> nearest tick (~66.7/s, minimum 1).
  abort(): Promise<void>;                  // Stop an active tas_run; rejects if none is active.
  screenshot(options?: ScreenshotOptions): Promise<ScreenshotResult>;
}

interface TasBuilder {
  steps: WireTasStep[];                    // Normalized steps queued so far (SPT wire shape).
  totalTicks: number;
  hold(ticks: number, keys?: TasKeys, angles?: TasAngles): this;
  wait(ticks: number): this;
  tap(key: TasKeyName, ticks?: number): this;   // default 3 ticks
  jump(ticks?: number): this;                   // default 3 ticks
  use(ticks?: number): this;                    // 3-tick press + settle wait; `ticks` is the TOTAL (default 33, ~0.5 s)
  fire(color: "blue" | "orange", ticks?: number): this; // same press+settle shape as use()
  look(angles: TasAngles, ticks?: number): this; // default 1 tick
  run(options?: RunOptions): Promise<TasRunResult>; // Consumes the queued steps.
}

type TasKeyName =
  | "forward" | "back" | "left" | "right"
  | "jump" | "duck" | "use" | "attack" | "attack2"
  | "crouch" | "blue" | "orange";          // aliases for duck/attack/attack2

type TasKeys = Partial<Record<TasKeyName, boolean>>;

type TasAngles = {
  up?: number; down?: number; left?: number; right?: number; // relative degrees (non-negative)
  pitch?: number; yaw?: number;            // raw Source deltas (pitch > 0 down, yaw > 0 left)
  pitchTo?: number; yawTo?: number;        // absolute Source angles
  pitch_to?: number; yaw_to?: number;      // accepted SPT wire aliases for pitchTo/yawTo
};

type TasStep = {
  ticks: number;                           // integer 1..6600
  keys?: TasKeys;
} & TasAngles;

type WireTasStep = {
  ticks: number;
  keys?: TasKeys;
  pitch?: number; yaw?: number;
  pitch_to?: number; yaw_to?: number;
};

type NonEmptyTasSteps = [TasStep, ...TasStep[]]; // 1..1000 steps; plan total <= 6600 ticks

type RunOptions = Omit<ScreenshotOptions, "timeoutMs"> & {
  screenshot?: boolean;                    // default true: screenshot after playback
  position?: boolean;                      // default true: request final player origin
  timeoutMs?: number;                      // TAS completion timeout; default 2x nominal playback + 15 s
                                             // Also used for the automatic screenshot request.
};

type Facing = { pitch: number; yaw: number; roll: number };
type Position = { x: number; y: number; z: number }; // world-space player origin
type ObservationField = "facing" | "position";
type NonEmptyObservationFields = [ObservationField, ...ObservationField[]];
type Observation = {
  facing?: Facing;
  position?: Position;
  unavailable?: Partial<Record<ObservationField, string>>;
};

// Failures reject with an Error; fields that carry no information are omitted.
type TasRunResult = {
  ticks: number;                           // simulated ticks
  aborted?: true;                          // present only when playback was aborted
  reason?: string;                         // abort reason, present only when aborted
  facing?: Facing;                         // view after playback (Source angles), when reported
  position?: Position;                     // present by default when available
  unavailable?: Partial<Record<ObservationField, string>>;
  screenshots?: Array<PortalScreenshot>;   // present unless { screenshot: false }
};

interface PortalLookApi {
  left(angle: number): Promise<LookResult>;  // angle must be finite and non-negative
  right(angle: number): Promise<LookResult>; // angle must be finite and non-negative
  up(angle: number): Promise<LookResult>;    // angle must be finite and non-negative
  down(angle: number): Promise<LookResult>;  // angle must be finite and non-negative
}

type LookResult = {
  facing?: Facing;                         // view after the turn, when reported
};

type RequestOptions = {
  timeoutMs?: number;                      // request timeout override; default 5 s
};

type ScreenshotOptions = RequestOptions & {
  fullRes?: boolean;                       // default false: reduce images taller than 360 px to 360 px
  quality?: number;                        // JPEG quality; default 85, rounded and clamped to 1..100
};

type ScreenshotResult = {
  screenshots: Array<PortalScreenshot>;
};

type PortalScreenshot = {
  url: string;
  width?: number;
  height?: number;
};
```

## Direct screenshot tool

The standalone MCP tool `portal_screenshot` captures at full resolution and
returns an image block by default. Pass `{ savePath: "path/to/screenshot.jpg" }`
to save the JPEG to that file instead. In save mode, the tool returns only a
text confirmation and does not show the image to the agent. Missing parent
directories are created automatically, and an existing file is overwritten.

## Execution semantics

A `TasBuilder` queues its plan locally; no game input is sent until `run()` is
called. Calling `run()` consumes the queued steps, plays them in order, and
pauses the game again after playback.

Every `hold()` or raw `TasStep` describes the complete button state for that
step. Keys omitted from a step are released. To keep holding a key across
consecutive steps, include it in every step.

Relative or absolute angle changes are applied immediately on the step's first
tick. Relative and absolute angles cannot be mixed for the same axis in one
step.

Each TAS step must use an integer tick count from 1 through 6600. A run must
contain 1 through 1000 steps, and their combined duration must not exceed 6600
ticks.

## State across `portal_exec` calls

Each `portal_exec` snippet runs as the body of a new async function. Local
`const`, `let`, and `var` declarations therefore last only for that tool call:

```js
const position = await portal.position();
return position;
```

The MCP server itself is a persistent Node.js process. To retain state across
calls, store it on `globalThis`, preferably under a single namespaced property:

```js
globalThis.portalState ??= {
  attempts: 0,
  positions: [],
};

globalThis.portalState.attempts += 1;
globalThis.portalState.positions.push(await portal.position());
return globalThis.portalState;
```

A later call can read or update the same value:

```js
return globalThis.portalState?.positions.at(-1);
```

Values stored this way remain live JavaScript values rather than serialized
copies, so objects, functions, and class instances can persist. State lasts
only for the lifetime of the MCP server process and is lost when that process
exits or restarts. Avoid overwriting server-owned globals, especially
`globalThis.portal` and `globalThis.nodeRepl`.
