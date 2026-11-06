/**
 * The live synth rack: neutral defaults, the slider mapping, and the
 * `all(...)` statement the player prepends to a pattern at evaluation time.
 *
 * Kept free of React so `test/rack-eval.mjs` can evaluate exactly the strings
 * the player generates instead of a hand-copied approximation.
 */

/** Synth waveforms the engine can synthesize; drum samples are left alone. */
export const WAVES = ['sine', 'triangle', 'sawtooth', 'square'];

/**
 * Neutral synth-rack state. Every value here adds nothing to the pattern, so an
 * untouched rack evaluates the agent's code exactly as written.
 */
export const SYNTH_DEFAULTS = Object.freeze({
  wave: 'auto',
  cutoff: 0,
  resonance: 0,
  room: 0,
  delay: 0,
  volume: 100,
});

/** Map the logarithmic cutoff slider to a filter frequency; 0 means "off". */
export function cutoffHz(value) {
  if (!value) return null;
  return Math.round(80 * Math.pow(200, value / 100));
}

/** Whether any synth control currently changes what the pattern sounds like. */
export function synthActive(synth) {
  return (
    synth.wave !== 'auto' ||
    synth.cutoff > 0 ||
    synth.resonance > 0 ||
    synth.room > 0 ||
    synth.delay > 0 ||
    synth.volume !== 100
  );
}

/**
 * Compose the live synth rack as one `all(...)` statement prepended to the
 * pattern. Strudel applies `all` transforms to the finished pattern, so the
 * rack overrides the agent's controls without editing the code it authored.
 *
 * Every string in the generated code uses single quotes on purpose: Strudel's
 * transpiler turns double-quoted and backtick strings into mini-notation
 * patterns, which would replace plain sample-name comparison with a pattern.
 * The wave control only rewrites existing synth voices; drum sample names,
 * which are not waveform names, pass through untouched.
 *
 * @param {typeof SYNTH_DEFAULTS} synth - current rack state.
 * @returns {string} the statement, or an empty string for a neutral rack.
 */
export function buildSynthRack(synth) {
  const parts = [];
  const wave = WAVES.includes(synth.wave) ? synth.wave : null;
  if (wave) {
    const names = WAVES.map((name) => `'${name}'`).join(', ');
    parts.push(
      `.withValue((v) => (v && typeof v.s === 'string' && [${names}].includes(v.s) ? { ...v, s: '${wave}' } : v))`,
    );
  }
  const cutoff = cutoffHz(synth.cutoff);
  if (cutoff !== null) parts.push(`.lpf(${cutoff})`);
  if (synth.resonance > 0) parts.push(`.lpq(${synth.resonance})`);
  if (synth.room > 0) parts.push(`.room(${(synth.room / 100).toFixed(2)})`);
  if (synth.delay > 0) parts.push(`.delay(${(synth.delay / 100).toFixed(2)})`);
  if (synth.volume !== 100) parts.push(`.postgain(${(synth.volume / 100).toFixed(2)})`);
  if (parts.length === 0) return '';
  return `all((p) => p${parts.join('')})`;
}
