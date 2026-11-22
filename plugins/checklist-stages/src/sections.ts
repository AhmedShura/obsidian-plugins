import {StateEffect, StateField, type Range, type Transaction} from '@codemirror/state';
import {Decoration, EditorView, WidgetType, type DecorationSet} from '@codemirror/view';
import {checklistSections, type TaskSection} from './checklist';

const sectionTitle = {'in-progress': 'In progress', 'unchecked': 'New', 'completed': 'Completed'};
export const toggleTaskSection = StateEffect.define<number>();

class SectionHeader extends WidgetType {
  constructor(private section: TaskSection, private collapsed: boolean) { super(); }
  eq(other: SectionHeader) {
    return this.section.from === other.section.from && this.section.to === other.section.to &&
      this.section.count === other.section.count && this.section.indent === other.section.indent &&
      this.section.kind === other.section.kind && this.collapsed === other.collapsed;
  }
  toDOM(view: EditorView) {
    const doc = view.dom.ownerDocument;
    const title = sectionTitle[this.section.kind];
    const wrapper = doc.createElement('div');
    wrapper.className = 'ctb-task-section';
    wrapper.style.paddingInlineStart = `${this.section.indent}ch`;
    const button = wrapper.appendChild(doc.createElement('button'));
    button.type = 'button';
    button.className = 'ctb-task-section-toggle';
    button.setAttribute('aria-expanded', String(!this.collapsed));
    const taskLabel = this.section.count === 1 ? 'task' : 'tasks';
    button.setAttribute('aria-label', `${this.collapsed ? 'Expand' : 'Collapse'} ${this.section.count} ${title.toLowerCase()} ${taskLabel}`);
    const arrow = button.appendChild(doc.createElement('span'));
    arrow.className = 'ctb-task-section-arrow';
    arrow.setAttribute('aria-hidden', 'true');
    arrow.textContent = this.collapsed ? '▸' : '▾';
    const label = button.appendChild(doc.createElement('span'));
    label.textContent = `${title} · ${this.section.count}`;
    const line = button.appendChild(doc.createElement('span'));
    line.className = 'ctb-task-section-line';
    line.setAttribute('aria-hidden', 'true');
    // Preserve the editor selection on pointer clicks. Keyboard activation
    // still uses the native button's Enter/Space behavior.
    button.addEventListener('mousedown', event => event.preventDefault());
    button.addEventListener('click', () => {
      const {from, to} = this.section;
      const inside = view.state.selection.ranges.some(range => range.from < to && range.to > from);
      view.dispatch({effects: toggleTaskSection.of(from),
        ...(!this.collapsed && inside ? {selection: {anchor: from}} : {})});
    });
    return wrapper;
  }
  ignoreEvent() { return true; }
}

type SectionState = {sections: TaskSection[]; collapsed: Set<number>; decorations: DecorationSet};
function decorate(sections: TaskSection[], collapsed: Set<number>): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  let hiddenThrough = -1;
  for (const section of sections) {
    if (section.from < hiddenThrough) continue;
    const closed = collapsed.has(section.from);
    const widget = new SectionHeader(section, closed);
    ranges.push(closed
      ? Decoration.replace({widget, block: true}).range(section.from, section.to)
      : Decoration.widget({widget, block: true, side: -1}).range(section.from));
    if (closed) hiddenThrough = section.to;
  }
  return Decoration.set(ranges, true);
}

function mappedFolds(value: SectionState, sections: TaskSection[], tr: Transaction): Set<number> {
  const collapsed = new Set<number>();
  for (const from of value.collapsed) {
    const section = value.sections.find(s => s.from === from)!;
    let touched = false;
    tr.changes.iterChangedRanges((start, end) => {
      if (start <= section.to && end >= section.from) touched = true;
    });
    if (touched) continue;
    const mappedFrom = tr.changes.mapPos(from, 1);
    const mappedTo = tr.changes.mapPos(section.to, -1);
    // A section can gain a task through an edit outside the old folded range.
    // Keep the fold only if it still covers the same group of tasks.
    if (sections.some(s => s.from === mappedFrom && s.to === mappedTo &&
      s.kind === section.kind && s.count === section.count)) collapsed.add(mappedFrom);
  }
  return collapsed;
}

export const taskSections = StateField.define<SectionState>({
  create(state) {
    const sections = checklistSections(state.doc), collapsed = new Set<number>();
    return {sections, collapsed, decorations: decorate(sections, collapsed)};
  },
  update(value, tr) {
    const toggles = tr.effects.filter(effect => effect.is(toggleTaskSection));
    if (!tr.docChanged && !tr.selection && !toggles.length) return value;
    const sections = tr.docChanged ? checklistSections(tr.newDoc) : value.sections;
    const collapsed = tr.docChanged ? mappedFolds(value, sections, tr) : new Set(value.collapsed);
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
