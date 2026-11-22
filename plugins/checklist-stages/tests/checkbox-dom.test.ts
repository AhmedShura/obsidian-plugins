import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {EditorState, StateField} from '@codemirror/state';
import {Decoration, EditorView, WidgetType} from '@codemirror/view';
import {history, undo, redo} from '@codemirror/commands';
import {taskStateExtension} from '../src/sort';
import {taskSections} from '../src/sections';

// Obsidian 1.15 Live Preview contract: equality is by status; native input
// edits the Markdown; updateDOM only reconciles widgets whose status changed.
class TaskCheckbox extends WidgetType {
  constructor(readonly status: string) { super(); }
  eq(other: TaskCheckbox) { return this.status === other.status; }
  updateDOM(dom: HTMLElement) {
    const input = dom.firstElementChild as HTMLInputElement;
    input.dataset.task = this.status;
    input.checked = this.status !== ' ';
    return true;
  }
  toDOM(view: EditorView) {
    const label = view.dom.ownerDocument.createElement('label');
    const input = label.appendChild(view.dom.ownerDocument.createElement('input'));
    input.type = 'checkbox'; input.className = 'task-list-item-checkbox';
    input.dataset.task = this.status; input.checked = this.status !== ' ';
    input.addEventListener('input', () => {
      const line = view.state.doc.lineAt(view.posAtDOM(input));
      const position = line.from + line.text.indexOf('[') + 1;
      const status = view.state.doc.sliceString(position, position + 1);
      view.dispatch({changes: {from: position, to: position + 1, insert: status === ' ' ? 'x' : ' '}});
    });
    return label;
  }
}
const widgets = (state: EditorState) => {
  const result = [];
  for (let i = 1; i <= state.doc.lines; i++) {
    const line = state.doc.line(i), match = /^\s*- \[([ /xX])\]/.exec(line.text);
    if (match) result.push(Decoration.replace({widget: new TaskCheckbox(match[1])}).range(line.from, line.from + match[0].length));
  }
  return Decoration.set(result);
};
const livePreview = StateField.define({create: widgets,
  update(value, tr) { return tr.docChanged ? widgets(tr.state) : value; },
  provide: field => EditorView.decorations.from(field)});

for (const accordion of [false, true]) {
  test(`native checkbox cycles, sorts, and renders through undo and redo (accordion ${accordion})`, () => {
    const dom = new JSDOM('<!doctype html><body></body>', {pretendToBeVisual: true});
    const names = ['window', 'document', 'MutationObserver', 'HTMLElement', 'Node', 'Window', 'getComputedStyle'];
    const originals = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
    for (const name of names) Object.defineProperty(globalThis, name, {configurable: true, value: (dom.window as any)[name]});
    const original = '- [/] Active task\n- [ ] Second task\n- [ ] First task\n- [x] Older task';
    const started = '- [/] First task\n- [/] Active task\n- [ ] Second task\n- [x] Older task';
    const completed = '- [/] Active task\n- [ ] Second task\n- [x] First task\n- [x] Older task';
    const reopened = '- [/] Active task\n- [ ] First task\n- [ ] Second task\n- [x] Older task';
    const view = new EditorView({parent: dom.window.document.body,
      state: EditorState.create({doc: original, extensions: [history(), livePreview, taskStateExtension, accordion ? taskSections : []]})});
    const checkboxes = () => [...view.dom.querySelectorAll<HTMLInputElement>('input.task-list-item-checkbox')];
    const verify = (expected: string) => {
      assert.equal(view.state.doc.toString(), expected);
      const markers = expected.split('\n').map(line => line[3]);
      assert.deepEqual(checkboxes().map(input => input.dataset.task), markers);
      assert.deepEqual(checkboxes().map(input => input.checked), markers.map(marker => marker !== ' '));
    };
    try {
      if (accordion) {
        const headers = () => [...view.dom.querySelectorAll<HTMLButtonElement>('.ctb-task-section-toggle')];
        assert.deepEqual(headers().map(button => button.querySelector('span:nth-child(2)')?.textContent),
          ['In progress · 1', 'New · 2', 'Completed · 1']);
        headers()[1].click();
        assert.deepEqual(headers().map(button => button.getAttribute('aria-expanded')), ['true', 'false', 'true']);
        assert.deepEqual(checkboxes().map(input => input.dataset.task), ['/', 'x']);
        headers()[1].click();
        verify(original);
      }
      checkboxes()[2].click();
      verify(started);
      checkboxes()[0].click();
      verify(completed);
      checkboxes()[2].click();
      verify(reopened);
      for (const expected of [completed, started, original]) {
        assert.equal(undo(view), true);
        verify(expected);
      }
      assert.equal(undo(view), false);
      for (const expected of [started, completed, reopened]) {
        assert.equal(redo(view), true);
        verify(expected);
      }
    } finally {
      view.destroy(); dom.window.close();
      names.forEach((name, i) => originals[i] ? Object.defineProperty(globalThis, name, originals[i]!) : delete (globalThis as any)[name]);
    }
  });
}
