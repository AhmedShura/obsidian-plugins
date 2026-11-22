import {MarkdownView, Plugin, editorInfoField} from 'obsidian';
import {taskStateExtension} from './sort';
import {taskSections} from './sections';
import {normalizeOnOpen} from './normalize-on-open';

export default class ChecklistStages extends Plugin {
  onload() {
    const normalize = normalizeOnOpen(view => {
      const info = view.state.field(editorInfoField, false);
      return info instanceof MarkdownView && info.getMode() === 'source' ? info.file : null;
    });
    this.registerEditorExtension([taskStateExtension, taskSections, normalize]);
  }
}
