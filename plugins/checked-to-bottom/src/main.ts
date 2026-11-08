import {Plugin} from 'obsidian';
import {checkedToBottom} from './sort';
import {completedSections} from './sections';
export default class CheckedToBottom extends Plugin {
  onload() { this.registerEditorExtension([checkedToBottom, completedSections]); }
}
