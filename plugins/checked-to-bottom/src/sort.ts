import {EditorSelection, EditorState, Text, Transaction} from '@codemirror/state';
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

// A sibling can follow a task only at the end of its entire block.
function checklistGroups(items: Item[]): Item[][] {
  const groups: Item[][] = [];
  const byEnd = new Map<string, Item[]>();
  for (const item of items) {
    const key = `${item.indent}:${item.start}`;
    let group = byEnd.get(key);
    if (group) {
      byEnd.delete(key);
    } else {
      group = [];
      groups.push(group);
    }
    group.push(item);
    byEnd.set(`${item.indent}:${item.end}`, group);
  }
  return groups;
}

function reorderChecklists(doc: Text, selection: EditorSelection, lines: string[],
                           groups: Item[][], toggled?: Item) {
  const changed = groups.flatMap(group => {
    const rest = group.filter(item => item !== toggled);
    const unchecked = rest.filter(item => !item.done);
    const checked = rest.filter(item => item.done);
    // A toggled task goes at the boundary, regardless of its new status.
    const ordered = toggled ? [...unchecked, toggled, ...checked] : [...unchecked, ...checked];
    if (group.every((item, index) => item === ordered[index])) return [];
    return [{start: group[0].start, end: group[group.length - 1].end, ordered}];
  });
  if (!changed.length) return;

  const lineOrder = lines.map((_, index) => index);
  // Apply inner permutations first so moving a parent carries the reordered children.
  for (const {start, ordered} of [...changed].reverse()) {
    const block = ordered.flatMap(item => lineOrder.slice(item.start, item.end));
    for (let index = 0; index < block.length; index++) lineOrder[start + index] = block[index];
  }

  const sortedLines = lineOrder.map(index => lines[index]);
  const sortedDoc = Text.of(sortedLines);
  const destination: number[] = [];
  lineOrder.forEach((original, index) => { destination[original] = index; });
  const map = (position: number) => {
    const line = doc.lineAt(position);
    return sortedDoc.line(destination[line.number - 1] + 1).from + position - line.from;
  };
  // An outer replacement already includes every nested replacement in its range.
  let replacedThrough = 0;
  const changes = changed.flatMap(({start, end}) => {
    if (start < replacedThrough) return [];
    replacedThrough = end;
    return [{from: doc.line(start + 1).from, to: doc.line(end).to,
      insert: sortedLines.slice(start, end).join('\n')}];
  });
  return {changes, selection: EditorSelection.create(selection.ranges.map(range =>
    range.empty ? EditorSelection.cursor(map(range.head), range.assoc) :
      EditorSelection.range(map(range.anchor), map(range.head))), selection.mainIndex)};
}

export function normalizeChecklists(state: EditorState) {
  const {lines, items} = itemsIn(state.doc.toString());
  return reorderChecklists(state.doc, state.selection, lines, checklistGroups(items));
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
  const group = checklistGroups(items).find(group => group.includes(moved))!;
  const change = reorderChecklists(tr.newDoc, tr.newSelection, lines, [group], moved);
  return change ? [tr, {...change, sequential: true}] : tr;
});

export const checkedToBottom = [checkboxInput, sortTransactions];
