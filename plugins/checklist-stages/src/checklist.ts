import {Text} from '@codemirror/state';

const taskOrder = ['in-progress', 'unchecked', 'completed'] as const;
type TaskState = typeof taskOrder[number];

export function taskState(marker: string): TaskState | undefined {
  switch (marker) {
    case '/': return 'in-progress';
    case ' ': return 'unchecked';
    case 'x': case 'X': return 'completed';
  }
}

type Item = {start: number; end: number; indent: number; markerOffset: number; state: TaskState};
const indentation = (s: string) => {
  let width = 0;
  for (const c of s.match(/^[\t ]*/)![0]) width += c === '\t' ? 4 - width % 4 : 1;
  return width;
};

function itemsIn(text: string): {lines: string[]; items: Item[]} {
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
    const task = line.match(/^[\t ]*[-+*] +\[(.)\](?:\s|$)/);
    const state = task && taskState(task[1]);
    if (!state) continue;
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
    items.push({start, end, indent, markerOffset: line.indexOf('[') + 1, state});
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

type Replacement = {from: number; to: number; insert: string};
export type ChecklistReorder = {changes: Replacement[]; mapPosition: (position: number) => number};

function reorderChecklists(doc: Text, lines: string[], groups: Item[][], toggled?: Item): ChecklistReorder | undefined {
  const changed = groups.flatMap(group => {
    const rest = group.filter(item => item !== toggled);
    const ordered = taskOrder.flatMap(state => {
      const peers = rest.filter(item => item.state === state);
      return toggled?.state === state ? [toggled, ...peers] : peers;
    });
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
  const mapPosition = (position: number) => {
    const line = doc.lineAt(position);
    return sortedDoc.line(destination[line.number - 1] + 1).from + position - line.from;
  };
  // An outer replacement already includes every nested replacement in its range.
  let replacedThrough = 0;
  const changes = changed.flatMap(({start, end}) => {
    if (start < replacedThrough) return [];
    replacedThrough = end;
    // Leave unchanged lines outside the replacement so their folds survive.
    while (lineOrder[start] === start) start++;
    while (lineOrder[end - 1] === end - 1) end--;
    return [{from: doc.line(start + 1).from, to: doc.line(end).to,
      insert: sortedLines.slice(start, end).join('\n')}];
  });
  return {changes, mapPosition};
}

type TaskEdit = {position: number; marker: string};
type ChecklistEdit = {markerChange?: Replacement; reorder?: ChecklistReorder};

// The editor has already applied its input to doc. Validate the affected task
// and plan any marker correction before reordering that task's siblings.
export function planChecklistEdit(doc: Text, edit?: TaskEdit): ChecklistEdit | undefined {
  const {lines, items} = itemsIn(doc.toString());
  if (!edit) return {reorder: reorderChecklists(doc, lines, checklistGroups(items))};

  const {position, marker} = edit;
  const line = doc.lineAt(position);
  const task = items.find(item => item.start === line.number - 1 && line.from + item.markerOffset === position);
  const state = taskState(marker);
  if (!task || !state) return;
  const group = checklistGroups(items).find(siblings => siblings.includes(task))!;

  let markerChange: Replacement | undefined;
  const offset = task.markerOffset;
  if (line.text[offset] !== marker) {
    markerChange = {from: position, to: position + 1, insert: marker};
    // The marker is one character, so the original document positions still
    // apply to the corrected lines and to the editor's selection.
    lines[task.start] = line.text.slice(0, offset) + marker + line.text.slice(offset + 1);
    task.state = state;
  }
  return {markerChange, reorder: reorderChecklists(doc, lines, [group], task)};
}

export type TaskSection = {from: number; to: number; indent: number; count: number; kind: TaskState};

export function checklistSections(doc: Text): TaskSection[] {
  const {items} = itemsIn(doc.toString());
  const sections: TaskSection[] = [];
  for (const siblings of checklistGroups(items)) {
    for (let start = 0; start < siblings.length;) {
      const first = siblings[start];
      let end = start + 1;
      while (siblings[end]?.state === first.state) end++;
      sections.push({from: doc.line(first.start + 1).from,
        to: doc.line(siblings[end - 1].end).to, indent: first.indent, count: end - start, kind: first.state});
      start = end;
    }
  }
  return sections.sort((a, b) => a.from - b.from);
}
