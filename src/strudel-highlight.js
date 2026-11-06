/**
 * Strudel mini-notation highlighting for CodeMirror.
 *
 * JavaScript highlighting paints the string as a string. On top of that, this
 * layer paints the mini-notation tokens inside double-quoted and backtick
 * strings, so `s("bd sd [~ bd]")` reads like a pattern instead of one green
 * blob. Template literals with interpolation are left alone: their `${...}`
 * parts are JavaScript, not mini-notation.
 */
import { RangeSetBuilder } from '@codemirror/state';
import { Decoration, ViewPlugin } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';

const BRACKETS = new Set(['[', ']', '<', '>', '(', ')']);
const OPERATORS = new Set(['*', '/', '@', '!', '?', '|', ',', ':']);
const TOKEN = /(\*|~|!|@|\?|\||,|:|\[|\]|<|>|\(|\)|\/|\d+(?:\.\d+)?|[A-Za-z_][A-Za-z0-9_#-]*)/g;

const marks = {
  operator: Decoration.mark({ class: 'strudel-mn-operator' }),
  bracket: Decoration.mark({ class: 'strudel-mn-bracket' }),
  number: Decoration.mark({ class: 'strudel-mn-number' }),
  rest: Decoration.mark({ class: 'strudel-mn-rest' }),
  name: Decoration.mark({ class: 'strudel-mn-name' }),
};

function markFor(value) {
  if (value === '~') return marks.rest;
  if (BRACKETS.has(value)) return marks.bracket;
  if (OPERATORS.has(value)) return marks.operator;
  if (/^\d/.test(value)) return marks.number;
  return marks.name;
}

/**
 * Build the mini-notation decorations for one document state.
 * @param state - CodeMirror editor state carrying the JavaScript language.
 * @returns a sorted decoration set, safe for the view plugin.
 */
export function miniNotationRanges(state) {
  const builder = new RangeSetBuilder();
  const doc = state.doc;
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== 'String' && node.name !== 'TemplateString') return;
      const raw = doc.sliceString(node.from, node.to);
      const quoted = raw.startsWith('"') || raw.startsWith('`');
      if (!quoted || raw.length < 2 || raw.includes('${')) return false;
      const start = node.from + 1;
      const end = node.to - 1;
      if (end <= start) return false;
      const content = doc.sliceString(start, end);
      TOKEN.lastIndex = 0;
      let match;
      while ((match = TOKEN.exec(content)) !== null) {
        const from = start + match.index;
        builder.add(from, from + match[0].length, markFor(match[0]));
      }
      return false;
    },
  });
  return builder.finish();
}

/** CodeMirror extension that repaints mini-notation as the document changes. */
export const miniNotationHighlighting = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = miniNotationRanges(view.state);
    }

    update(update) {
      if (update.docChanged || update.viewportChanged) {
        // Patterns are small, so rebuilding on every change keeps this layer
        // trivially correct across edits and viewport updates.
        this.decorations = miniNotationRanges(update.state);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);
