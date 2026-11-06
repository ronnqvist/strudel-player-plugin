/**
 * Pure evaluation check for the synth rack.
 *
 * This file imports the Strudel packages directly, so it must be bundled
 * before Node can run it (see `test/run-rack.mjs`): the published ESM entry of
 * `@strudel/core` re-exports a name that Node's resolver cannot link, while a
 * bundler resolves it the same way the browser bundle does.
 *
 * It evaluates the exact rack strings `src/synth-rack.js` generates and checks
 * that they override what they claim to override.
 */
import { transpiler } from '@strudel/transpiler';
import * as core from '@strudel/core';
import * as mini from '@strudel/mini';
import { buildSynthRack, cutoffHz, SYNTH_DEFAULTS, synthActive } from '../src/synth-rack.js';

for (const [key, value] of Object.entries({ ...core, ...mini })) globalThis[key] = value;

const transforms = [];
globalThis.all = (fn) => {
  transforms.push(fn);
};

const failures = [];
const check = (condition, label) => {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures.push(label);
    console.log(`  FAIL ${label}`);
  }
};

async function evaluateCode(source) {
  const { output } = transpiler(source, {});
  const body = `"use strict";return ((async ()=>{${output}})())`;
  let pattern = await Function(body)();
  for (const fn of transforms.splice(0)) pattern = fn(pattern);
  return pattern;
}

function haps(pattern) {
  return pattern.queryArc(0, 1).map((hap) => hap.value);
}

const values = (rows, key) => [...new Set(rows.map((row) => row[key]))];

const BASE = `
stack(
  s("bd:0 bd:2 ~ bd:1, ~ cp ~ cp, hh*8?0.65").gain(0.9),
  note("c2 [eb2 g2] c2 bb1").s("sawtooth").lpf(620).gain(0.55),
  note("<[c4,eb4,g4] [ab3,c4,eb4] [f3,ab3,c4] [g3,bb3,d4]>").s("triangle").room(0.6).gain(0.3)
)`;

/* Rack strings exactly as the player generates them. */
const ACID = buildSynthRack({ ...SYNTH_DEFAULTS, cutoff: 50, resonance: 4, room: 40, delay: 20, volume: 90 });
const WAVE = buildSynthRack({ ...SYNTH_DEFAULTS, wave: 'square' });
const EXPECTED_CUTOFF = String(cutoffHz(50));

check(buildSynthRack({ ...SYNTH_DEFAULTS }) === '', 'a neutral rack adds no statement');
check(synthActive({ ...SYNTH_DEFAULTS }) === false, 'a neutral rack reports itself inactive');
check(synthActive({ ...SYNTH_DEFAULTS, room: 10 }) === true, 'a moved control reports the rack active');
check(ACID.startsWith('all((p) => p'), 'the rack is one all() statement');
check(!ACID.includes('"'), 'generated strings are single-quoted so the Strudel transpiler leaves them alone');

const plainRows = haps(await evaluateCode(BASE));
check(plainRows.length > 0, 'the fixture pattern evaluates');
check(values(plainRows, 's').includes('sawtooth'), 'the fixture really has synth voices');
check(!values(plainRows, 'postgain').includes(0.9), 'the fixture starts without a rack');

const racked = haps(await evaluateCode(`${ACID}\n${BASE}`));
check(values(racked, 'cutoff').join() === EXPECTED_CUTOFF, 'the rack overrides the pattern filter cutoff');
check(values(racked, 'resonance').join() === '4', 'the rack sets resonance');
check(values(racked, 'room').join() === '0.4', 'the rack replaces the pattern reverb send');
check(values(racked, 'delay').join() === '0.2', 'the rack sets the delay send');
check(values(racked, 'postgain').join() === '0.9', 'the rack sets the master level');
check(racked.length === plainRows.length, 'the rack keeps every event');

const waved = haps(await evaluateCode(`${WAVE}\n${BASE}`));
check(!values(waved, 's').includes('sawtooth'), 'the wave control replaces synth waveforms');
check(values(waved, 's').includes('square'), 'the wave control applies the chosen waveform');
check(values(waved, 's').includes('bd') && values(waved, 's').includes('cp'), 'drum samples are untouched by the wave control');
check(values(waved, 's').includes('hh'), 'hi-hat samples are untouched by the wave control');
check(!values(waved, 'cutoff').includes(EXPECTED_CUTOFF), 'the wave control alone leaves the filter alone');

const both = haps(await evaluateCode(`${WAVE}\n${ACID}\n${BASE}`));
check(values(both, 's').includes('square'), 'wave and rack combine');
check(values(both, 'cutoff').join() === EXPECTED_CUTOFF, 'wave and rack combine without dropping the filter');

const neutral = haps(await evaluateCode(`${BASE}`));
check(neutral.length === plainRows.length, 'a neutral rack is a no-op');

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log('\nall synth-rack checks passed');
}
