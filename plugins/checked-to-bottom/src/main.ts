import {MarkdownView, Plugin, editorInfoField} from 'obsidian';
import {checkedToBottom} from './sort';
import {completedSections} from './sections';
import {normalizeOnOpen} from './normalize-on-open';

export default class CheckedToBottom extends Plugin {
  onload() {
    const normalize = normalizeOnOpen(view => {
      const info = view.state.field(editorInfoField, false);
      return info instanceof MarkdownView && info.getMode() === 'source' ? info.file : null;
    });
    this.registerEditorExtension([checkedToBottom, completedSections, normalize]);
  }
}
