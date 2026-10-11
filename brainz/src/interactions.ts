import { DefaultTool, NoteTool, addNoteAtPoint } from '@blocksuite/blocks';
import type { BlockStdScope, PointerEventState } from '@blocksuite/block-std';
import { GfxControllerIdentifier } from '@blocksuite/block-std/gfx';
import { NoteBlockModel } from '@blocksuite/affine-model';
import { Point } from '@blocksuite/global/utils';

export function createNote(std: BlockStdScope, point: Point, width = 280, height = 200) {
  const gfx = std.get(GfxControllerIdentifier);
  std.doc.captureSync();
  const id = addNoteAtPoint(std, point, { width, height });
  std.doc.addBlock('affine:paragraph', { type: 'text' }, id);
  const note = std.doc.getBlockById(id);
  if (note instanceof NoteBlockModel) {
    std.doc.updateBlock(note, () => {
      note.edgeless.collapse = true;
      note.edgeless.collapsedHeight = height;
    });
  }
  gfx.tool.setTool('default');
  gfx.selection.set({ elements: [id], editing: false });
}

export class CanvasNoteTool extends NoteTool {
  override click(event: PointerEventState) {
    createNote(this.std, new Point(event.x, event.y));
  }

  override dragEnd() {
    const { startX, startY, endX, endY } = this.controller.draggingArea$.peek();
    const [x, y] = this.gfx.viewport.toViewCoord(Math.min(startX, endX), Math.min(startY, endY));
    createNote(this.std, new Point(x, y), Math.max(280, Math.abs(endX - startX)), Math.max(200, Math.abs(endY - startY)));
  }
}

export class CanvasSelectTool extends DefaultTool {
  override pointerDown(event: PointerEventState) {
    const selection = this.gfx.selection;
    const block = this.textBlockAt(event);
    if (selection.editing && (!block || !selection.has(block.id))) {
      selection.set({ elements: selection.selectedIds, editing: false });
    }
    super.pointerDown(event);
  }

  private textBlockAt(event: PointerEventState) {
    const [x, y] = this.gfx.viewport.toModelCoord(event.x, event.y);
    const element = this.gfx.getElementInGroup(x, y, { ignoreTransparent: true });
    return element && 'flavour' in element &&
      (element.flavour === 'affine:note' || element.flavour === 'affine:edgeless-text')
      ? element : null;
  }

  override click(event: PointerEventState) {
    const block = this.textBlockAt(event);
    const selection = this.gfx.selection;
    if (!this.doc.readonly && block && !block.isLocked() && !event.keys.shift &&
      !(selection.editing && selection.selectedIds.length === 1 && selection.has(block.id))) {
      // BlockSuite treats a second single click as edit. Keep the note's drag mask
      // until an actual double click, including when switching between notes.
      selection.set({ elements: [block.id], editing: false });
      return;
    }
    super.click(event);
  }

  override doubleClick(event: PointerEventState) {
    const block = this.textBlockAt(event);
    if (!this.doc.readonly && block && !block.isLocked()) {
      this.gfx.selection.set({ elements: [block.id], editing: false });
      super.click(event);
      return;
    }
    super.doubleClick(event);
  }
}
