import {isolateHistory} from '@codemirror/commands';
import {EditorSelection, EditorState, Transaction, type TransactionSpec} from '@codemirror/state';
import {ViewPlugin, type EditorView} from '@codemirror/view';
import {planChecklistEdit, taskState, type ChecklistReorder} from './checklist';

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

const nextMarker = {'unchecked': '/', 'in-progress': 'x', 'completed': ' '};

function reorderTransaction({changes, mapPosition}: ChecklistReorder, selection: EditorSelection) {
  return {changes, selection: EditorSelection.create(selection.ranges.map(range =>
    range.empty ? EditorSelection.cursor(mapPosition(range.head), range.assoc) :
      EditorSelection.range(mapPosition(range.anchor), mapPosition(range.head))), selection.mainIndex)};
}

export function normalizeChecklists(state: EditorState) {
  const reorder = planChecklistEdit(state.doc)?.reorder;
  if (reorder) return reorderTransaction(reorder, state.selection);
}

export const sortTransactions = EditorState.transactionFilter.of(tr => {
  const fromCheckbox = checkboxInputs.has(tr.startState);
  if (!tr.docChanged || tr.isUserEvent('undo') || tr.isUserEvent('redo') ||
      tr.annotation(Transaction.remote) ||
      (!tr.isUserEvent('input') && !fromCheckbox)) return tr;
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
  const beforeState = taskState(before);
  const afterState = taskState(after);
  if (!beforeState || !afterState || beforeState === afterState) return tr;
  // Keep Obsidian's checkbox input and substitute the next marker in the same
  // transaction. Direct Markdown edits keep the marker the user entered.
  const marker = fromCheckbox ? nextMarker[beforeState] : after;
  const edit = planChecklistEdit(tr.newDoc, {position, marker});
  if (!edit) return tr;

  const specs: (Transaction | TransactionSpec)[] = [tr];
  if (edit.markerChange) specs.push({changes: edit.markerChange, sequential: true});
  if (fromCheckbox) specs.push({annotations: isolateHistory.of('full')});
  if (edit.reorder) specs.push({...reorderTransaction(edit.reorder, tr.newSelection), sequential: true});
  return specs.length > 1 ? specs : tr;
});

export const taskStateExtension = [checkboxInput, sortTransactions];
