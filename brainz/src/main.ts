import { effects as presetEffects } from '@blocksuite/presets/effects';
import { effects as blockEffects } from '@blocksuite/blocks/effects';
import { EdgelessEditor } from '@blocksuite/presets';
import { AffineSchemas, EdgelessRootService, EditPropsStore, ShapeType, ShapeStyle, ConnectorMode, ThemeProvider, addNote as createStickyNote } from '@blocksuite/blocks';
import { DocCollection, Schema, Text } from '@blocksuite/store';
import { Point } from '@blocksuite/global/utils';
import { ToolController } from '@blocksuite/block-std/gfx';
import { ColorScheme, NoteShadow, StrokeStyle } from '@blocksuite/affine-model';
import { combinedDarkCssVariables } from '@toeverything/theme';
import * as Y from 'yjs';
import { base64ToBytes, boardLink, bytesToBase64, supportedLink, type BoardDocument, type BoardTarget, type LinkReference } from './model';
import './style.css';
import { installCapture } from './capture';

declare global {
  interface Window { ipc?: { postMessage(message: string): void }; __brainzBoard?: unknown }
}
blockEffects();
presetEffects();
const native = Boolean(window.ipc);
const app = document.querySelector<HTMLDivElement>('#app')!;
const paths: Record<string, string> = {
  canvas: 'M12 16V21M12 16L18 21M12 16L6 21M21 3V11.2C21 12.8802 21 13.7202 20.673 14.362C20.3854 14.9265 19.9265 15.3854 19.362 15.673C18.7202 16 17.8802 16 16.2 16H7.8C6.11984 16 5.27976 16 4.63803 15.673C4.07354 15.3854 3.6146 14.9265 3.32698 14.362C3 13.7202 3 12.8802 3 11.2V3M8 9V12M12 7V12M16 11V12M22 3H2',
  capture: 'M8 3H4a1 1 0 0 0-1 1v4M16 3h4a1 1 0 0 1 1 1v4M3 16v4a1 1 0 0 0 1 1h4M21 16v4a1 1 0 0 1-1 1h-4M8 8h8v8H8Z',
  pointer: 'M5 3L19 12L12 13L9 20Z',
  hand: 'M8 12V6a2 2 0 0 1 4 0v5V4a2 2 0 0 1 4 0v7V7a2 2 0 0 1 4 0v7c0 5-3 7-7 7-3 0-5-2-7-5l-3-4a2 2 0 0 1 3-2l2 2',
  box: 'M6 4h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z',
  note: 'M14 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v9l-7 7ZM14 21v-5a2 2 0 0 1 2-2h5',
  connector: 'M4 18V8a2 2 0 0 1 2-2h14M16 2l4 4-4 4M2 18h4v4H2Z',
  text: 'M4 5V3h16v2M12 3v18M8 21h8',
  pen: 'M4 20l4-1L20 7a2 2 0 0 0-3-3L5 16l-1 4ZM14 7l3 3',
  link: 'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6ZM14 2v6h6M8 13h8M8 17h5',
  undo: 'M3 9h12a6 6 0 0 1 0 12M3 9l5-5M3 9l5 5',
  redo: 'M21 9H9a6 6 0 0 0 0 12M21 9l-5-5M21 9l-5 5',
  fit: 'M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5M8 8h8v8H8Z',
  plus: 'M12 5v14M5 12h14', minus: 'M5 12h14',
  arrow: 'M7 17L17 7M7 7h10v10', close: 'M6 6l12 12M18 6L6 18',
};
const icon = (name: string) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name]}"/></svg>`;
const tool = (name: string, label: string, shortcut: string) => `<button class="tool" data-tool="${name}" aria-label="${label}" aria-pressed="false" title="${label} (${shortcut})">${icon(name)}<span class="tooltip">${label}<kbd>${shortcut}</kbd></span></button>`;
app.innerHTML = `
<header class="topbar"><div class="board-name">${icon('canvas')}<input id="title" aria-label="Board name" value="Untitled canvas" maxlength="120"><span class="save-state" id="save-state" role="status"><i></i>Opening…</span></div><div class="header-actions"><button id="add-file" class="text-button">${icon('file')}Add file</button><button id="copy-view" class="text-button share">${icon('link')}Copy view link</button></div></header>
<main id="canvas" aria-label="Infinite whiteboard"></main>
<div class="empty-state" id="empty"><div class="empty-symbol">${icon('canvas')}</div><h1>A little room to think.</h1><p>Map an idea. Connect the dots.<br>Bring your notes into the picture.</p><button id="first-note" class="primary">${icon('plus')}Add your first note</button><span>or drop a file anywhere</span></div>
<nav class="tools" aria-label="Drawing tools">${tool('pointer','Select','V')}${tool('hand','Pan','H')}<div class="rule"></div>${tool('note','Sticky note','N')}${tool('box','Box','R')}${tool('connector','Connector','C')}${tool('text','Text','T')}${tool('pen','Draw','P')}<div class="rule"></div><button id="add-link" class="tool" aria-label="Add link" title="Add a Brainz, My Man, or web link">${icon('link')}</button><div class="rule"></div><button id="capture" class="tool" aria-label="Capture area" aria-pressed="false" title="Drag an area to copy as an image">${icon('capture')}<span class="tooltip">Capture area</span></button></nav>
<div class="selection-bar" id="selection" hidden><span id="selection-title"></span><button id="open-object" class="text-button" hidden>${icon('arrow')}Open</button><button id="copy-object" class="text-button">${icon('link')}Copy object link</button></div>
<div class="bottom-left"><div class="history"><button id="undo" aria-label="Undo" title="Undo (⌘Z)">${icon('undo')}</button><button id="redo" aria-label="Redo" title="Redo (⇧⌘Z)">${icon('redo')}</button></div><span class="hint">Space + drag to pan<span>·</span>Pinch to zoom</span></div>
<div class="zoom-controls"><button id="zoom-out" aria-label="Zoom out">${icon('minus')}</button><button id="zoom-reset" aria-label="Reset zoom"><span id="zoom">100%</span></button><button id="zoom-in" aria-label="Zoom in">${icon('plus')}</button><span></span><button id="fit" aria-label="Fit to content" title="Fit to content (⇧1)">${icon('fit')}</button></div>
<div id="toast" role="status" hidden></div>
<dialog id="link-dialog"><form id="link-form"><div class="dialog-title"><h2>Add a link</h2><button type="button" id="cancel-link" aria-label="Close">${icon('close')}</button></div><p>Connect something from Brainz, My Man, or the web.</p><label>Link<input id="link-url" type="text" placeholder="brainz://… or https://…" required autocomplete="off"></label><label>Label<input id="link-title" type="text" placeholder="Give it a name" maxlength="160"></label><div id="link-error" role="alert"></div><button class="primary" type="submit">Add to canvas</button></form></dialog>`;
for (const [property, value] of Object.entries(combinedDarkCssVariables)) document.documentElement.style.setProperty(property, String(value));
const themeOverrides: Record<string,string> = {'--affine-font-family':'-apple-system, BlinkMacSystemFont, sans-serif','--affine-background-primary-color':'#141413','--affine-background-secondary-color':'#22221f','--affine-background-overlay-panel-color':'#282823','--affine-text-primary-color':'#e5e3da','--affine-text-secondary-color':'#99988e','--affine-primary-color':'#e2c76b','--affine-border-color':'#3b3b34','--affine-hover-color':'#d8c87a26','--affine-tooltip':'#2e2e28'};
for (const [key, value] of Object.entries(themeOverrides)) document.documentElement.style.setProperty(key,value);
const get = <T extends HTMLElement = HTMLElement>(id:string) => document.getElementById(id) as T;
const title = get<HTMLInputElement>('title');
const saveState = get('save-state');
const dialog = get<HTMLDialogElement>('link-dialog');
let editor: EdgelessEditor;
let collection: DocCollection;
let service: EdgelessRootService;
let target: BoardTarget = { path: '/preview/Whiteboard.brainzboard' };
let links: Y.Map<LinkReference>;
let revision = 0;
let savedRevision = 0;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let viewportTimer: ReturnType<typeof setTimeout> | undefined;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let loading = true;

function notice(message: string) {
  const toast = get('toast'); toast.textContent = message; toast.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { toast.hidden = true; }, 3400);
}
function post(message: Record<string,unknown>) {
  if (window.ipc) return window.ipc.postMessage(JSON.stringify(message));
  if (message.type === 'save') {
    try { localStorage.setItem('brainz-whiteboard-preview', JSON.stringify(message.document)); receive({type:'saved',revision:message.revision}); }
    catch { receive({type:'saveError',message:'Could not save this board. Free up storage and try again.'}); }
  } else if (message.type === 'copyImage') {
    const blob = new Blob([base64ToBytes(String(message.png))],{type:'image/png'});
    navigator.clipboard.write([new ClipboardItem({'image/png':blob})]).then(()=>notice('Canvas copied to clipboard')).catch(()=>notice('Clipboard access was denied.'));
  } else if (message.type === 'copy') navigator.clipboard.writeText(String(message.text)).then(() => notice('Link copied')).catch(() => notice('Clipboard is unavailable'));
  else if (message.type === 'open') {
    if (supportedLink(String(message.url))) window.open(String(message.url),'_blank','noopener,noreferrer');
  } else if (message.type === 'pickFiles') notice('Drop files into the Brainz app to keep links to their original location.');
}
function viewport(): [number,number,number] { return [service.viewport.centerX, service.viewport.centerY, service.viewport.zoom]; }
function snapshot(): BoardDocument {
  return { format:'brainz-whiteboard',version:1,title:title.value.trim() || 'Untitled canvas',data:bytesToBase64(Y.encodeStateAsUpdate(editor.doc.spaceDoc)),viewport:viewport() };
}
function save() {
  clearTimeout(saveTimer); saveTimer = undefined;
  if (loading || !service) return;
  revision++;
  saveState.className = 'save-state saving'; saveState.innerHTML = '<i></i>Saving…';
  post({type:'save', revision, document:snapshot()});
}
function changed() {
  if (loading) return;
  saveState.className = 'save-state saving'; saveState.innerHTML = '<i></i>Saving…';
  if (!saveTimer) saveTimer = setTimeout(save, 180);
  updateEmpty();
}
function updateEmpty() { if (service) get('empty').hidden = service.edgelessElements.length > 0; }
function selectTool(name: string) {
  if (!service) return;
  const controller = editor.std.get(ToolController);
  switch (name) {
    case 'pointer': controller.setTool('default'); break;
    case 'hand': controller.setTool('pan',{panning:false}); break;
    case 'box': controller.setTool('shape',{shapeName:'roundedRect'}); break;
    case 'note': controller.setTool('affine:note',{childFlavour:'affine:paragraph',childType:'text',tip:'Write something…'}); break;
    case 'connector': controller.setTool('connector',{mode:ConnectorMode.Orthogonal}); break;
    case 'text': controller.setTool('text'); break;
    case 'pen': controller.setTool('brush'); break;
  }
}
function addNote() {
  const [x,y] = service.viewport.toViewCoord(service.viewport.centerX-110,service.viewport.centerY-60);
  createStickyNote(editor.std,new Point(x,y),{childFlavour:'affine:paragraph',childType:'text',collapse:true},280,200);
  updateEmpty();
}
function addLink(reference: LinkReference, position?: [number,number]) {
  if (!supportedLink(reference.url)) { notice('Use a Brainz, My Man, file, or web link.'); return; }
  const [x,y] = position ?? [service.viewport.centerX-140,service.viewport.centerY-50];
  const url = new URL(reference.url);
  const kind = url.protocol === 'file:' ? 'Brainz · Open file' : url.protocol === 'brainz:' ? 'Brainz · Open' : url.protocol === 'myman:' ? 'My Man · Open' : url.hostname || 'Link';
  const id = service.surface.addElement({type:'shape',index:service.generateIndex(),shapeType:ShapeType.Rect,shapeStyle:ShapeStyle.General,xywh:JSON.stringify([x,y,280,108]),radius:.08,filled:true,fillColor:'#272923',strokeColor:'#555849',strokeWidth:1.5,color:'#e7e5dc',fontSize:16,fontFamily:'Inter',text:new Y.Text(`↗ ${reference.title}\n${kind}`)});
  links.set(id,reference);
  service.selection.set({elements:[id],editing:false});
  selectTool('pointer'); save(); updateEmpty(); return id;
}
function updateSelection() {
  const ids = service.selection.selectedIds;
  get('selection').hidden = ids.length === 0 || service.selection.editing;
  const reference = ids.length === 1 ? links.get(ids[0]) : undefined;
  get('selection-title').textContent = reference?.title || `${ids.length} ${ids.length === 1 ? 'object' : 'objects'} selected`;
  get('open-object').hidden = !reference;
  get<HTMLButtonElement>('copy-object').disabled = ids.length !== 1;
}
function focusTarget(next: BoardTarget) {
  if (!service) return;
  if (next.object) {
    const element = service.gfx.getElementById(next.object);
    if (element && 'elementBound' in element) {
      service.selection.set({elements:[next.object],editing:false});
      const bound = element.elementBound;
      service.viewport.setViewportByBound(bound, [120,160,120,160], true);
      updateSelection(); return;
    }
    notice('This object is no longer on the board.');
  }
  if (next.viewport?.every(Number.isFinite)) service.viewport.setViewport(next.viewport[2],[next.viewport[0],next.viewport[1]],true);
}
async function load(document: BoardDocument | null, next: BoardTarget) {
  if (editor) return;

  target = next;
  collection = new DocCollection({id:'brainz-whiteboard',schema:new Schema().register(AffineSchemas)});
  collection.meta.initialize();
  const doc = collection.createDoc({id:'canvas'});
  doc.load();
  {
    if (document) {
      if (document.format !== 'brainz-whiteboard' || document.version !== 1) throw new Error('Unsupported whiteboard file');
      Y.applyUpdate(doc.spaceDoc,base64ToBytes(document.data));
    }
    if (!doc.root) {
       const page = doc.addBlock('affine:page',{title:new Text('Whiteboard')});
       doc.addBlock('affine:surface',{},page);
    }
  }
   editor = new EdgelessEditor(); editor.doc = doc;
  get('canvas').append(editor);
  await editor.updateComplete;
  service = editor.std.get(EdgelessRootService);
  editor.std.get(ThemeProvider).app$.value = ColorScheme.Dark;
  editor.std.get(ThemeProvider).edgeless$.value = ColorScheme.Dark;
  const defaults = editor.std.get(EditPropsStore);
  defaults.recordLastProps('shape:roundedRect',{fillColor:{normal:'#292c28'},strokeColor:{normal:'#a6b995'},strokeWidth:2,color:{normal:'#e5e3da'},radius:.1,shapeStyle:ShapeStyle.General,fontSize:18});
  defaults.recordLastProps('affine:note',{background:{normal:'#e6ca78'},edgeless:{style:{borderRadius:12,borderSize:0,borderStyle:StrokeStyle.None,shadowType:NoteShadow.Box}}});
  defaults.recordLastProps('connector',{stroke:{normal:'#a8b59a'},strokeWidth:2});
  title.value = document?.title || 'Untitled canvas';
  links = doc.spaceDoc.getMap<LinkReference>('brainz:links');
  const controller = editor.std.get(ToolController);
  controller.currentToolName$.subscribe(name => {
    const mapped:Record<string,string> = {'default':'pointer','pan':'hand','shape':'box','affine:note':'note','connector':'connector','text':'text','brush':'pen'};
    documentButtons().forEach(button => button.setAttribute('aria-pressed',String(button.dataset.tool === mapped[String(name)])));
  });
  doc.resetHistory();
  service.selection.slots.updated.on(updateSelection);
  doc.spaceDoc.on('update',changed);
  service.viewport.viewportUpdated.on(({zoom}) => {
    get('zoom').textContent = `${Math.round(zoom*100)}%`;
    if (!loading) { clearTimeout(viewportTimer); viewportTimer = setTimeout(save,400); }
  });
  await new Promise(requestAnimationFrame);
  if (document?.viewport) service.viewport.setViewport(document.viewport[2],[document.viewport[0],document.viewport[1]]);
  else service.viewport.setViewport(1,[0,0]);
  loading = false; selectTool('pointer'); updateEmpty();
  saveState.className = 'save-state'; saveState.innerHTML = '<i></i>Saved locally';
  if (next.object || next.viewport) focusTarget(next);
  if (!document) save();
  editor.addEventListener('dblclick',event => {
    const id = service.selection.selectedIds[0];
    const reference = links.get(id);
    if (reference) { event.preventDefault(); event.stopImmediatePropagation(); post({type:'open',url:reference.url}); }
  },true);
  installCapture(editor,service,png=>post({type:'copyImage',png}),notice);
  if (import.meta.env.DEV) window.__brainzBoard = {editor,service,collection,links,addNote,addLink,snapshot,focusTarget};
}
function documentButtons() { return document.querySelectorAll<HTMLButtonElement>('[data-tool]'); }
async function receive(message: Record<string,unknown>) {
  switch (message.type) {
    case 'load': try { await load(message.document as BoardDocument|null,message.target as BoardTarget); } catch (error) { console.error(error); const text=String(error); notice(text); post({type:'error',message:text}); } break;
    case 'focus': focusTarget(message.target as BoardTarget); break;
    case 'saved': savedRevision = Math.max(savedRevision,Number(message.revision)); if (savedRevision >= revision && !saveTimer) { saveState.className='save-state'; saveState.innerHTML='<i></i>Saved locally'; } break;
    case 'saveError': saveState.className='save-state failed'; saveState.textContent='Not saved · click to retry'; notice(String(message.message)); break;
    case 'notice': notice(String(message.message)); break;
    case 'files': {
      const files = message.files as LinkReference[];
      const point = message.position as [number,number]|null;
      const position: [number,number] = point ? service.viewport.toModelCoordFromClientCoord([point[0],point[1]]) : [service.viewport.centerX-140,service.viewport.centerY-50];
      files.forEach((file,index) => addLink(file,[position[0]+index*30,position[1]+index*130])); break;
    }
  }
}
window.addEventListener('brainz',event => { void receive((event as CustomEvent).detail); });
documentButtons().forEach(button => button.addEventListener('click',() => selectTool(button.dataset.tool!)));
get('first-note').onclick = addNote;
get('undo').onclick = () => { editor?.doc.undo(); updateEmpty(); };
get('redo').onclick = () => { editor?.doc.redo(); updateEmpty(); };
get('zoom-in').onclick = () => service?.viewport.smoothZoom(Math.min(6,service.zoom*1.2));
get('zoom-out').onclick = () => service?.viewport.smoothZoom(Math.max(.1,service.zoom/1.2));
get('zoom-reset').onclick = () => service?.viewport.smoothZoom(1);
get('fit').onclick = () => service?.zoomToFit();
get('copy-view').onclick = () => service && post({type:'copy',text:boardLink(target,viewport())});
get('copy-object').onclick = () => { const id=service.selection.selectedIds[0]; if(id) post({type:'copy',text:boardLink(target,viewport(),id)}); };
get('open-object').onclick = () => { const reference=links.get(service.selection.selectedIds[0]); if(reference) post({type:'open',url:reference.url}); };
get('add-file').onclick = () => post({type:'pickFiles'});
get('add-link').onclick = () => { dialog.showModal(); get<HTMLInputElement>('link-url').focus(); };
get('cancel-link').onclick = () => dialog.close();
get('link-form').onsubmit = event => {
  event.preventDefault(); const value=get<HTMLInputElement>('link-url').value.trim();
  const url=supportedLink(value);
  if (!url) { get('link-error').textContent='Enter a Brainz, My Man, file, or web link.'; return; }
  const label=get<HTMLInputElement>('link-title').value.trim() || decodeURIComponent(url.pathname.split('/').pop() || url.hostname || 'Linked item');
  addLink({title:label,url:url.toString()}); dialog.close(); get<HTMLFormElement>('link-form').reset(); get('link-error').textContent='';
};
title.oninput = changed; title.onblur = save; saveState.onclick = save;
window.addEventListener('pointerup',() => { if(saveTimer) save(); });
window.addEventListener('keyup',() => { if(saveTimer) save(); });
window.addEventListener('pagehide',save);
document.addEventListener('visibilitychange',() => { if(document.hidden) save(); });
window.addEventListener('keydown',event => {
  const editing = event.composedPath().some(node => node instanceof HTMLElement && (node.isContentEditable || ['INPUT','TEXTAREA'].includes(node.tagName)));
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase()==='s') { event.preventDefault(); save(); return; }
  if (editing || dialog.open || event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.shiftKey && event.key==='!') { event.preventDefault(); service?.zoomToFit(); return; }
  const keys:Record<string,string>={v:'pointer',h:'hand',n:'note',r:'box',c:'connector',t:'text',p:'pen'};
  const name=keys[event.key.toLowerCase()]; if(name) { event.preventDefault(); event.stopImmediatePropagation(); selectTool(name); }
},true);
document.addEventListener('paste',event => {
  if (event.clipboardData?.files.length) { event.preventDefault(); event.stopImmediatePropagation(); notice('Use Add file to keep a link to the original file.'); return; }
  if (event.composedPath().some(node => node instanceof HTMLElement && (node.isContentEditable || ['INPUT','TEXTAREA'].includes(node.tagName)))) return;
  const value=event.clipboardData?.getData('text/plain').trim();
  if (value && supportedLink(value)) { event.preventDefault(); event.stopImmediatePropagation(); const url=new URL(value); addLink({title:decodeURIComponent(url.pathname.split('/').pop() || url.hostname),url:value}); }
},true);
get('canvas').addEventListener('dragover',event => event.preventDefault());
get('canvas').addEventListener('drop',event => {
  const value=event.dataTransfer?.getData('text/uri-list').split('\n').find(line=>line && !line.startsWith('#')) || event.dataTransfer?.getData('text/plain');
  if(value && supportedLink(value)) { event.preventDefault(); event.stopImmediatePropagation(); const url=new URL(value); addLink({title:decodeURIComponent(url.pathname.split('/').pop() || url.hostname),url:value},service.viewport.toModelCoordFromClientCoord([event.clientX,event.clientY])); }
});
if (native) post({type:'ready'});
else {
  let stored:BoardDocument|null=null;
  try { const value=localStorage.getItem('brainz-whiteboard-preview'); if(value) stored=JSON.parse(value); } catch { notice('The saved board could not be read.'); }
  void receive({type:'load',document:stored,target});
}
