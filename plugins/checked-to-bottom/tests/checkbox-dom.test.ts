import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {EditorState, StateField} from '@codemirror/state';
import {Decoration, EditorView, WidgetType} from '@codemirror/view';
import {history, undo, redo} from '@codemirror/commands';
import {checkedToBottom} from '../src/sort';
import {completedSections} from '../src/sections';

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
    const line = state.doc.line(i), match = /^\s*- \[([ xX])\]/.exec(line.text);
    if (match) result.push(Decoration.replace({widget: new TaskCheckbox(match[1])}).range(line.from, line.from + match[0].length));
  }
  return Decoration.set(result);
};
const livePreview = StateField.define({create: widgets,
  update(value, tr) { return tr.docChanged ? widgets(tr.state) : value; },
  provide: field => EditorView.decorations.from(field)});

for (const accordion of [false, true]) {
  test(`native checkbox click preserves sibling display (accordion ${accordion})`, () => {
    const dom = new JSDOM('<!doctype html><body></body>', {pretendToBeVisual: true});
    const names = ['window', 'document', 'MutationObserver', 'HTMLElement', 'Node', 'Window', 'getComputedStyle'];
    const originals = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
    for (const name of names) Object.defineProperty(globalThis, name, {configurable: true, value: (dom.window as any)[name]});
    const original = '- [ ] First task\n- [ ] Second task\n- [x] Older task';
    const view = new EditorView({parent: dom.window.document.body,
      state: EditorState.create({doc: original, extensions: [history(), livePreview, checkedToBottom, accordion ? completedSections : []]})});
    const checkboxes = () => [...view.dom.querySelectorAll<HTMLInputElement>('input.task-list-item-checkbox')];
    const verify = () => {
      const statuses = view.state.doc.toString().split('\n').map(line => line.includes('[x]'));
      assert.deepEqual(checkboxes().map(input => input.checked), statuses, 'visible checkboxes must match Markdown');
    };
    try {
      checkboxes()[0].click();
      assert.equal(view.state.doc.toString(), '- [ ] Second task\n- [x] First task\n- [x] Older task');
      verify();
      undo(view); assert.equal(view.state.doc.toString(), original); verify();
      redo(view); verify();
      checkboxes()[0].click();
      assert.equal(view.state.doc.toString(), '- [x] Second task\n- [x] First task\n- [x] Older task');
      verify();
      checkboxes()[2].click();
      assert.equal(view.state.doc.toString(), '- [ ] Older task\n- [x] Second task\n- [x] First task');
      verify();
    } finally {
      view.destroy(); dom.window.close();
      names.forEach((name, i) => originals[i] ? Object.defineProperty(globalThis, name, originals[i]!) : delete (globalThis as any)[name]);
    }
  });
}
