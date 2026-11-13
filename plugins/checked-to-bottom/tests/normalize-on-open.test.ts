import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setTimeout as nextTurn} from 'node:timers/promises';
import {history, redo, undo, undoDepth} from '@codemirror/commands';
import {EditorState, StateEffect, Transaction} from '@codemirror/state';
import {EditorView} from '@codemirror/view';
import {JSDOM} from 'jsdom';
import {completedSections} from '../src/sections';
import {normalizeOnOpen} from '../src/normalize-on-open';

test('normalizes mixed lists on enable and note switch, in one undoable edit', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', {pretendToBeVisual: true});
  // JSDOM has no layout. CodeMirror measures text during its animation frame.
  Object.defineProperty(dom.window.Range.prototype, 'getClientRects', {value: () => []});
  const names = ['window', 'document', 'MutationObserver', 'HTMLElement', 'Node', 'Window', 'getComputedStyle'];
  const originals = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  for (const name of names) Object.defineProperty(globalThis, name, {configurable: true, value: (dom.window as any)[name]});

  const fencedExample = '~~~md\n- [x] Example\n- [ ] Example two\n~~~\n';
  const first = [
    '- [x] Parent', '  Attached text', '  - [X] Finished child', '  - [ ] Open child',
    '- [ ] Open A', '- [x] Done B', '- [ ] Open B', '- [x] Done C',
    '', '# Separate', '- [x] Separate done', '- [ ] Separate open', '', fencedExample,
  ].join('\n');
  const expected = [
    '- [ ] Open A', '- [ ] Open B', '- [x] Parent', '  Attached text',
    '  - [ ] Open child', '  - [X] Finished child', '- [x] Done B', '- [x] Done C',
    '', '# Separate', '- [ ] Separate open', '- [x] Separate done', '', fencedExample,
  ].join('\n');
  const child = first.indexOf('Open child');
  const view = new EditorView({parent: dom.window.document.body, state: EditorState.create({
    doc: first, selection: {anchor: child + 4, head: child},
    extensions: [history(), completedSections],
  })});
  let file = {};
  const extension = normalizeOnOpen(() => file);
  try {
    assert.equal(view.state.doc.toString(), first);
    view.dispatch({effects: StateEffect.appendConfig.of(extension)});
    await nextTurn(0);
    assert.equal(view.state.doc.toString(), expected);
    const moved = expected.indexOf('Open child');
    assert.equal(view.state.selection.main.anchor, moved + 4);
    assert.equal(view.state.selection.main.head, moved);
    assert.equal(undoDepth(view.state), 1);
    const headers = [...view.dom.querySelectorAll('.ctb-completed-toggle')].map(el => el.textContent);
    assert.equal(headers.filter(text => text?.endsWith('Completed · 3')).length, 1);

    assert.equal(undo(view), true);
    await nextTurn(0);
    assert.equal(view.state.doc.toString(), first);
    assert.equal(redo(view), true);
    assert.equal(view.state.doc.toString(), expected);

    const second = '- [x] Another done\n- [ ] Another open';
    file = {};
    view.dispatch({changes: {from: 0, to: view.state.doc.length, insert: second},
      annotations: Transaction.addToHistory.of(false)});
    await nextTurn(0);
    assert.equal(view.state.doc.toString(), '- [ ] Another open\n- [x] Another done');
  } finally {
    view.destroy();
    dom.window.close();
    names.forEach((name, index) => originals[index] ?
      Object.defineProperty(globalThis, name, originals[index]!) : delete (globalThis as any)[name]);
  }
});
