import { DefaultTool, NoteTool, addNoteAtPoint, focusTextModel } from '@blocksuite/blocks';
import type { BlockStdScope, PointerEventState } from '@blocksuite/block-std';
import { GfxControllerIdentifier } from '@blocksuite/block-std/gfx';
import { MindmapElementModel, NoteBlockModel, ShapeElementModel } from '@blocksuite/affine-model';
import type { EdgelessEditor } from '@blocksuite/presets';
import * as Y from 'yjs';
import { Text } from '@blocksuite/store';
import { Point } from '@blocksuite/global/utils';

let pendingTyping: {insert:(character:string)=>void;typed:boolean}|undefined;
const lockedTools = new WeakSet<BlockStdScope>();
export function keepCreationTool(std:BlockStdScope, locked:boolean) {if(locked)lockedTools.add(std);else lockedTools.delete(std);}
window.addEventListener('pointerdown',()=>{pendingTyping=undefined;},true);
window.addEventListener('keydown',event=>{
  if(event.composedPath().some(node=>node instanceof HTMLElement && ['INPUT','TEXTAREA'].includes(node.tagName))){pendingTyping=undefined;return;}
  if (!pendingTyping || event.isComposing || event.metaKey || event.ctrlKey || event.altKey || event.key.length!==1) return;
  event.preventDefault();event.stopImmediatePropagation();pendingTyping.insert(event.key);pendingTyping.typed=true;
},true);

function focusNewNote(std:BlockStdScope, id:string, paragraph:string) {
  const gfx=std.get(GfxControllerIdentifier);
  const block=std.doc.getBlockById(paragraph);
  const pending={typed:false,insert:(character:string)=>{
    if(block && 'text' in block && block.text instanceof Text) block.text.insert(character,block.text.length);
  }};
  pendingTyping=pending;gfx.selection.set({elements:[id],editing:true});
  requestAnimationFrame(()=>{
    if(pendingTyping!==pending)return;
    focusTextModel(std,paragraph,block && 'text' in block ? String(block.text ?? '').length : 0);
    requestAnimationFrame(()=>{
      if(pendingTyping===pending) {focusTextModel(std,paragraph,block && 'text' in block ? String(block.text ?? '').length : 0);pendingTyping=undefined;}
    });
  });
}

export function createNote(std: BlockStdScope, point: Point, width = 280, height = 200, edit = false) {
  const gfx = std.get(GfxControllerIdentifier);
  std.doc.captureSync();
  const id = addNoteAtPoint(std, point, { width, height, offsetX:0, offsetY:0 });
  const paragraph = std.doc.addBlock('affine:paragraph', { type: 'text' }, id);
  const note = std.doc.getBlockById(id);
  if (note instanceof NoteBlockModel) {
    std.doc.updateBlock(note, () => {
      note.edgeless.collapse = true;
      note.edgeless.collapsedHeight = height;
    });
  }
  gfx.tool.setTool('default');
  gfx.selection.set({ elements: [id], editing: false });
  if (edit && !lockedTools.has(std)) focusNewNote(std,id,paragraph);
  return id;
}

export function editShape(editor: EdgelessEditor, shape: ShapeElementModel, initial?: string) {
  const root = editor.querySelector('affine-edgeless-root');
  if (!root?.mountElm || shape.isLocked()) return false;
  if (!shape.text) root.service.updateElement(shape.id,{text:new Y.Text()});
  if (initial) editor.doc.spaceDoc.transact(()=>shape.text!.insert(shape.text!.length,initial));
  const input = document.createElement('edgeless-shape-text-editor') as HTMLElement & {
    element: ShapeElementModel; edgeless: typeof root; mountEditor: (next: ShapeElementModel) => void;
    updateComplete:Promise<boolean>; richText?:{updateComplete:Promise<unknown>;inlineEditor?:{focusEnd:()=>void}};
  };
  input.element=shape; input.edgeless=root; input.mountEditor=(next)=>{editShape(editor,next);};
  root.mountElm.append(input); root.gfx.tool.setTool('default'); root.gfx.selection.set({elements:[shape.id],editing:true});
  const pending={typed:false,insert:(character:string)=>editor.doc.spaceDoc.transact(()=>{
    if (!pending.typed && shape.group instanceof MindmapElementModel) shape.text!.delete(0,shape.text!.length);
    shape.text!.insert(shape.text!.length,character);
  })};pendingTyping=pending;
  void input.updateComplete.then(async()=>{
    await input.richText?.updateComplete;
    if(pendingTyping===pending){if(pending.typed)input.richText?.inlineEditor?.focusEnd();pendingTyping=undefined;}
  }).catch(error=>{if(pendingTyping===pending)pendingTyping=undefined;console.error(error);});
  return true;
}

export function editNote(std: BlockStdScope, note: NoteBlockModel) {
  if(note.isLocked())return;
  const paragraph=note.children.find(child=>'text' in child)?.id ?? std.doc.addBlock('affine:paragraph',{type:'text'},note.id);
  focusNewNote(std,note.id,paragraph);
}

export class CanvasNoteTool extends NoteTool {
  override click(event: PointerEventState) {
    createNote(this.std, new Point(event.x, event.y),280,200,true);
  }

  override dragEnd() {
    const { startX, startY, endX, endY } = this.controller.draggingArea$.peek();
    const [x, y] = this.gfx.viewport.toViewCoord(Math.min(startX, endX), Math.min(startY, endY));
    createNote(this.std, new Point(x, y), Math.max(280, Math.abs(endX - startX)), Math.max(200, Math.abs(endY - startY)),true);
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
      if (block instanceof NoteBlockModel) {editNote(this.std,block);return;}
      this.gfx.selection.set({ elements: [block.id], editing: false });
      super.click(event);
      return;
    }
    super.doubleClick(event);
  }
}
