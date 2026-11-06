# Strudel Player for DeepSeek Harness

A right-sidebar music player for the Harness Web UI. The agent composes Strudel
patterns with two tools, and the player in the right sidebar loads and plays them
without leaving the conversation.

![The player lives in the right sidebar, beside the chat.](icon.svg)

## What it does

- **Right-sidebar tab.** A real tab type in the Harness right sidebar, with a
  guide entry, a title chip that shows playback, and a persistent player body.
- **A real editor.** CodeMirror 6 with line numbers, bracket matching and
  auto-close, undo/redo, and syntax highlighting that also paints the
  mini-notation inside pattern strings. Colours follow the Harness theme through
  its Shiki token variables. Press **Ctrl/Cmd+Enter** to update,
  **Ctrl/Cmd+.** to stop, and **Revert** to return to the agent's version.
  The header also shows the pattern's tempo when it sets `setcps`/`setcpm`.
- **A live synth rack.** A collapsible strip under the editor shapes whatever is
  loaded: waveform swap for synth voices, filter cutoff and resonance, reverb,
  delay, and master volume. Changes are audible immediately while the player
  runs, and never rewrite the code in the editor.
- **Agent-fed patterns.** `strudel_compose` replaces the pattern; the player
  updates immediately. If it is already playing, the new pattern takes over on
  the next evaluation, so the agent can "live-code" over what you hear.
- **A local engine.** The client bundle contains `@strudel/web`, so playback is
  not an iframe of strudel.cc: Play, Stop, update and edit all happen in the
  panel. Drum samples come from the Dirt-Samples pack on GitHub; the first play
  fetches the sample map.

## Using it

1. Ask the agent for music: "make me a slow dub techno loop", "add a bassline",
   "make the hats busier". It calls `strudel_compose` with the full pattern.
2. The first new pattern opens the **Strudel** tab in the right sidebar. Press
   **Play** there once; browsers only allow audio after a user gesture.
3. Ask for changes, or press **Stop** / `strudel_stop` to silence it.

You can also open the player yourself from the right sidebar's add control
(**Strudel Player** card) or its More menu. Closing the tab does not stop the
audio; switch back to it or stop it from the chat.

## The synth rack

Open **Synth** under the editor to shape the sound without touching the code:

| Control | What it does |
| --- | --- |
| **Wave** | Swaps synth waveforms (`sine`, `triangle`, `sawtooth`, `square`) for each other. Drum samples keep their names and are untouched. |
| **Cutoff** | Low-pass frequency, 80 Hz to 16 kHz on a logarithmic slider; *off* leaves the pattern alone. |
| **Reso** | Filter resonance (`lpq`). |
| **Room** | Reverb send (`room`). |
| **Delay** | Delay send (`delay`). |
| **Vol** | Master level (`postgain`), 0–150%. |
| **Reset** | Returns every control to neutral. |

Every control starts at a neutral value, so an untouched rack evaluates the
agent's pattern exactly as written. The rack is applied at evaluation time: the
player prepends one `all((p) => p...)` statement, and the editor keeps showing
the pattern itself. Dragging a control re-evaluates the running pattern after a
short debounce; when the player is stopped the rack waits and applies on the
next **Play**. The header shows a `· Synth` marker while the rack is doing
something.

Only the compiled code depends on this: `all` and the control names come from
`@strudel/web`, so if a future engine drops them the rack shows an error in the
player instead of breaking the editor.

## Troubleshooting

- **No Strudel tab after installing into an open window.** The page learns new
  plugin bundles from the Harness plugin-graph stream. A page that was already
  open before this bundle was installed may have missed the update: reload the
  window once (`Ctrl+R`), then open the player from the sidebar's add control or
  ask the agent for a pattern.
- **"Harness offline" in the player footer.** The player could not reach
  `/strudel-player/api/state`; check that the Host half is enabled in Settings →
  Plugins. `/strudel-player/api/health` reports the published revision and how
  many players are connected.
- **No sound on the first Play.** The browser audio context starts only from a
  user gesture. Click Play once; later agent updates apply automatically.
- **Patterns using `piano`, `gm_*` or soundfonts are silent.** Those banks are
  not loaded by `@strudel/web`; use synth waveforms for pitched parts.
- **A rebuilt client bundle is not picked up live.** This Harness page reloads
  plugin code through its own client-graph channel; if it has gone quiet, reload
  the window once after `node build.mjs`.

## Tools

| Tool | Purpose |
| --- | --- |
| `strudel_compose` | Load a complete pattern (`code`, optional `title`). |
| `strudel_stop` | Silence the player and keep the loaded pattern. |

A system-prompt section teaches the agent the supported engine, the pattern
rules (ASCII only, no JavaScript control flow, last expression must be a
pattern) and which sounds are available. It is deliberately short; the tool
descriptions and parameter docs carry the rest.

## Architecture

- `index.js` — Host half. Owns the current pattern in memory and exposes
  `/strudel-player/api/state` (JSON) and `/strudel-player/api/events` (SSE) from
  the Harness web server. Registers both tools and the prompt section.
- `src/client.jsx` — Client source. Registers the `strudel-player` tab type via
  `ctx.sidebarRightTabs`, its body and title in `sidebar.right.pane.tab[.title]`,
  and follows the Host state over SSE. The engine is `@strudel/web`.
- `src/editor.jsx` — The CodeMirror editor and its theme. `src/strudel-highlight.js`
  adds the mini-notation layer on top of the JavaScript parse tree.
- `client.js` — Built bundle, loaded by the Harness client module loader. React
  stays external and comes from the page's shared module table; CodeMirror and
  `@strudel/web` are bundled.

The pattern is ephemeral plugin state, not a session event: the tool call is the
durable record of what the agent composed, and the player state resets when the
Harness restarts.

The engine evaluates the pattern as JavaScript in the Harness page, exactly as
the Strudel REPL does. Treat agent-authored patterns with the same trust you
extend to any other code the agent runs in this session.

## Build

The built `client.js` is checked in; rebuilding is only needed when editing the
client source:

```sh
npm install --ignore-scripts
node build.mjs
```

`--ignore-scripts` is enough for both dependencies; `build.mjs` runs the
platform esbuild binary with inherited stdio and wraps the bundle in the Client
module loader factory form.

The synth rack has its own check. It evaluates the generated rack string with
the same Strudel packages, then asserts that the filter, resonance, reverb,
delay and level controls really override the pattern, that the wave control
swaps synth voices without touching drum samples, and that a neutral rack is a
no-op:

```sh
node test/run-rack.mjs
```

`test/run-rack.mjs` bundles `test/rack-eval.mjs` with esbuild first, because
Node's ESM resolver cannot link `@strudel/core` on its own.

## License

The plugin is AGPL-3.0-only. Its client bundle includes
[`@strudel/web`](https://www.npmjs.com/package/@strudel/web), which is
AGPL-3.0-or-later and part of the [Strudel](https://strudel.cc) project by Felix
Roos and contributors. The interface and the authoring guidance were inspired by
the [strudel-vibe-coder](https://github.com/ronnqvist/strudel-vibe-coder)
project (AGPL-3.0-only).
