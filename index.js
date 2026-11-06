/**
 * Host half of the Strudel Player bundle.
 *
 * Two agent-facing tools publish a pattern (`strudel_compose`) or silence the
 * player (`strudel_stop`). The browser half reads the published state over a
 * small JSON/SSE API and renders the player in the right sidebar. Nothing here
 * touches the session log: the pattern is ephemeral plugin state, and the tool
 * call itself records what the agent composed.
 */

export const inject = ['tools', 'systemPrompt'];

/** Longest pattern accepted from the model. */
const MAX_CODE_CHARS = 20_000;

/** Sample pack the player preloads; the browser half receives it from the API. */
const DEFAULT_SAMPLES = 'github:tidalcycles/dirt-samples';

/** Route prefix owned by this plugin. */
const API_BASE = '/strudel-player/api';

/**
 * Model-facing guidance. The tool descriptions say what the tools do; this
 * section carries the Strudel authoring constraints that apply to the code.
 */
const AUTHORING_GUIDE = `## Strudel Player

The Strudel Player in the right sidebar plays live-coding patterns the user can hear. It is a real audio player, not a document preview: \`strudel_compose\` replaces the pattern immediately, and the player starts or updates the sound once the user has pressed Play there.

Use it whenever the user asks for music, a beat, a bassline, a jam, a loop, or a change to what is playing. Do not write pattern code into files unless the user asks for the code itself.

- Call \`strudel_compose\` with the complete runnable pattern, never a diff or a fragment.
- Call \`strudel_stop\` when the user asks to stop the music.
- Keep the reply short: say what changed and what to tweak, not a line-by-line explanation.
- The player's **Synth** rack applies its own filter, reverb, delay, wave and level controls on top of the pattern at play time. Compose the part you mean; when the user asks for a darker, wetter, quieter or squarer sound, say which rack control to move instead of encoding those global settings in the code.

### Engine

Code runs once through \`@strudel/web\`. Put \`setcps(...)\` at the top when tempo matters. Do not call \`.play()\` or \`.stop()\` inside the code, and do not use \`await\`, \`import\`, DOM APIs, or Hydra (\`initHydra\` is not available).

### Pattern rules

- ASCII only: straight quotes, plain hyphens. Never use smart quotes or en/em dashes.
- No JavaScript control flow: no for/while/forEach, no Math.random, no setInterval/setTimeout, no variables that hold patterns for later.
- The last expression must be the playable pattern. End on the pattern or the \`stack(...)\` call; never end on a variable declaration or \`console.log\`.
- Layer with \`stack(...)\`, sequence with \`cat(...)\`, and shape with \`.fast\`, \`.slow\`, \`.every\`, \`.sometimes\`, \`.rarely\`, \`.rev\`, \`.palindrome\`, \`.jux\`, \`.room\`, \`.delay\`, \`.lpf\`, \`.gain\`, \`.pan\`, \`.clip\`.
- Mini-notation: \`"bd sd [~ bd] sd"\`, \`"hh*8?"\`, \`"<bd sd cp>"\`, chords \`"[c3,e3,g3]"\`, euclid \`"bd(3,8)"\`, rests \`~\`, alternatives \`"bd|sd"\`.
- Keep it under about 60 lines so it stays readable and cheap to revise.

### Sounds available

Dirt drum samples are loaded from GitHub: \`bd\`, \`sd\`, \`hh\`, \`oh\`, \`cp\`, \`rim\`, \`mt\`, \`lt\`, \`ht\`, \`perc\`, \`cr\`, \`cb\`, \`casio\`, \`juno\`, \`moog\`, \`pad\`, \`stab\`, \`sax\`, \`pluck\` and many more. \`s("bd:0 bd:1")\` or \`s("bd").n("0 1 2")\` picks variants.

Synth waveforms also work: \`s("sine" | "sawtooth" | "square" | "triangle")\` with \`.fm\`, \`.lpf\`, \`.adsr\`, \`.room\`. General MIDI and soundfont names such as \`"piano"\` or \`"gm_lead"\` are NOT loaded: play pitched material with \`note("...").s(<waveform>)\` or a pitched sample pack.`;

function messageOf(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Normalize model-authored text into one clean, ASCII-safe pattern.
 * @param {unknown} input - raw `code` argument.
 * @returns {string} the pattern, with fences and typographic characters removed.
 */
function normalizeCode(input) {
  let code = String(input ?? '').replace(/\r\n?/g, '\n');
  const fenced = /^\s*```[\w-]*[ \t]*\n([\s\S]*?)\n```\s*$/.exec(code);
  if (fenced) code = fenced[1];
  return code
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u00a0/g, ' ')
    .trim();
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('content-length', Buffer.byteLength(body));
  res.end(body);
}

export function apply(ctx) {
  /** The single pattern the player shows. */
  const state = {
    revision: 0,
    stopRevision: 0,
    code: '',
    title: '',
    samples: DEFAULT_SAMPLES,
    updatedAt: null,
  };

  /** Open SSE responses. */
  const streams = new Set();

  /** Cheap liveness counters for the player's own diagnostics route. */
  const diagnostics = { stateReads: 0, eventStreams: 0 };

  const snapshot = () => ({ ...state });

  const broadcast = () => {
    const frame = `data: ${JSON.stringify(snapshot())}\n\n`;
    for (const res of streams) {
      try {
        res.write(frame);
      } catch {
        streams.delete(res);
      }
    }
  };

  /**
   * Publish one pattern to the player.
   * @param {{ code: unknown, title?: unknown }} args - tool arguments.
   * @returns {{ status: string, revision: number, lines: number, characters: number }}
   */
  const compose = (args) => {
    if (typeof args?.code !== 'string') throw new Error('code must be a string');
    const code = normalizeCode(args.code);
    if (!code) throw new Error('code is empty after normalization');
    if (code.length > MAX_CODE_CHARS) {
      throw new Error(`code is too long (${code.length} characters; the limit is ${MAX_CODE_CHARS})`);
    }
    const title = typeof args.title === 'string' ? args.title.trim().slice(0, 80) : '';
    state.revision += 1;
    state.code = code;
    state.title = title;
    state.updatedAt = new Date().toISOString();
    broadcast();
    return {
      status: 'loaded',
      revision: state.revision,
      lines: code.split('\n').length,
      characters: code.length,
    };
  };

  /** Silence the player without clearing the pattern. */
  const stop = () => {
    state.stopRevision += 1;
    state.updatedAt = new Date().toISOString();
    broadcast();
    return { status: 'stopped', stopRevision: state.stopRevision };
  };

  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'strudel_compose',
        description:
          'Load a complete Strudel pattern into the Strudel Player in the right sidebar, replacing what is there. The player updates immediately; audio starts or switches after the user has pressed Play there once.',
        parameters: {
          type: 'object',
          properties: {
            code: {
              type: 'string',
              description: 'The complete Strudel pattern. ASCII only, no markdown fences.',
            },
            title: {
              type: 'string',
              description: 'Short label shown above the pattern, at most 80 characters.',
            },
          },
          required: ['code'],
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              status: { type: 'string' },
              revision: { type: 'number' },
              lines: { type: 'number' },
              characters: { type: 'number' },
            },
            required: ['status', 'revision', 'lines', 'characters'],
          },
          render(_args, value) {
            return [
              {
                type: 'text',
                text: `Pattern loaded into the Strudel Player (revision ${value.revision}, ${value.lines} lines, ${value.characters} characters). The user can press Play in the right sidebar.`,
              },
            ];
          },
        },
        async execute(args) {
          return compose(args);
        },
      }),
    'strudel-player: compose tool',
  );

  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'strudel_stop',
        description: 'Stop the sound coming from the Strudel Player in the right sidebar. The current pattern stays loaded.',
        parameters: { type: 'object', properties: {} },
        output: {
          schema: {
            type: 'object',
            properties: {
              status: { type: 'string' },
              stopRevision: { type: 'number' },
            },
            required: ['status', 'stopRevision'],
          },
          render() {
            return [{ type: 'text', text: 'Strudel Player stopped.' }];
          },
        },
        async execute() {
          return stop();
        },
      }),
    'strudel-player: stop tool',
  );

  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: 'plugin:strudel-player',
        order: 1500,
        text: AUTHORING_GUIDE,
      }),
    'strudel-player: prompt section',
  );

  ctx.inject(['webServer'], (web) => {
    const handleState = async (req, res) => {
      if (req.method !== 'GET') {
        res.statusCode = 405;
        res.setHeader('allow', 'GET');
        res.end();
        return;
      }
      diagnostics.stateReads += 1;
      sendJson(res, 200, snapshot());
    };

    const handleHealth = async (req, res) => {
      if (req.method !== 'GET') {
        res.statusCode = 405;
        res.setHeader('allow', 'GET');
        res.end();
        return;
      }
      sendJson(res, 200, {
        ok: true,
        revision: state.revision,
        stopRevision: state.stopRevision,
        updatedAt: state.updatedAt,
        players: streams.size,
        stateReads: diagnostics.stateReads,
        eventStreams: diagnostics.eventStreams,
      });
    };

    const handleEvents = async (req, res) => {
      if (req.method !== 'GET') {
        res.statusCode = 405;
        res.setHeader('allow', 'GET');
        res.end();
        return;
      }
      diagnostics.eventStreams += 1;
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write('retry: 3000\n\n');
      res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
      streams.add(res);
      const heartbeat = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {
          clearInterval(heartbeat);
          streams.delete(res);
        }
      }, 25_000);
      const release = () => {
        clearInterval(heartbeat);
        streams.delete(res);
      };
      req.on('close', release);
      res.on('close', release);
      res.on('error', release);
    };

    web.effect(
      () => {
        const disposeState = web.webServer.register({
          kind: 'exact',
          path: `${API_BASE}/state`,
          handler: handleState,
        });
        const disposeHealth = web.webServer.register({
          kind: 'exact',
          path: `${API_BASE}/health`,
          handler: handleHealth,
        });
        const disposeEvents = web.webServer.register({
          kind: 'exact',
          path: `${API_BASE}/events`,
          handler: handleEvents,
        });
        return () => {
          disposeEvents();
          disposeHealth();
          disposeState();
          for (const res of streams) {
            try {
              res.end();
            } catch {
              // The response may already be gone.
            }
          }
          streams.clear();
        };
      },
      'strudel-player: browser routes',
    );
  });
}
