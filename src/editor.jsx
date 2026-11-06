/**
 * The pattern editor: CodeMirror with JavaScript highlighting plus a Strudel
 * layer that paints mini-notation inside double-quoted and backtick strings.
 *
 * Colours come from the host's Shiki token variables, so the editor follows the
 * active light/dark theme and the user's code-font settings. Only the caret,
 * selection and surfaces use `--dsw-alias-*` tokens.
 */
import React from 'react';
import { EditorState } from '@codemirror/state';
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import {
  HighlightStyle,
  bracketMatching,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { tags as t } from '@lezer/highlight';
import { miniNotationHighlighting } from './strudel-highlight.js';

const token = (name, fallback) => `var(--shiki-token-${name}, ${fallback})`;

const highlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.moduleKeyword], color: token('keyword', '#d6336c') },
  { tag: [t.string, t.special(t.string), t.regexp], color: token('string', '#2f9e44') },
  { tag: [t.number, t.bool, t.null, t.atom], color: token('constant', '#1c7ed6') },
  { tag: [t.comment], color: token('comment', '#868e96'), fontStyle: 'italic' },
  {
    tag: [t.function(t.variableName), t.function(t.propertyName), t.propertyName],
    color: token('function', '#6741d9'),
  },
  {
    tag: [t.variableName, t.definition(t.variableName)],
    color: 'var(--shiki-foreground, var(--dsw-alias-label-primary))',
  },
  {
    tag: [t.operator, t.bracket, t.paren, t.brace, t.squareBracket, t.angleBracket, t.separator],
    color: token('punctuation', '#495057'),
  },
  { tag: [t.escape], color: token('string-expression', '#2b8a3e') },
]);

const editorTheme = EditorView.theme(
  {
    '&': {
      height: '100%',
      backgroundColor: 'transparent',
      color: 'var(--dsw-alias-label-primary)',
      fontSize: 'var(--dsh-code-font-size, 12px)',
    },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': {
      fontFamily:
        'var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)',
      lineHeight: '1.6',
      overflow: 'auto',
    },
    '.cm-content': {
      padding: '8px 0',
      caretColor: 'var(--dsw-alias-brand-primary)',
    },
    '.cm-line': { padding: '0 10px 0 6px' },
    '.cm-gutters': {
      backgroundColor: 'transparent',
      color: 'var(--dsw-alias-label-secondary)',
      border: 'none',
      userSelect: 'none',
    },
    '.cm-lineNumbers .cm-gutterElement': {
      padding: '0 4px 0 10px',
      minWidth: '24px',
      opacity: '0.7',
    },
    '.cm-activeLine': {
      backgroundColor: 'color-mix(in srgb, var(--dsw-alias-bg-layer-1) 60%, transparent)',
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'transparent',
      color: 'var(--dsw-alias-label-primary)',
      opacity: '1',
    },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
      backgroundColor:
        'color-mix(in srgb, var(--dsw-alias-brand-primary) 22%, transparent) !important',
    },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--dsw-alias-brand-primary)' },
    '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
      backgroundColor: 'color-mix(in srgb, var(--dsw-alias-brand-primary) 18%, transparent)',
      outline: 'none',
    },
    '.strudel-mn-operator': {
      color: token('keyword', '#d6336c'),
      fontWeight: '600',
    },
    '.strudel-mn-bracket': {
      color: token('punctuation', '#495057'),
      fontWeight: '600',
    },
    '.strudel-mn-number': { color: token('constant', '#1c7ed6') },
    '.strudel-mn-name': { color: token('parameter', '#e8590c') },
    '.strudel-mn-rest': { color: token('comment', '#868e96'), fontStyle: 'italic' },
  },
  { dark: false },
);

/**
 * A controlled code editor with Strudel-aware highlighting.
 * @param {object} props - controlled value, change callback, shortcuts and label.
 * @returns {React.ReactElement} the editor host element.
 */
export function CodeEditor({ value, ariaLabel, onChange, onPlay, onStop }) {
  const hostRef = React.useRef(null);
  const viewRef = React.useRef(null);
  const callbacks = React.useRef({ onChange, onPlay, onStop });
  callbacks.current = { onChange, onPlay, onStop };
  const initialValue = React.useRef(value);

  React.useEffect(() => {
    const state = EditorState.create({
      doc: initialValue.current,
      extensions: [
        lineNumbers(),
        history(),
        drawSelection(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        javascript({ jsx: false, typescript: false }),
        syntaxHighlighting(highlightStyle),
        miniNotationHighlighting,
        editorTheme,
        EditorView.contentAttributes.of({
          spellcheck: 'false',
          autocapitalize: 'off',
          autocomplete: 'off',
          'aria-label': ariaLabel,
        }),
        EditorState.tabSize.of(2),
        keymap.of([
          {
            key: 'Mod-Enter',
            preventDefault: true,
            run: () => {
              callbacks.current.onPlay();
              return true;
            },
          },
          {
            key: 'Mod-.',
            preventDefault: true,
            run: () => {
              callbacks.current.onStop();
              return true;
            },
          },
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          indentWithTab,
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const next = update.state.doc.toString();
            if (next !== update.startState.doc.toString()) callbacks.current.onChange(next);
          }
        }),
      ],
    });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    return () => {
      viewRef.current = null;
      view.destroy();
    };
    // The editor is created once; controlled value changes flow through the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    const focused = view.hasFocus;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
      ...(focused
        ? {}
        : {
            selection: { anchor: 0 },
            effects: EditorView.scrollIntoView(0, { y: 'start' }),
          }),
    });
  }, [value]);

  return <div className="strudel-player-editor" ref={hostRef} />;
}
