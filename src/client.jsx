/**
 * Client half of the Strudel Player bundle.
 *
 * Registers a right-sidebar tab type and renders a self-contained Strudel
 * player. The engine is @strudel/web, bundled into this file, so playback does
 * not depend on an iframe or a second page. The pattern comes from the Host
 * half's JSON/SSE API and auto-applies while the player is running.
 */
import React from 'react';
import { initStrudel, evaluate, hush, samples, initAudio } from '@strudel/web';
import { CodeEditor } from './editor.jsx';
import { WAVES, SYNTH_DEFAULTS, cutoffHz, synthActive, buildSynthRack } from './synth-rack.js';

const TYPE_ID = '@local/dsh-strudel-player';
const KIND = 'strudel-player';
const NS = 'strudelPlayer';
const API = '/strudel-player/api';
const DEFAULT_SAMPLES = 'github:tidalcycles/dirt-samples';

const DEMO = `// Demo: press Play to hear it, then ask the agent to change it.
setcps(0.55)

stack(
  // drums
  s("bd:0 bd:2 ~ bd:1, ~ cp ~ cp, hh*8?0.65").gain(0.9),
  // bass
  note("c2 [eb2 g2] c2 bb1").s("sawtooth").lpf(620).gain(0.55),
  // chords
  note("<[c4,eb4,g4] [ab3,c4,eb4] [f3,ab3,c4] [g3,bb3,d4]>")
    .s("triangle")
    .room(0.6)
    .gain(0.3)
)`;

const DICT = {
  en: {
    'title': 'Strudel Player',
    'tab.title': 'Strudel',
    'tab.description': 'Play the patterns your agent composes.',
    'guide.title': 'Strudel Player',
    'guide.description': 'Live-code music with the agent.',
    'empty.title': 'Nothing playing yet',
    'empty.body':
      'Ask the agent for a beat, a bassline, or a full track. It composes the pattern and this player takes it from there.',
    'empty.demo': 'Load a demo',
    'action.play': 'Play',
    'action.update': 'Update',
    'action.stop': 'Stop',
    'action.copy': 'Copy',
    'action.copied': 'Copied',
    'action.revert': 'Revert',
    'status.idle': 'Ready',
    'status.loading': 'Loading sounds…',
    'status.starting': 'Starting…',
    'status.playing': 'Playing',
    'status.error': 'Error',
    'status.offline': 'Harness offline',
    'meta.lines': '{n} lines',
    'meta.revision': 'rev {n}',
    'meta.edited': 'Edited',
    'hint': 'Ctrl+Enter updates, Ctrl+. stops.',
    'error.dismiss': 'Dismiss',
    'samples': 'Drum samples load from GitHub on the first play.',
    'synth.title': 'Synth',
    'synth.hint': 'Live controls over the playing pattern.',
    'synth.wave': 'Wave',
    'synth.wave.auto': 'Auto',
    'synth.wave.all': 'All waves',
    'synth.cutoff': 'Cutoff',
    'synth.resonance': 'Reso',
    'synth.room': 'Room',
    'synth.delay': 'Delay',
    'synth.volume': 'Vol',
    'synth.off': 'off',
    'synth.reset': 'Reset',
    'synth.active': 'Synth rack active',
    'synth.pending': 'Applies on play',
    'synth.percent': '{n}%',
    'synth.hz': '{n} Hz',
  },
};

function messageOf(error) {
  if (error instanceof Error) return error.message;
  return String(error ?? 'Unknown error');
}

function format(key, value) {
  return key.replace('{n}', String(value));
}

/** Read the tempo the pattern sets, as BPM (4 beats per cycle) or CPM. */
function tempoOf(code) {
  const cpm = /\bsetcpm\s*\(\s*([0-9]+(?:\.[0-9]+)?)/i.exec(code);
  if (cpm) return `${Math.round(Number(cpm[1]))} CPM`;
  const cps = /\bsetcps\s*\(\s*([0-9]+(?:\.[0-9]+)?)/i.exec(code);
  if (cps) return `${Math.round(Number(cps[1]) * 240)} BPM`;
  return null;
}

/* ------------------------------------------------------------------- store */

function createStore() {
  let view = {
    revision: 0,
    stopRevision: 0,
    code: '',
    title: '',
    draft: '',
    playing: false,
    status: 'idle',
    error: null,
    connected: null,
    copied: false,
    samples: DEFAULT_SAMPLES,
    synth: { ...SYNTH_DEFAULTS },
    synthOpen: false,
  };
  const listeners = new Set();
  const emit = () => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // A broken subscriber must not stop the others.
      }
    }
  };
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot() {
      return view;
    },
    update(patch) {
      const next = typeof patch === 'function' ? patch(view) : patch;
      let changed = false;
      for (const key of Object.keys(next)) {
        if (!Object.is(view[key], next[key])) {
          changed = true;
          break;
        }
      }
      if (!changed) return;
      view = { ...view, ...next };
      emit();
    },
  };
}

const store = createStore();
let pluginCtx = null;
let enginePromise = null;
let runChain = Promise.resolve();
let initialized = false;
/** Pending debounce for live synth-rack edits. */
let synthTimer = null;

/* ------------------------------------------------------------------ engine */

function ensureEngine() {
  if (enginePromise) return enginePromise;
  enginePromise = (async () => {
    const ready = initStrudel({
      prebake: async () => {
        const pack = store.getSnapshot().samples || DEFAULT_SAMPLES;
        try {
          await samples(pack);
        } catch (error) {
          // Synth patterns still work without the drum pack.
          console.warn('[strudel-player] could not load the sample pack:', error);
        }
      },
      onEvalError: (error) => {
        store.update({ status: 'error', error: messageOf(error) });
      },
      onToggle: (started) => {
        store.update(started ? { playing: true, status: 'playing', error: null } : { playing: false, status: 'idle' });
      },
    });
    try {
      await initAudio();
    } catch (error) {
      console.warn('[strudel-player] audio is still locked until the next click:', error);
    }
    await ready;
  })();
  enginePromise.catch(() => {
    enginePromise = null;
  });
  return enginePromise;
}

function stopAudio() {
  try {
    hush();
  } catch {
    // The engine was never started.
  }
  store.update({ playing: false, status: 'idle' });
}

function enqueueRun(code, options = {}) {
  const quiet = options.quiet === true;
  const task = async () => {
    const clean = String(code ?? '').trim();
    if (!clean) {
      store.update({ status: 'idle', error: null });
      return;
    }
    if (!quiet) store.update({ status: 'loading', error: null });
    await ensureEngine();
    if (!quiet) store.update({ status: 'starting' });
    const rack = buildSynthRack(store.getSnapshot().synth);
    await evaluate(rack ? `${rack}\n${clean}` : clean, true);
    const view = store.getSnapshot();
    if (view.status !== 'error') {
      store.update({ status: view.playing ? 'playing' : 'idle' });
    }
  };
  const next = runChain.then(task, task);
  runChain = next.catch(() => {});
  return next;
}

function playDraft() {
  const view = store.getSnapshot();
  return enqueueRun(view.draft).catch((error) => {
    store.update({ status: 'error', error: messageOf(error) });
  });
}

/* ------------------------------------------------------------------- synth */

/** Re-evaluate the playing pattern shortly after the rack settles. */
function scheduleSynthRun() {
  const view = store.getSnapshot();
  if (!view.playing && view.status !== 'starting') return;
  if (synthTimer !== null) clearTimeout(synthTimer);
  synthTimer = setTimeout(() => {
    synthTimer = null;
    enqueueRun(store.getSnapshot().draft, { quiet: true }).catch((error) => {
      store.update({ status: 'error', error: messageOf(error) });
    });
  }, 160);
}

/** Merge one synth-rack change and audition it when the player is running. */
function setSynth(patch) {
  store.update((view) => ({ synth: { ...view.synth, ...patch } }));
  scheduleSynthRun();
}

/** Return every synth control to its neutral value. */
function resetSynth() {
  setSynth({ ...SYNTH_DEFAULTS });
}

/** Show or hide the rack; the state survives tab switches. */
function toggleSynth() {
  store.update((view) => ({ synthOpen: !view.synthOpen }));
}

function loadDemo() {
  store.update({ code: DEMO, draft: DEMO, title: 'Demo pattern' });
  return playDraft();
}

async function copyCode() {
  const view = store.getSnapshot();
  try {
    await navigator.clipboard.writeText(view.draft);
    store.update({ copied: true });
    setTimeout(() => store.update({ copied: false }), 1500);
  } catch (error) {
    store.update({ status: 'error', error: messageOf(error) });
  }
}

/* -------------------------------------------------------------- host state */

function revealPlayer() {
  const ctx = pluginCtx;
  const right = ctx?.get?.('sidebarRight');
  if (!right) return;
  try {
    const sessionId = right.mounted?.getSnapshot?.();
    if (!sessionId) return;
    const open = right.tabsIn(sessionId).some((tab) => tab.kind === KIND);
    if (open) return;
    right.openTab(KIND);
  } catch (error) {
    console.warn('[strudel-player] could not reveal the player tab:', error);
  }
}

function applyServerState(next, live) {
  if (!next || typeof next !== 'object' || typeof next.revision !== 'number') return;
  const previous = store.getSnapshot();
  if (initialized && next.revision < previous.revision && next.stopRevision <= previous.stopRevision) return;
  const firstState = !initialized;
  const newRevision = next.revision > previous.revision;
  const newStop = next.stopRevision > previous.stopRevision;
  const wasPlaying = previous.playing;
  const code = typeof next.code === 'string' ? next.code : '';
  initialized = true;

  if (firstState || newRevision) {
    store.update({
      revision: next.revision,
      code,
      draft: code,
      title: typeof next.title === 'string' ? next.title : '',
      samples: typeof next.samples === 'string' ? next.samples : DEFAULT_SAMPLES,
    });
  }
  if (newStop) {
    store.update({ stopRevision: next.stopRevision });
    stopAudio();
  }
  if (!firstState && newRevision) {
    if (wasPlaying && code) {
      enqueueRun(code).catch((error) => {
        store.update({ status: 'error', error: messageOf(error) });
      });
    }
    if (live) revealPlayer();
  }
}

function connectState() {
  let source = null;
  let poll = null;

  const readState = (live) => {
    fetch(`${API}/state`, { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then((value) => applyServerState(value, live))
      .catch(() => store.update({ connected: false }));
  };

  readState(false);

  if (typeof EventSource === 'undefined') {
    poll = setInterval(() => readState(false), 4000);
    return () => clearInterval(poll);
  }

  try {
    source = new EventSource(`${API}/events`);
    source.onopen = () => store.update({ connected: true });
    source.onerror = () => store.update({ connected: false });
    source.onmessage = (event) => {
      store.update({ connected: true });
      try {
        applyServerState(JSON.parse(event.data), true);
      } catch {
        // Ignore a frame that is not ours.
      }
    };
  } catch (error) {
    console.warn('[strudel-player] live updates are unavailable:', error);
    store.update({ connected: false });
  }

  return () => {
    if (source) source.close();
    if (poll) clearInterval(poll);
  };
}

/* ---------------------------------------------------------------- artwork */

function NoteIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ display: 'block' }}>
      <path d="M6.2 12.1V3.9l6.2-1.4v7.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="4.6" cy="12.1" r="1.7" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="10.8" cy="10.1" r="1.7" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true" style={{ display: 'block' }}>
      <path d="M4.5 2.8v10.4L13 8 4.5 2.8Z" fill="currentColor" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true" style={{ display: 'block' }}>
      <rect x="3.5" y="3.5" width="9" height="9" rx="1.2" fill="currentColor" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ display: 'block' }}>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M10.5 5.5v-1a1.5 1.5 0 0 0-1.5-1.5H4a1.5 1.5 0 0 0-1.5 1.5V9A1.5 1.5 0 0 0 4 10.5h1"
        stroke="currentColor"
        strokeWidth="1.2"
      />
    </svg>
  );
}

/* ------------------------------------------------------------------ synth */

function ChevronIcon({ open }) {
  return (
    <svg
      width="8"
      height="8"
      viewBox="0 0 8 8"
      aria-hidden="true"
      className={`strudel-player-chevron${open ? ' open' : ''}`}
      style={{ display: 'block' }}
    >
      <path
        d="M2.5 1 6 4 2.5 7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Knob({ label, value, display, min, max, step, onChange }) {
  return (
    <label className="strudel-player-knob">
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <output>{display}</output>
    </label>
  );
}

/**
 * The live synth rack: controls that shape whatever pattern is loaded, applied
 * as an evaluation-time `all(...)` transform. The editor keeps showing the
 * pattern the agent wrote; the rack never edits the code.
 */
function SynthRack({ t, synth, open, playing }) {
  const active = synthActive(synth);
  const percent = (value) => format(t('synth.percent'), Math.round(value));
  const cutoff = cutoffHz(synth.cutoff);
  return (
    <section className="strudel-player-synth">
      <div className="strudel-player-synth-head">
        <button
          type="button"
          className="strudel-player-synth-toggle"
          onClick={toggleSynth}
          aria-expanded={open}
          title={t('synth.hint')}
        >
          <ChevronIcon open={open} />
          {t('synth.title')}
          {active ? <span className="strudel-player-synth-live" aria-label={t('synth.active')} /> : null}
        </button>
        {open ? (
          <button
            type="button"
            className="strudel-player-btn"
            onClick={resetSynth}
            disabled={!active}
            title={t('synth.reset')}
          >
            {t('synth.reset')}
          </button>
        ) : null}
      </div>
      {open ? (
        <div className="strudel-player-synth-body">
          <label className="strudel-player-knob">
            <span>{t('synth.wave')}</span>
            <select value={synth.wave} onChange={(event) => setSynth({ wave: event.target.value })}>
              <option value="auto">{t('synth.wave.auto')}</option>
              {WAVES.map((wave) => (
                <option key={wave} value={wave}>
                  {wave}
                </option>
              ))}
            </select>
          </label>
          <Knob
            label={t('synth.cutoff')}
            value={synth.cutoff}
            min={0}
            max={100}
            step={1}
            display={cutoff === null ? t('synth.off') : format(t('synth.hz'), cutoff)}
            onChange={(value) => setSynth({ cutoff: value })}
          />
          <Knob
            label={t('synth.resonance')}
            value={synth.resonance}
            min={0}
            max={20}
            step={0.5}
            display={synth.resonance > 0 ? synth.resonance.toFixed(1) : t('synth.off')}
            onChange={(value) => setSynth({ resonance: value })}
          />
          <Knob
            label={t('synth.room')}
            value={synth.room}
            min={0}
            max={100}
            step={1}
            display={synth.room > 0 ? percent(synth.room) : t('synth.off')}
            onChange={(value) => setSynth({ room: value })}
          />
          <Knob
            label={t('synth.delay')}
            value={synth.delay}
            min={0}
            max={100}
            step={1}
            display={synth.delay > 0 ? percent(synth.delay) : t('synth.off')}
            onChange={(value) => setSynth({ delay: value })}
          />
          <Knob
            label={t('synth.volume')}
            value={synth.volume}
            min={0}
            max={150}
            step={1}
            display={percent(synth.volume)}
            onChange={(value) => setSynth({ volume: value })}
          />
          <div className="strudel-player-synth-foot">
            <span>{t('synth.hint')}</span>
            <span>{playing ? '' : t('synth.pending')}</span>
          </div>
        </div>
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------ views */

const css = `
  .strudel-player-root, .strudel-player-root * { box-sizing: border-box; }
  .strudel-player-root { height: 100%; min-height: 0; display: flex; flex-direction: column;
    background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); }
  .strudel-player-head { display: flex; align-items: center; gap: 10px; padding: 10px 12px;
    border-bottom: 1px solid var(--dsw-alias-border-l1); flex: none; }
  .strudel-player-heading { min-width: 0; flex: 1; }
  .strudel-player-title { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden;
    text-overflow: ellipsis; }
  .strudel-player-meta { margin-top: 2px; font-size: 11px; color: var(--dsw-alias-label-secondary);
    display: flex; align-items: center; gap: 6px; min-width: 0; white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis; }
  .strudel-player-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex: none; }
  .strudel-player-actions { display: flex; align-items: center; gap: 6px; flex: none; }
  .strudel-player-btn { appearance: none; cursor: pointer; font: inherit; font-size: 12px; font-weight: 550;
    display: inline-flex; align-items: center; gap: 6px; line-height: 1.2; padding: 6px 10px;
    color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1);
    border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px; }
  .strudel-player-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
  .strudel-player-btn:disabled { opacity: .5; cursor: default; }
  .strudel-player-btn.primary { color: var(--dsw-alias-bg-base); background: var(--dsw-alias-brand-primary);
    border-color: var(--dsw-alias-brand-primary); font-weight: 600; }
  .strudel-player-btn.primary:hover:not(:disabled) { filter: brightness(1.06);
    background: var(--dsw-alias-brand-primary); }
  .strudel-player-btn.icon { padding: 6px; }
  .strudel-player-body { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .strudel-player-editor { flex: 1; min-height: 0; overflow: hidden; }
  .strudel-player-editor .cm-editor { height: 100%; }
  .strudel-player-empty { flex: 1; display: flex; flex-direction: column; align-items: center;
    justify-content: center; gap: 10px; padding: 24px; text-align: center; }
  .strudel-player-empty h3 { margin: 0; font-size: 14px; font-weight: 600; }
  .strudel-player-empty p { margin: 0; max-width: 34ch; font-size: 12px; line-height: 1.55;
    color: var(--dsw-alias-label-secondary); }
  .strudel-player-error { flex: none; margin: 0 12px 10px; padding: 8px 10px; border-radius: 8px;
    border: 1px solid var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary);
    background: var(--dsw-alias-bg-layer-1); font-size: 11px; display: flex; gap: 8px;
    align-items: flex-start; }
  .strudel-player-error pre { margin: 0; flex: 1; white-space: pre-wrap; word-break: break-word;
    font-family: inherit; max-height: 120px; overflow: auto; }
  .strudel-player-dismiss { appearance: none; border: 0; background: transparent; cursor: pointer;
    color: inherit; font: inherit; padding: 0; opacity: .75; }
  .strudel-player-foot { flex: none; display: flex; align-items: center; justify-content: space-between;
    gap: 8px; padding: 8px 12px; border-top: 1px solid var(--dsw-alias-border-l1);
    font-size: 11px; color: var(--dsw-alias-label-secondary); }
  .strudel-player-hint { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .strudel-player-state { display: inline-flex; align-items: center; gap: 6px; flex: none; }
  .strudel-player-synth { flex: none; border-top: 1px solid var(--dsw-alias-border-l1); }
  .strudel-player-synth-head { display: flex; align-items: center; justify-content: space-between;
    gap: 8px; padding: 7px 12px; }
  .strudel-player-synth-toggle { appearance: none; border: 0; background: transparent; padding: 0;
    cursor: pointer; font: inherit; font-size: 11px; font-weight: 600; letter-spacing: .02em;
    text-transform: uppercase; color: var(--dsw-alias-label-secondary); display: inline-flex;
    align-items: center; gap: 7px; }
  .strudel-player-synth-toggle:hover { color: var(--dsw-alias-label-primary); }
  .strudel-player-chevron { display: inline-block; transition: transform .15s ease; }
  .strudel-player-chevron.open { transform: rotate(90deg); }
  .strudel-player-synth-live { width: 5px; height: 5px; border-radius: 50%; flex: none;
    background: var(--dsw-alias-brand-primary); }
  .strudel-player-synth-body { display: grid; gap: 7px; padding: 2px 12px 11px; }
  .strudel-player-knob { display: grid; grid-template-columns: 58px minmax(0, 1fr) 58px;
    align-items: center; gap: 8px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
  .strudel-player-knob > span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .strudel-player-knob output { text-align: right; font-variant-numeric: tabular-nums; }
  .strudel-player-knob input[type="range"] { width: 100%; height: 14px; margin: 0;
    accent-color: var(--dsw-alias-brand-primary); }
  .strudel-player-knob select { grid-column: 2 / span 2; font: inherit; font-size: 11px;
    padding: 3px 6px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1);
    border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; }
  .strudel-player-synth-foot { display: flex; align-items: center; justify-content: space-between;
    gap: 8px; padding-top: 1px; font-size: 10px; color: var(--dsw-alias-label-secondary); }
  .strudel-player-synth-foot .strudel-player-btn { padding: 3px 8px; font-size: 11px; }
`;

function Player({ t }) {
  const view = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const busy = view.status === 'loading' || view.status === 'starting';
  const hasCode = view.code.length > 0 || view.draft.length > 0;
  const dirty = view.draft !== view.code;
  const lines = view.draft ? view.draft.split('\n').length : 0;
  const tempo = tempoOf(view.draft);

  const statusText =
    view.status === 'loading'
      ? t('status.loading')
      : view.status === 'starting'
        ? t('status.starting')
        : view.status === 'error'
          ? t('status.error')
          : view.playing
            ? t('status.playing')
            : t('status.idle');

  const statusTone =
    view.status === 'error'
      ? 'var(--dsw-alias-state-error-primary)'
      : view.playing
        ? 'var(--dsw-alias-state-success-primary)'
        : 'var(--dsw-alias-state-idle-primary)';

  return (
    <div className="strudel-player-root">
      <style>{css}</style>
      <header className="strudel-player-head">
        <div className="strudel-player-heading">
          <div className="strudel-player-title">{view.title || t('title')}</div>
          <div className="strudel-player-meta">
            <span className="strudel-player-dot" style={{ color: statusTone }} />
            <span>{statusText}</span>
            {view.revision > 0 ? <span>· {format(t('meta.revision'), view.revision)}</span> : null}
            {hasCode ? <span>· {format(t('meta.lines'), lines)}</span> : null}
            {tempo ? <span>· {tempo}</span> : null}
            {synthActive(view.synth) ? <span>· {t('synth.title')}</span> : null}
          </div>
        </div>
        <div className="strudel-player-actions">
          <button
            type="button"
            className="strudel-player-btn primary"
            disabled={busy || !view.draft.trim()}
            onClick={() => playDraft()}
            title={`${view.playing ? t('action.update') : t('action.play')} (Ctrl+Enter)`}
          >
            <PlayIcon />
            {view.playing ? t('action.update') : t('action.play')}
          </button>
          <button
            type="button"
            className="strudel-player-btn icon"
            disabled={!view.playing && view.status !== 'starting'}
            onClick={() => stopAudio()}
            title={`${t('action.stop')} (Ctrl+.)`}
            aria-label={t('action.stop')}
          >
            <StopIcon />
          </button>
          {dirty ? (
            <button
              type="button"
              className="strudel-player-btn"
              onClick={() => store.update({ draft: view.code })}
              title={t('action.revert')}
            >
              {t('action.revert')}
            </button>
          ) : null}
          <button
            type="button"
            className="strudel-player-btn icon"
            disabled={!view.draft}
            onClick={() => copyCode()}
            title={view.copied ? t('action.copied') : t('action.copy')}
            aria-label={t('action.copy')}
          >
            <CopyIcon />
          </button>
        </div>
      </header>

      {view.error ? (
        <div className="strudel-player-error" role="alert">
          <pre>{view.error}</pre>
          <button type="button" className="strudel-player-dismiss" onClick={() => store.update({ error: null })}>
            {t('error.dismiss')}
          </button>
        </div>
      ) : null}

      <div className="strudel-player-body">
        {hasCode ? (
          <CodeEditor
            value={view.draft}
            ariaLabel={t('title')}
            onChange={(value) => store.update({ draft: value })}
            onPlay={playDraft}
            onStop={stopAudio}
          />
        ) : (
          <div className="strudel-player-empty">
            <NoteIcon size={26} />
            <h3>{t('empty.title')}</h3>
            <p>{t('empty.body')}</p>
            <button type="button" className="strudel-player-btn" onClick={() => loadDemo()}>
              {t('empty.demo')}
            </button>
          </div>
        )}
      </div>

      <SynthRack t={t} synth={view.synth} open={view.synthOpen} playing={view.playing} />

      <footer className="strudel-player-foot">
        <span className="strudel-player-hint">{view.connected === false ? t('status.offline') : t('hint')}</span>
        <span className="strudel-player-state">{dirty ? t('meta.edited') : t('samples')}</span>
      </footer>
    </div>
  );
}

function PlayerTitle({ t }) {
  const view = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
      <NoteIcon size={13} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t('tab.title')}</span>
      {view.playing ? (
        <span
          className="strudel-player-dot"
          style={{ color: 'var(--dsw-alias-state-success-primary)', width: 5, height: 5 }}
          aria-label={t('status.playing')}
        />
      ) : null}
    </span>
  );
}

/* ------------------------------------------------------------------- entry */

export const inject = ['slots', 'locale'];

export function apply(ctx) {
  pluginCtx = ctx;

  ctx.effect(() => ctx.locale.register(NS, { en: DICT.en }), 'strudel-player: dictionaries');
  const t = ctx.locale.bind(NS);

  ctx.inject(['sidebarRightTabs'], (tabsCtx) => {
    tabsCtx.effect(
      () =>
        tabsCtx.sidebarRightTabs.register({
          id: TYPE_ID,
          kind: KIND,
          title: () => t('tab.title'),
          guide: [
            {
              id: 'player',
              order: 20,
              title: () => t('guide.title'),
              description: () => t('guide.description'),
            },
          ],
        }),
      'strudel-player: tab type',
    );
  });

  ctx.effect(
    () =>
      ctx.slots.inject('sidebar.right.pane.tab', () =>
        ctx.slots.register(
          {
            name: 'sidebar.right.pane.tab',
            key: TYPE_ID,
            locale: NS,
          },
          Player,
        ),
      ),
    'strudel-player: tab body',
  );

  ctx.effect(
    () =>
      ctx.slots.inject('sidebar.right.pane.tab.title', () =>
        ctx.slots.register(
          {
            name: 'sidebar.right.pane.tab.title',
            key: TYPE_ID,
            locale: NS,
          },
          PlayerTitle,
        ),
      ),
    'strudel-player: tab title',
  );

  ctx.effect(() => connectState(), 'strudel-player: live pattern');
  ctx.effect(() => () => {
    pluginCtx = null;
    if (synthTimer !== null) {
      clearTimeout(synthTimer);
      synthTimer = null;
    }
    try {
      hush();
    } catch {
      // The engine was never started.
    }
  }, 'strudel-player: silence on unload');
}
