import { Array as YArray, Map as YMap, Text as YText } from 'yjs';
/** Insert a new, unexecuted cell through the shared Notebook schema. */
export function insertNotebookCell(notebook, index, cell) {
    const cells = notebook.ydoc.getArray('cells');
    if (!Number.isSafeInteger(index) || index < 0 || index > cells.length) {
        throw new RangeError('Notebook cell insertion index is out of range');
    }
    const model = new YMap([
        ['id', cell.id],
        ['cell_type', cell.cell_type],
        ['source', new YText(cell.source)],
        ['metadata', new YMap()],
        ...(cell.cell_type === 'code'
            ? [
                ['outputs', new YArray()],
                ['execution_count', null],
            ]
            : []),
    ]);
    // @jupyter/ydoc 4.1.1 insertCell constructs a cell model before its Yjs
    // types are attached, then reads them during initialization. Attach the
    // complete cell first; YNotebook's observer creates the official model
    // after integration, preserving collaboration, signals and undo tracking.
    notebook.transact(() => cells.insert(index, [model]));
    notebook.dirty = true;
}
