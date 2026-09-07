# Run it on Windows

These steps were tested with a fresh **Source Unpack 2.6** installation and the code in this repository.

## 1. Get ready

You'll need:

- Your own copy of Portal and [Source Unpack Version 2.6](https://sourceunpack.gameabusefastcomplete.com/) (the package containing HL2 and Portal).
- Git and **Node.js 24+**.
- **Visual Studio 2022 or 2026**, with **Desktop development with C++**, **MSVC v143 x86/x64 tools**, a Windows SDK, and C++ CMake tools for Windows.
- **Codex 0.153.4 or newer**, with access to your chosen model.

Extract Source Unpack into a dedicated folder. Run its `Portal.bat` once, then quit. Its recording plugin and SST are already taken care of.

In PowerShell, clone this repository:

```powershell
git clone https://github.com/cozyblaze/portal-agent.git
cd portal-agent
```

Run the following PowerShell commands from this repository folder.

## 2. Build and install the game plugin

These helpers download and build the custom SourcePauseTool plugin. Internet access is needed; no `npm install` is required.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/prepare-spt.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File tools/build-spt.ps1
```

Change `$gameRoot` below to your **fresh Source Unpack folder**, then copy the plugin and settings:

```powershell
$gameRoot = 'D:\PortalAgent\Source_Unpack'
Copy-Item .local/SourcePauseTool/build/Release/spt.dll "$gameRoot/portal/spt.dll"
Copy-Item game-config/spt.vdf "$gameRoot/portal/addons/spt.vdf"
Copy-Item game-config/agent_run.cfg "$gameRoot/portal/cfg/agent_run.cfg"
Copy-Item game-config/autoexec.cfg "$gameRoot/portal/cfg/portal_agent.cfg"
Add-Content "$gameRoot/portal/cfg/autoexec.cfg" "`nexec portal_agent"
```

Run the last line once. If you use an existing game installation, back up matching files and merge its settings first. Keep the unpack's existing addon files.

## 3. Start Portal

Launch the unpack's `Portal.bat`. Open the game console with `~`; enable it under **Options → Keyboard → Advanced** if needed. Enter:

```text
exec portal_agent
start_run
```

**This starts a new game and recording.** Wait until the opening chamber is paused and the console says:

```text
Agent run ready: demo recording is active and simulation is TAS-paused.
```

## 4. Check the connection

Back in PowerShell:

```powershell
node tools/configure-run.mjs
node tools/check-connection.mjs
```

This creates the **`.local/run`** folder and checks the connection without using model credits. Open the saved screenshot it reports to confirm it shows Portal. Close any other Portal controller before running the check.

Keep the repository in place after generating the run folder, and use paths without apostrophes.

## 5. Let the agent play

Open **`.local/run` as a project in Codex**, trust the folder when prompted, and start a new task there. Select your model and effort; the recorded run used **`gpt-6-astra` / `max`**.

Ask Codex to call `portal_documentation`, then `portal_screenshot`. Once it can see the game, give it the original goal:

> You are controlling Portal. Your goal is to progress through the game and reach the end credits. Do not cheat/look up information about the game online.

The original prompt used `/goal` before this text. Use that feature if your client supports it.

To finish recording, enter **`stop_run` in the game console**. Recordings are saved under `portal/agent_runs/`.

<details>
<summary>Troubleshooting</summary>

| Problem | What to check |
| --- | --- |
| Build fails | Install the Visual Studio components above, including v143 even on VS 2026. Use the build helper to find CMake. |
| Preparation was interrupted | Use `prepare-spt.ps1 -Destination <new-folder>`, then `build-spt.ps1 -SourceDirectory <same-folder>`. An interrupted build can simply be rerun. |
| Git reports missing `sed` or `basename` | Repair Git for Windows and its bundled tools. |
| `start_run` is unknown | Run `exec portal_agent`; check that `spt.dll` and `spt.vdf` were copied. |
| Recording plugin is missing | Keep the unpack's original `hl2/addons/speedrun_demorecord-2007.dll` and `portal/addons/speedrun_demorecord-2007.vdf`. |
| No game connection | Wait for the ready message. Run `plugin_print` to check SPT is loaded, and `y_spt_ipc 1` to enable its connection. |
| Requests time out | Close old Portal controllers, then toggle `y_spt_ipc 0` and `y_spt_ipc 1` in the game console. |
| Position is unavailable | Wait for a loaded map and run `y_spt_ipc_expose_position 1`. |
| Portal tools don't appear in Codex | Trust the generated folder and start a new task there. Check Node/Codex versions and the active tool list. |
| Screenshot save is denied | Save inside the generated run folder. |

The game console's `version` command should report **build 5135**. `plugin_print` should list **SourcePauseTool**, **Speedrun Demo Record**, and **Source Speedrun Tools**.

For Codex configuration help, see the [official MCP guide](https://developers.openai.com/codex/mcp).

</details>

<details>
<summary>Optional checks and a different run folder</summary>

Test the controller without the game:

```powershell
node --test controller/index.test.mjs
```

To check a camera turn and ten game ticks, use `node tools/check-connection.mjs --exercise`. Run `start_run` again afterward for a fresh recording.

To put the Codex run folder elsewhere:

```powershell
node tools/configure-run.mjs --run-dir 'D:\PortalAgentRun'
node tools/check-connection.mjs --run-dir 'D:\PortalAgentRun'
```

The generator refuses to overwrite existing configuration. Use a new run folder if you move the repository.

The original livestream overlay hooks are optional and disabled. `portal.abort()` stops only the current action sequence; use `stop_run` to end recording. After restarting the game or controller, inspect the game before continuing.

</details>

<details>
<summary>Other Portal versions</summary>

The tested version is **Source Unpack 2.6 / build 5135**. The separate 4104 and 3420 packages are different versions; modern Steam Portal has not been tested here.

For Source SDK 2013 / SteamPipe, upstream provides `spt-2013.dll`: build with `tools/build-spt.ps1 -Target spt-2013` and use the matching recording plugin. Follow the upstream [SPT placement table](https://github.com/OutOfBoundsOffice/SourcePauseTool#usage) and [recording-plugin instructions](https://github.com/RedHaze/speedrun-demo-record-unified#installing).

</details>
