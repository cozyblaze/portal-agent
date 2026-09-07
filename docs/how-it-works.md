# How it works

**The game pauses between decisions.** The agent can take as long as it needs to inspect the scene and plan its next move.

1. Look at a screenshot, player position, and camera angles.
2. Choose camera turns and button presses, with a duration for each action.
3. Play those inputs, pause again, and inspect the result.

The controls cover walking, jumping, crouching, using objects, and firing portals. The agent's game interaction stayed within its provided tools.

## Game settings

`sv_cheats 1` made debugging and testing commands available. Movement settings reduced sliding so the controls were more accurate. The game ran at roughly 67 simulation ticks per second.

<details>
<summary>Exact settings</summary>

| Setting | Value |
| --- | --- |
| `sv_cheats` | `1` |
| `sv_accelerate` | `100` |
| `sv_friction` | `100` |
| `sv_stopspeed` | `200` |
| `fps_max` | `66.666667` |
| `engine_no_focus_sleep` | `0` |
| `y_spt_ipc_expose_position` | `1` |

The [game configuration](../game-config/autoexec.cfg) applies the movement and frame-rate values through `y_spt_cvar`.

</details>

## Running the session

I gave the initial goal, resumed after capacity errors, and switched to Fast mode. The agent handled gameplay for the whole session. My only additional instruction was to leave the credits rolling.

Web search and general shell/browser tools were disabled. The new context management system supplied history/note tools. The livestream overlay hooks are optional and omitted here.

Codex sends JavaScript to a local MCP server, which connects to custom SourcePauseTool (SPT) code inside Portal. SPT runs the inputs and returns screenshots and observations.

- `portal_documentation` explains the API.
- `portal_screenshot` returns a full-resolution image.
- `portal_exec` runs a plan or reads the current position and view.

A plan can contain up to 1,000 steps and 6,600 ticks (about 99 seconds). Automatic screenshots are reduced to 360 pixels high. See the [full API reference](../controller/mcp/portal-documentation.md).

The server uses Node filesystem permissions and restricts networking to SPT at `127.0.0.1:27182`. Source Unpack supplies SST and the recording plugin; `start_run` uses the latter to record across map changes and retries.

[Set up your own run](setup.md) · [Read the session](../evidence/README.md)
