import {EditorSelection, EditorState, Transaction} from '@codemirror/state';
import {ViewPlugin, type EditorView} from '@codemirror/view';

// Obsidian's Live Preview checkbox widget dispatches without a userEvent.
// Admit only synchronous input from that widget, never unlabelled file reloads.
const checkboxInputs = new WeakSet<EditorState>();
const checkboxInput = ViewPlugin.fromClass(class {
  private capture = (event: Event) => {
    const target = event.target as HTMLInputElement | null;
    if (target?.matches('input.task-list-item-checkbox')) {
      // Native activation already flipped .checked. Reordering can reuse this
      // same widget for another task with the old status, skipping updateDOM.
      // Restore the rendered status before Obsidian dispatches its edit; that
      // edit reads the Markdown marker, not .checked, and renders the new state.
      const renderedStatus = target.getAttribute('data-task');
      if (renderedStatus !== null) target.checked = renderedStatus !== ' ';
      const state = this.view.state;
      checkboxInputs.add(state);
      // Native input can run a microtask checkpoint between DOM listeners.
      setTimeout(() => checkboxInputs.delete(state), 0);
    }
  };
  constructor(private view: EditorView) {
    view.dom.addEventListener('input', this.capture, true);
  }
  destroy() { this.view.dom.removeEventListener('input', this.capture, true); }
});

type Item = {start: number; end: number; indent: number; status: number; done: boolean};
const indentation = (s: string) => {
  let width = 0;
  for (const c of s.match(/^[\t ]*/)![0]) width += c === '\t' ? 4 - width % 4 : 1;
  return width;
};

export function itemsIn(text: string): {lines: string[]; items: Item[]} {
  const lines = text.split('\n');
  const items: Item[] = [];
  let frontmatter = lines[0] === '---';
  let fence: {char: string; length: number} | undefined;
  for (let start = 0; start < lines.length; start++) {
    const line = lines[start];
    if (frontmatter) {
      if (start > 0 && /^(---|\.\.\.)\s*$/.test(line)) frontmatter = false;
      continue;
    }
    const marker = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      continue;
    }
    if (marker) { fence = {char: marker[1][0], length: marker[1].length}; continue; }
    const task = line.match(/^([\t ]*)[-+*] +\[([ xX])\](?:\s|$)/);
    if (!task) continue;
    const indent = indentation(line);
    // Root indented code is not a checklist.
    if (indent >= 4 && !items.some(item => item.start < start && item.end > start && item.indent < indent)) continue;
    let end = start + 1;
    while (end < lines.length) {
      if (!lines[end].trim()) {
        let next = end;
        while (next < lines.length && !lines[next].trim()) next++;
        if (next === lines.length || indentation(lines[next]) <= indent) break;
        end = next;
      }
      if (indentation(lines[end]) <= indent) break;
      end++;
    }
    items.push({start, end, indent, status: line.indexOf('[') + 1, done: task[2] !== ' '});
  }
  return {lines, items};
}

export const sortTransactions = EditorState.transactionFilter.of(tr => {
  if (!tr.docChanged || tr.isUserEvent('undo') || tr.isUserEvent('redo') ||
      tr.annotation(Transaction.remote) ||
      (!tr.isUserEvent('input') && !checkboxInputs.has(tr.startState))) return tr;
  // A pure status toggle may arrive as either a character or whole-line edit.
  // Pasting a list, editing descriptions, and compound edits are left alone.
  if (tr.isUserEvent('input.paste') || tr.isUserEvent('input.drop') ||
      tr.newDoc.length !== tr.startState.doc.length) return tr;
  let position = -1, differences = 0;
  tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    const before = tr.startState.doc.sliceString(fromA, toA);
    const after = inserted.toString();
    if (before.length !== after.length || fromA !== fromB || toA !== toB) { differences += 2; return; }
    for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) { differences++; position = fromB + i; }
  });
  if (differences !== 1) return tr;
  const before = tr.startState.doc.sliceString(position, position + 1);
  const after = tr.newDoc.sliceString(position, position + 1);
  if (!((before === ' ' && /[xX]/.test(after)) || (/[xX]/.test(before) && after === ' '))) return tr;
  const {lines, items} = itemsIn(tr.newDoc.toString());
  const changedLine = tr.newDoc.lineAt(position);
  const moved = items.find(item => item.start === changedLine.number - 1 && changedLine.from + item.status === position);
  if (!moved) return tr;
  let first = moved, last = moved;
  while (true) {
    const previous = items.find(item => item.end === first.start && item.indent === moved.indent);
    if (!previous) break;
    first = previous;
  }
  while (true) {
    const next = items.find(item => item.start === last.end && item.indent === moved.indent);
    if (!next) break;
    last = next;
  }
  const group = items.filter(item => item.indent === moved.indent && item.start >= first.start && item.start <= last.start);
  const reordered = group.filter(item => item !== moved);
  const completed = reordered.findIndex(item => item.done);
  reordered.splice(completed === -1 ? reordered.length : completed, 0, moved);
  if (group.every((item, i) => item === reordered[i])) return tr;
  const from = tr.newDoc.line(first.start + 1).from;
  const to = tr.newDoc.line(last.end).to;
  let offset = from;
  const segments = reordered.map(item => {
    const content = lines.slice(item.start, item.end).join('\n');
    const oldFrom = tr.newDoc.line(item.start + 1).from;
    const segment = {oldFrom, oldTo: oldFrom + content.length, newFrom: offset, content};
    offset += content.length + 1;
    return segment;
  });
  const map = (pos: number) => {
    const segment = segments.find(s => pos >= s.oldFrom && pos <= s.oldTo);
    return segment ? segment.newFrom + pos - segment.oldFrom : pos;
  };
  const selection = EditorSelection.create(tr.newSelection.ranges.map(range =>
    EditorSelection.range(map(range.anchor), map(range.head))), tr.newSelection.mainIndex);
  return [tr, {changes: {from, to, insert: segments.map(s => s.content).join('\n')}, selection, sequential: true}];
});

export const checkedToBottom = [checkboxInput, sortTransactions];
