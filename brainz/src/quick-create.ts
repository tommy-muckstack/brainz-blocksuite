import { ConnectorMode, NoteBlockModel, ShapeElementModel, TextElementModel, getShapeRadius, getShapeType, FontFamily, type ShapeName, type ConnectorElementModel, type EdgelessRootService } from '@blocksuite/blocks';
import type { EdgelessEditor } from '@blocksuite/presets';
import type { Bound, IVec } from '@blocksuite/global/utils';
import { Text } from '@blocksuite/store';
import * as Y from 'yjs';
import { editNote, editShape } from './interactions';

declare global { var __brainzSuppressSnap:boolean|undefined; }
type Creation={source:ShapeElementModel|NoteBlockModel;bound:Bound;startPosition:IVec;endPosition:IVec;targetType?:ShapeName|'note'|'text'|'frame';connector?:ConnectorElementModel};

export function installQuickCreate(editor:EdgelessEditor,service:EdgelessRootService) {
  const modifiers=(event:KeyboardEvent|PointerEvent)=>{globalThis.__brainzSuppressSnap=event.metaKey || event.ctrlKey;};
  window.addEventListener('keydown',modifiers,true);window.addEventListener('keyup',modifiers,true);window.addEventListener('pointermove',modifiers,true);
  window.addEventListener('blur',()=>{globalThis.__brainzSuppressSnap=false;});
  editor.addEventListener('brainz-quick-create',event=>{
    const {source,bound,startPosition,endPosition,targetType,connector}=(event as CustomEvent<Creation>).detail;
    if(source.isLocked() || editor.doc.readonly)return;
    editor.doc.captureSync();
    const kind=targetType??(source instanceof NoteBlockModel?'note':'same');
    let id:string;
    if(kind==='note') {
      id=service.addBlock('affine:note',{xywh:bound.serialize(),...(source instanceof NoteBlockModel?{background:source.background,edgeless:source.edgeless}:{} )},editor.doc.root!.id);
      editor.doc.addBlock('affine:paragraph',{type:'text',text:new Text()},id);
      const note=service.getElementById(id);
      if(note instanceof NoteBlockModel)editor.doc.updateBlock(note,()=>{note.edgeless.collapse=true;note.edgeless.collapsedHeight=bound.h;});
    } else if(kind==='frame') {
      id=service.addBlock('affine:frame',{xywh:bound.serialize(),title:new Text(`Frame ${service.frames.length+1}`),presentationIndex:service.frame.generatePresentationIndex()},service.surface.id);
    } else if(kind==='text') {
      id=service.addElement('text',{xywh:bound.serialize(),text:new Y.Text(),fontFamily:FontFamily.Inter,fontSize:24,color:{normal:'#e5e3da'}});
    } else {
      const shape=source instanceof ShapeElementModel?source.serialize():{};
      id=service.addElement('shape',{...shape,...(kind==='same'?{}:{shapeType:getShapeType(kind),radius:getShapeRadius(kind)}),xywh:bound.serialize(),text:new Y.Text(),fontFamily:FontFamily.Inter});
    }
    const element=service.getElementById(id);
    if(!element)return;
    if(connector)service.updateElement(connector.id,{target:{id,position:endPosition},mode:ConnectorMode.Orthogonal});
    else service.addElement('connector',{source:{id:source.id,position:startPosition},target:{id,position:endPosition},mode:ConnectorMode.Orthogonal,stroke:{normal:'#a8b59a'},strokeWidth:2});
    service.gfx.tool.setTool('default');service.selection.set({elements:[id],editing:false});
    editor.doc.captureSync();
    if(element instanceof NoteBlockModel)editNote(editor.std,element);
    else if(element instanceof ShapeElementModel)editShape(editor,element);
    else if(element instanceof TextElementModel) {
      const root=editor.querySelector('affine-edgeless-root');
      if(root) {
        const input=document.createElement('edgeless-text-editor') as HTMLElement & {element:TextElementModel;edgeless:typeof root;updateComplete:Promise<unknown>;inlineEditor?:{focusIndex:(index:number)=>void}};
        editor.std.selection.setGroup('note',[]);input.contentEditable='false';
        input.element=element;input.edgeless=root;root.append(input);service.selection.set({elements:[id],editing:true});
        void input.updateComplete.then(()=>input.inlineEditor?.focusIndex(0)).catch(console.error);
      }
    }
  });
}
