import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EditorState} from '@codemirror/state';
import {history, undo, redo} from '@codemirror/commands';
import {sortTransactions} from '../src/sort';
import {taskSections, toggleTaskSection} from '../src/sections';

function editor(doc: string) {
  let state = EditorState.create({doc, extensions: [sortTransactions, taskSections, history()]});
  return {
    get state() { return state; },
    dispatch(tr: ReturnType<EditorState['update']>) { state = tr.state; },
    toggle(from: number) { state = state.update({effects: toggleTaskSection.of(from)}).state; },
    sections() { return state.field(taskSections); }
  };
}

test('all three task states get separate sections, expanded by default', () => {
  const e = editor('- [/] Active\n- [ ] Open\n- [x] A\n- [X] B');
  const {sections, collapsed, decorations} = e.sections();
  assert.deepEqual(sections, [
    {from: 0, to: 12, indent: 0, count: 1, kind: 'in-progress'},
    {from: 13, to: 23, indent: 0, count: 1, kind: 'unchecked'},
    {from: 24, to: e.state.doc.length, indent: 0, count: 2, kind: 'completed'},
  ]);
  assert.equal(collapsed.size, 0);
  assert.equal(decorations.size, 3);
});

test('a new in-progress task reveals its section and leaves the completed fold closed', () => {
  const e = editor('- [/] Active\n- [ ] Start me\n- [ ] Still open\n- [x] Done');
  const [active, , done] = e.sections().sections;
  e.toggle(active.from);
  e.toggle(done.from);
  assert.deepEqual([...e.sections().collapsed], [active.from, done.from]);
  const position = e.state.doc.line(2).from + 3;
  e.dispatch(e.state.update({changes: {from: position, to: position + 1, insert: '/'}, userEvent: 'input.type'}));
  assert.equal(e.state.doc.toString(), '- [/] Start me\n- [/] Active\n- [ ] Still open\n- [x] Done');
  assert.equal(e.sections().sections[0].count, 2);
  assert.deepEqual([...e.sections().collapsed], [done.from]);
});

test('collapse and expand alter only decorations, never document or history', () => {
  const doc = '- [ ] Open A\n- [ ] Open B';
  const e = editor(doc), from = e.sections().sections[0].from;
  e.toggle(from);
  assert.equal(e.sections().collapsed.has(from), true);
  const cursor = e.sections().decorations.iter();
  assert.equal(cursor.from, from);
  assert.equal(cursor.to, doc.length);
  assert.equal(e.state.doc.toString(), doc);
  assert.equal(undo(e as any), false);
  e.toggle(from);
  assert.equal(e.sections().collapsed.size, 0);
  assert.equal(e.sections().decorations.iter().from, e.sections().decorations.iter().to);
  assert.equal(e.state.doc.toString(), doc);
});

test('existing unsorted lists never hide unchecked siblings', () => {
  const e = editor('- [x] A\n- [ ] Open\n- [x] B');
  const sections = e.sections().sections;
  assert.equal(sections.length, 3);
  e.toggle(sections[0].from);
  e.toggle(sections[2].from);
  e.sections().decorations.between(0, e.state.doc.length, (from, to) => {
    assert.equal(e.state.doc.sliceString(from, to).includes('Open'), false);
  });
});

test('collapsed parent covers attached content and suppresses nested widgets', () => {
  const e = editor('- [x] Parent\n  detail\n  - [x] Child\n- [ ] Next');
  const sections = e.sections().sections;
  assert.equal(sections.length, 3);
  assert.equal(sections[1].indent, 2);
  e.toggle(sections[0].from);
  assert.equal(e.sections().decorations.size, 2);
  assert.equal(e.sections().decorations.iter().to, e.state.doc.line(3).to);
  e.toggle(sections[0].from);
  assert.equal(e.sections().decorations.size, 3);
});

test('headings and blank lines split sections, ignored contexts get no widgets', () => {
  const e = editor('---\n- [x] YAML\n---\n```\n- [x] Code\n```\n> - [x] Quote\n- [?] Custom\n- [x] A\n\n- [x] B\n# Title\n- [x] C');
  assert.deepEqual(e.sections().sections.map(s => s.count), [1, 1, 1]);
});

test('unaffected folds follow edits above; edits within a fold reveal changed content', () => {
  const e = editor('Title\n\n- [ ] Open\n- [x] A');
  e.toggle(e.sections().sections[0].from);
  e.dispatch(e.state.update({changes: {from: 0, insert: 'New '}, userEvent: 'input.type'}));
  const section = e.sections().sections[0];
  assert.equal(e.sections().collapsed.has(section.from), true);
  e.dispatch(e.state.update({changes: {from: section.to, insert: ' detail'}, userEvent: 'input.type'}));
  assert.equal(e.sections().collapsed.size, 0);
});

test('source navigation into hidden text expands its section', () => {
  const e = editor('- [ ] Open\n- [x] A');
  const section = e.sections().sections[0];
  e.toggle(section.from);
  e.dispatch(e.state.update({selection: {anchor: section.from + 4}, userEvent: 'select'}));
  assert.equal(e.sections().collapsed.size, 0);
});

test('sorting and fold decorations cooperate with single-step undo and redo', () => {
  const doc = '- [ ] A\n- [ ] B\n- [x] C';
  const e = editor(doc);
  e.toggle(e.sections().sections[1].from);
  e.dispatch(e.state.update({changes: {from: 3, to: 4, insert: 'x'}, userEvent: 'input'}));
  assert.equal(e.state.doc.toString(), '- [ ] B\n- [x] A\n- [x] C');
  assert.equal(e.sections().sections[1].count, 2);
  assert.equal(e.sections().collapsed.size, 0);
  assert.equal(undo(e as any), true);
  assert.equal(e.state.doc.toString(), doc);
  assert.equal(e.sections().sections[1].count, 1);
  assert.equal(redo(e as any), true);
  assert.equal(e.sections().sections[1].count, 2);
});
