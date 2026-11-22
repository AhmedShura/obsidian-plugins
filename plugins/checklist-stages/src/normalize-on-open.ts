import {isolateHistory} from '@codemirror/commands';
import {ViewPlugin, type EditorView, type ViewUpdate} from '@codemirror/view';
import {normalizeChecklists} from './sort';

export function normalizeOnOpen(editingFile: (view: EditorView) => object | null) {
  return ViewPlugin.fromClass(class {
    private file: object | null = null;
    private pending: ReturnType<typeof setTimeout> | undefined;

    constructor(private view: EditorView) {
      this.checkFile();
    }

    update(_update: ViewUpdate) {
      this.checkFile();
    }

    private checkFile() {
      const file = editingFile(this.view);
      if (file === this.file) return;
      this.file = file;
      clearTimeout(this.pending);
      if (!file) return;

      // Let Obsidian finish setting the editor's document before dispatching.
      this.pending = setTimeout(() => {
        if (editingFile(this.view) !== file || this.view.state.readOnly) return;
        const change = normalizeChecklists(this.view.state);
        if (change) this.view.dispatch({...change, annotations: isolateHistory.of('full')});
      }, 0);
    }

    destroy() {
      clearTimeout(this.pending);
    }
  });
}
