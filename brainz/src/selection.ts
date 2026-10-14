import { NoteBlockModel, ShapeElementModel, ConnectorElementModel, type EdgelessRootService, type EdgelessElementToolbarWidget } from '@blocksuite/blocks';
import type { EdgelessEditor } from '@blocksuite/presets';
import { html } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import type { CanvasCommand } from './commands';
import { icon } from './shell';

export function installSelectionActions(editor:EdgelessEditor, service:EdgelessRootService, commands:()=>CanvasCommand[]) {
  const toolbar=editor.querySelector<EdgelessElementToolbarWidget>('edgeless-element-toolbar-widget');
  if(!toolbar)throw new Error('Canvas selection toolbar is unavailable.');
  // Upstream linked documents live in a separate collection that Brainz does
  // not persist. Keep file navigation in the native document system.
  toolbar.moreGroups=toolbar.moreGroups.map(group=>({...group,items:group.items.filter(item=>!['create-linked-doc','convert-to-linked-doc'].includes(item.type))})).filter(group=>group.items.length);
  toolbar.moreGroups.unshift({type:'brainz-selection',items:commands().map(command=>({type:command.id,label:command.label,icon:html`${unsafeSVG(icon(command.id==='open-object'?'arrow':'link'))}`,when:()=>command.when?.()??true,action:()=>command.run()}))});
  toolbar.registerEntry({when:elements=>elements.length>1,render:()=>html`
    <label class="brainz-selection-filter">Filter
      <select aria-label="Filter selected objects" @change=${(event:Event)=>{
        const value=(event.target as HTMLSelectElement).value;
        const elements=service.selection.selectedElements.filter(element=>value==='all' || (value==='sticky' && element instanceof NoteBlockModel) || (value==='shape' && element instanceof ShapeElementModel) || (value==='connector' && element instanceof ConnectorElementModel));
        service.selection.set({elements:elements.map(element=>element.id),editing:false});
      }}>
        <option value="all">${service.selection.selectedIds.length} objects</option><option value="sticky">Stickies</option><option value="shape">Shapes</option><option value="connector">Connectors</option>
      </select>
    </label>`});
  const style=document.createElement('style');style.textContent=`
    editor-toolbar { border-radius:12px!important; font-family:'Brainz Canvas',Gellix,sans-serif; }
    .brainz-selection-filter { display:flex; align-items:center; gap:6px; padding:0 8px; font:12px 'Brainz Canvas',sans-serif; color:#b5b4a9; }
    .brainz-selection-filter select { font:inherit; color:#e5e3da; border:1px solid #4a483a; border-radius:6px; background:#282823; padding:6px; max-width:120px; }
  `;
  (toolbar.shadowRoot??toolbar).append(style);
  toolbar.requestUpdate();
}

export function installStickySizing(editor:EdgelessEditor, service:EdgelessRootService) {
  const metadata=editor.doc.spaceDoc.getMap<Record<string,unknown>>('brainz:meta');
  const toolbar=editor.querySelector<EdgelessElementToolbarWidget>('edgeless-element-toolbar-widget')!;
  const selectedNotes=()=>service.selection.selectedElements.filter((element):element is NoteBlockModel=>element instanceof NoteBlockModel);
  toolbar.registerEntry({when:elements=>elements.length>0 && elements.every(element=>element instanceof NoteBlockModel),render:()=>{
    const notes=selectedNotes();const first=metadata.get(notes[0]?.id);
    const current=first?.fontAuto===false?String(first.fontSize??20):'auto';
    return html`<label class="brainz-selection-filter">Text
      <select aria-label="Sticky text size" .value=${current} @change=${(event:Event)=>{
        const value=(event.target as HTMLSelectElement).value;
        editor.doc.captureSync();
        editor.doc.spaceDoc.transact(()=>{for(const note of selectedNotes())metadata.set(note.id,{...metadata.get(note.id),fontAuto:value==='auto',fontSize:value==='auto'?undefined:Number(value)});},editor.doc.rootDoc.clientID);
        editor.doc.captureSync();toolbar.requestUpdate();schedule();
      }}><option value="auto">Auto</option><option value="14">Small</option><option value="20">Medium</option><option value="28">Large</option></select>
    </label>`;
  }});
  let frame=0;
  const observed=new WeakSet<Element>();
  const measured=new WeakMap<Element,string>();
  const resize=new ResizeObserver(()=>schedule());
  const schedule=()=>{if(!frame)frame=requestAnimationFrame(measure);};
  const measure=()=>{
    frame=0;
    for(const note of editor.querySelectorAll('affine-edgeless-note')) {
      const model=note.model;
      if(!model || !model.edgeless.collapse)continue;
      const content=note.querySelector<HTMLElement>('.edgeless-note-page-content');
      const text=content?.querySelector<HTMLElement>('.affine-note-block-container');
      if(!content || !text)continue;
      if(!observed.has(note)){observed.add(note);resize.observe(note);resize.observe(text);}
      const choice=metadata.get(model.id);
      const signature=JSON.stringify([content.clientWidth,content.clientHeight,text.textContent,choice?.fontAuto,choice?.fontSize]);
      if(measured.get(note)===signature)continue;
      measured.set(note,signature);
      note.dataset.brainzSized='true';
      let size=choice?.fontAuto===false?Math.max(10,Math.min(28,Number(choice.fontSize)||20)):28;
      const apply=()=>note.style.setProperty('--brainz-sticky-font-size',`${size}px`);
      apply();
      if(choice?.fontAuto!==false)while(size>10 && (text.offsetHeight>content.clientHeight+1 || text.scrollWidth>content.clientWidth+1)){size-=2;apply();}
    }
  };
  editor.doc.spaceDoc.on('afterTransaction',schedule);
  new MutationObserver(schedule).observe(editor,{childList:true,subtree:true,characterData:true});
  schedule();
}
