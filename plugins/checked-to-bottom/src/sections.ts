import {StateEffect, StateField, type EditorState, type Range, type Transaction} from '@codemirror/state';
import {Decoration, EditorView, WidgetType, type DecorationSet} from '@codemirror/view';
import {itemsIn} from './sort';

export type CompletedSection = {from: number; to: number; indent: number; count: number};
export const toggleCompleted = StateEffect.define<number>();

function sectionsIn(state: EditorState): CompletedSection[] {
  const {items} = itemsIn(state.doc.toString());
  const sections: CompletedSection[] = [];
  // Only consecutive completed siblings share a section. Unchecked siblings
  // in an existing, unsorted note can never accidentally be folded away.
  for (const item of items) {
    if (!item.done) continue;
    const previous = items.find(other => other.end === item.start && other.indent === item.indent);
    if (previous?.done) continue;
    let last = item, count = 1;
    while (true) {
      const next = items.find(other => other.start === last.end && other.indent === item.indent);
      if (!next?.done) break;
      last = next;
      count++;
    }
    sections.push({from: state.doc.line(item.start + 1).from,
      to: state.doc.line(last.end).to, indent: item.indent, count});
  }
  return sections;
}

class CompletedHeader extends WidgetType {
  constructor(private section: CompletedSection, private collapsed: boolean) { super(); }
  eq(other: CompletedHeader) {
    return this.section.from === other.section.from && this.section.to === other.section.to &&
      this.section.count === other.section.count && this.section.indent === other.section.indent &&
      this.collapsed === other.collapsed;
  }
  toDOM(view: EditorView) {
    const doc = view.dom.ownerDocument;
    const wrapper = doc.createElement('div');
    wrapper.className = 'ctb-completed';
    wrapper.style.paddingInlineStart = `${this.section.indent}ch`;
    const button = wrapper.appendChild(doc.createElement('button'));
    button.type = 'button';
    button.className = 'ctb-completed-toggle';
    button.setAttribute('aria-expanded', String(!this.collapsed));
    button.setAttribute('aria-label', `${this.collapsed ? 'Expand' : 'Collapse'} ${this.section.count} completed tasks`);
    const arrow = button.appendChild(doc.createElement('span'));
    arrow.className = 'ctb-completed-arrow';
    arrow.setAttribute('aria-hidden', 'true');
    arrow.textContent = this.collapsed ? '▸' : '▾';
    const label = button.appendChild(doc.createElement('span'));
    label.textContent = `Completed · ${this.section.count}`;
    const line = button.appendChild(doc.createElement('span'));
    line.className = 'ctb-completed-line';
    line.setAttribute('aria-hidden', 'true');
    // Preserve the editor selection on pointer clicks. Keyboard activation
    // still uses the native button's Enter/Space behavior.
    button.addEventListener('mousedown', event => event.preventDefault());
    button.addEventListener('click', () => {
      const {from, to} = this.section;
      const inside = view.state.selection.ranges.some(range => range.from < to && range.to > from);
      view.dispatch({effects: toggleCompleted.of(from),
        ...(!this.collapsed && inside ? {selection: {anchor: from}} : {})});
    });
    return wrapper;
  }
  ignoreEvent() { return true; }
}

type SectionState = {sections: CompletedSection[]; collapsed: Set<number>; decorations: DecorationSet};
function decorate(sections: CompletedSection[], collapsed: Set<number>): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  let hiddenThrough = -1;
  for (const section of sections) {
    if (section.from < hiddenThrough) continue;
    const closed = collapsed.has(section.from);
    const widget = new CompletedHeader(section, closed);
    ranges.push(closed
      ? Decoration.replace({widget, block: true}).range(section.from, section.to)
      : Decoration.widget({widget, block: true, side: -1}).range(section.from));
    if (closed) hiddenThrough = section.to;
  }
  return Decoration.set(ranges, true);
}

function mappedFolds(value: SectionState, tr: Transaction): Set<number> {
  const collapsed = new Set<number>();
  for (const from of value.collapsed) {
    const section = value.sections.find(s => s.from === from)!;
    let touched = false;
    tr.changes.iterChangedRanges((start, end) => {
      if (start <= section.to && end >= section.from) touched = true;
    });
    // Reopen edited regions rather than hide a changed task or transfer a fold
    // to unrelated content. Unaffected folds track edits elsewhere in the note.
    if (!touched) collapsed.add(tr.changes.mapPos(from, 1));
  }
  return collapsed;
}

export const completedSectionState = StateField.define<SectionState>({
  create(state) {
    const sections = sectionsIn(state), collapsed = new Set<number>();
    return {sections, collapsed, decorations: decorate(sections, collapsed)};
  },
  update(value, tr) {
    const toggles = tr.effects.filter(effect => effect.is(toggleCompleted));
    if (!tr.docChanged && !tr.selection && !toggles.length) return value;
    const sections = tr.docChanged ? sectionsIn(tr.state) : value.sections;
    const collapsed = tr.docChanged ? mappedFolds(value, tr) : new Set(value.collapsed);
    for (const from of collapsed) if (!sections.some(s => s.from === from)) collapsed.delete(from);
    for (const effect of toggles) {
      const from = effect.value;
      if (sections.some(s => s.from === from)) {
        if (collapsed.has(from)) collapsed.delete(from);
        else collapsed.add(from);
      }
    }
    // Search, navigation, and explicit selections reveal the target for editing.
    if (tr.selection && !toggles.length) {
      for (const section of sections) {
        if (tr.newSelection.ranges.some(range => range.from < section.to && range.to > section.from)) collapsed.delete(section.from);
      }
    }
    return {sections, collapsed, decorations: decorate(sections, collapsed)};
  },
  provide: field => [EditorView.decorations.from(field, value => value.decorations),
    EditorView.atomicRanges.of(view => view.state.field(field).decorations)]
});

export const completedSections = completedSectionState;
