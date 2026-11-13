import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EditorState, Transaction} from '@codemirror/state';
import {history, undo, redo} from '@codemirror/commands';
import {sortTransactions} from '../src/sort';

function editor(doc: string) {
  let state = EditorState.create({doc, extensions: [sortTransactions, history()]});
  return {
    get state() {return state;},
    dispatch(tr: Transaction) {state = tr.state;},
    toggle(label: string, userEvent: string | undefined = 'input', wholeLine = false) {
      const line = [...Array(state.doc.lines)].map((_, i) => state.doc.line(i + 1)).find(l => l.text.endsWith(label))!;
      const at = line.from + line.text.indexOf('[') + 1;
      const insert = state.doc.sliceString(at, at + 1) === ' ' ? 'x' : ' ';
      state = state.update({changes: wholeLine ? {from: line.from, to: line.to, insert: line.text.slice(0, at - line.from) + insert + line.text.slice(at - line.from + 1)} : {from: at, to: at + 1, insert}, selection: {anchor: line.to}, userEvent}).state;
    },
    text() {return state.doc.toString();}
  };
}

test('newly completed tasks lead completed section; unchecking returns above completed', () => {
  const e = editor('- [ ] Alpha\n- [ ] Beta\n- [x] Done');
  e.toggle('Alpha');
  assert.equal(e.text(), '- [ ] Beta\n- [x] Alpha\n- [x] Done');
  assert.equal(e.state.selection.main.head, e.state.doc.line(2).to);
  e.toggle('Alpha');
  assert.equal(e.text(), '- [ ] Beta\n- [ ] Alpha\n- [x] Done');
  assert.equal(e.state.selection.main.head, e.state.doc.line(2).to);
});

test('single Undo and Redo restore both status and order without re-sorting', () => {
  const original = '- [ ] Alpha\n- [ ] Beta';
  const e = editor(original);
  e.toggle('Alpha');
  const sorted = e.text();
  assert.equal(undo(e as any), true);
  assert.equal(e.text(), original);
  assert.equal(redo(e as any), true);
  assert.equal(e.text(), sorted);
  assert.equal(redo(e as any), false);
});

test('already-last and single items only change checkbox; trailing newline retained', () => {
  for (const doc of ['- [ ] Alpha', '- [ ] Beta\n- [ ] Alpha\n']) {
    const e = editor(doc); e.toggle('Alpha');
    assert.equal(e.text(), doc.replace('[ ] Alpha', '[x] Alpha'));
  }
});

test('whole-line toggle works, headings and blank lines separate lists', () => {
  const e = editor('# Top\n- [ ] Alpha\n- [ ] Beta\n\n- [ ] Other\n# End\n- [ ] Last');
  e.toggle('Alpha', 'input', true);
  assert.equal(e.text(), '# Top\n- [ ] Beta\n- [x] Alpha\n\n- [ ] Other\n# End\n- [ ] Last');
});

test('nested peers sort, then parent carries entire subtree and attached text', () => {
  const e = editor('- [ ] Parent\n  description\n  - [ ] Child A\n    child detail\n  - [ ] Child B\n- [ ] Next');
  e.toggle('Child A');
  assert.equal(e.text(), '- [ ] Parent\n  description\n  - [ ] Child B\n  - [x] Child A\n    child detail\n- [ ] Next');
  e.toggle('Parent');
  assert.equal(e.text(), '- [ ] Next\n- [x] Parent\n  description\n  - [ ] Child B\n  - [x] Child A\n    child detail');
});

test('blank paragraphs attached to a task move with it', () => {
  const e = editor('- [ ] Alpha\n  details\n\n  more details\n- [ ] Beta');
  e.toggle('Alpha');
  assert.equal(e.text(), '- [ ] Beta\n- [x] Alpha\n  details\n\n  more details');
});

test('non-task and custom-status siblings separate groups', () => {
  for (const separator of ['- plain item', '- [?] Question', 'paragraph', '## Heading']) {
    const e = editor(`- [ ] Alpha\n${separator}\n- [ ] Beta`); e.toggle('Alpha');
    assert.equal(e.text(), `- [x] Alpha\n${separator}\n- [ ] Beta`);
  }
});

test('code fences, frontmatter, callouts, quotes and root indented code are ignored', () => {
  for (const doc of ['```md\n- [ ] Alpha\n- [ ] Beta\n```', '~~~\n- [ ] Alpha\n- [ ] Beta\n~~~', '---\n- [ ] Alpha\n- [ ] Beta\n---', '> [!todo]\n> - [ ] Alpha\n> - [ ] Beta', '    - [ ] Alpha\n    - [ ] Beta']) {
    const e = editor(doc); e.toggle('Alpha');
    assert.equal(e.text(), doc.replace('[ ] Alpha', '[x] Alpha'));
  }
});

test('fenced content stays attached when its parent moves', () => {
  const e = editor('- [ ] Parent\n  ```\n  - [ ] Example\n  ```\n- [ ] Next');
  e.toggle('Parent');
  assert.equal(e.text(), '- [ ] Next\n- [x] Parent\n  ```\n  - [ ] Example\n  ```');
});

test('unlabelled reloads, paste and remote edits never sort', () => {
  for (const event of [undefined, 'input.paste', 'input.drop']) {
    const e = editor('- [ ] Alpha\n- [ ] Beta');
    const tr = e.state.update({changes:{from:3,to:4,insert:'x'},userEvent:event});
    e.dispatch(tr);
    assert.equal(e.text(), '- [x] Alpha\n- [ ] Beta');
  }
  const e = editor('- [ ] Alpha\n- [ ] Beta');
  e.dispatch(e.state.update({changes:{from:3,to:4,insert:'x'},userEvent:'input',annotations:Transaction.remote.of(true)}));
  assert.equal(e.text(), '- [x] Alpha\n- [ ] Beta');
});

test('the checkbox filter ignores ordinary typing and custom status changes', () => {
  const e = editor('- [x] Alpha\n- [ ] Beta');
  assert.equal(e.text(), '- [x] Alpha\n- [ ] Beta');
  e.dispatch(e.state.update({changes:{from:6,to:7,insert:'a'},userEvent:'input.type'}));
  assert.equal(e.text(), '- [x] alpha\n- [ ] Beta');
  e.dispatch(e.state.update({changes:{from:3,to:4,insert:'?'},userEvent:'input.type'}));
  assert.equal(e.text(), '- [?] alpha\n- [ ] Beta');
});

test('uppercase, alternate bullets, tabs and EOF supported', () => {
  const e = editor('* [ ] Parent\n\t+ [X] Child A\n\t+ [ ] Child B\n* [ ] Next\n');
  e.toggle('Child B');
  assert.equal(e.text(), '* [ ] Parent\n\t+ [x] Child B\n\t+ [X] Child A\n* [ ] Next\n');
  e.toggle('Child A');
  assert.equal(e.text(), '* [ ] Parent\n\t+ [ ] Child A\n\t+ [x] Child B\n* [ ] Next\n');
});

test('a checkbox toggle groups the whole affected list and puts the toggled task at the boundary', () => {
  const original = '- [x] Done A\n- [ ] Open A\n- [x] Done B\n- [ ] Open B\n\n- [x] Separate\n- [ ] List';
  const e = editor(original);
  e.toggle('Open A');
  assert.equal(e.text(), '- [ ] Open B\n- [x] Open A\n- [x] Done A\n- [x] Done B\n\n- [x] Separate\n- [ ] List');
  assert.equal(undo(e as any), true);
  assert.equal(e.text(), original);
  e.toggle('Done A');
  assert.equal(e.text(), '- [ ] Open A\n- [ ] Open B\n- [ ] Done A\n- [x] Done B\n\n- [x] Separate\n- [ ] List');
});
