import type { EdgelessEditor } from '@blocksuite/presets';
import type { EdgelessRootService } from '@blocksuite/blocks';
import { bytesToBase64, supportedLink, type LinkReference } from './model';
import { isTextInput } from './tools';
import lz from 'lz-string';

export function installPaste(editor: EdgelessEditor, service: EdgelessRootService, addFile: (reference:LinkReference,position:[number,number])=>Promise<void>, addLink:(reference:LinkReference,position?:[number,number])=>unknown, notice:(message:string)=>void) {
  const clipboard=editor.std.clipboard;
  const write=clipboard.writeToClipboard.bind(clipboard);
  let pendingCopy:Promise<void>|undefined;
  const copies=new Map<string,{resolve:()=>void;reject:(error:Error)=>void}>();
  window.addEventListener('brainz',event=>{
    const message=(event as CustomEvent).detail;
    if(message.type!=='objectsCopied')return;
    const copy=copies.get(message.requestId);if(!copy)return;
    copies.delete(message.requestId);
    if(message.error)copy.reject(new Error(message.error));else copy.resolve();
  });
  let copyingObjects=false;
  for(const type of ['copy','cut'])document.addEventListener(type,event=>{
    copyingObjects=service.selection.selectedIds.length>0 && !service.selection.editing && !isTextInput(event);
    // WebKit drains microtasks between DOM listeners; keep the context until
    // BlockSuite's bubbling copy/cut handler has started the write.
    setTimeout(()=>{copyingObjects=false;},0);
  },true);
  clipboard.writeToClipboard=updateItems=>{
    if(!copyingObjects)return write(updateItems);
    const html=Promise.resolve(updateItems({'text/plain':'','text/html':'','image/png':''})).then(items=>{
      const snapshot={...items};
      const content=snapshot['text/html'];
      delete snapshot['text/plain'];delete snapshot['text/html'];delete snapshot['image/png'];
      return new Blob([`<div data-blocksuite-snapshot='${lz.compressToEncodedURIComponent(JSON.stringify(snapshot))}'>${content ?? ''}</div>`],{type:'text/html'});
    });
    // WebKit requires clipboard.write during the user gesture, before any
    // asynchronous snapshot or image serialization yields control.
    const operation=window.ipc?html.then(async blob=>{
      const content=await blob.text();
      const requestId=crypto.randomUUID();
      await new Promise<void>((resolve,reject)=>{
        const timer=setTimeout(()=>{copies.delete(requestId);reject(new Error('The native clipboard did not respond.'));},5000);
        copies.set(requestId,{resolve:()=>{clearTimeout(timer);resolve();},reject:error=>{clearTimeout(timer);reject(error);}});
        window.ipc!.postMessage(JSON.stringify({type:'copyObjects',requestId,html:content}));
      });
    }):navigator.clipboard.write([new ClipboardItem({'text/html':html})]);
    pendingCopy=operation;
    return operation.catch(error=>{
      notice(`Could not copy canvas objects: ${String(error)}`);
      throw error;
    }).finally(()=>{if(pendingCopy===operation)pendingCopy=undefined;});
  };
  let cursor:[number,number]|undefined;
  const nativePaste=()=>{
    if (!window.ipc) return;
    const position=cursor ?? [service.viewport.centerX-140,service.viewport.centerY-100];
    void Promise.resolve(pendingCopy).then(()=>window.ipc!.postMessage(JSON.stringify({type:'pasteClipboard',position}))).catch(error=>notice(`Could not paste canvas objects: ${String(error)}`));
  };
  editor.addEventListener('pointermove',event=>{cursor=service.viewport.toModelCoordFromClientCoord([event.clientX,event.clientY]);});
  // WKWebView can omit paste events on the non-editable canvas. Read the
  // system clipboard through the host instead, including object metadata.
  document.addEventListener('keydown',event=>{
    if (!window.ipc || event.key.toLowerCase()!=='v' || !(event.metaKey || event.ctrlKey) || isTextInput(event) || service.selection.editing) return;
    event.preventDefault();event.stopImmediatePropagation();nativePaste();
  },true);
  document.addEventListener('paste',event=>{
    const insideEditor=event.composedPath().includes(editor);
    if(isTextInput(event) && !insideEditor)return;
    // Object snapshots take precedence over image previews on the clipboard.
    if(event.clipboardData?.getData('text/html').includes('data-blocksuite-snapshot')) return;
    const files=Array.from(event.clipboardData?.files ?? []);
    for(const item of files.length ? [] : Array.from(event.clipboardData?.items ?? [])) {
      if (item.kind==='file' && item.type.startsWith('image/')) {
        const file=item.getAsFile();
        if (file && !files.includes(file)) files.push(file);
      }
    }
    const images=files.filter(file=>['image/png','image/jpeg','image/webp','image/gif'].includes(file.type));
    if(images.length) {
      event.preventDefault();event.stopImmediatePropagation();
      const position=cursor ?? [service.viewport.centerX-140,service.viewport.centerY-100];
      void(async()=>{
        for(const [index,file] of images.entries()) {
          try {
            if(file.size>25*1024*1024)throw new Error('Use an image under 25 MB.');
            const name=`Screenshot · ${new Date().toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}`;
            await addFile({title:name,url:'',image:{mime:file.type,data:bytesToBase64(new Uint8Array(await file.arrayBuffer()))}},[position[0]+index*24,position[1]+index*24]);
          } catch(error) {notice(`Could not paste the image: ${String(error)}`);}
        }
      })();
      return;
    }
    if(isTextInput(event))return;
    const value=event.clipboardData?.getData('text/plain').trim();
    if(value==='Brainz canvas objects' && window.ipc && !event.clipboardData?.getData('application/x-brainz-native-text')) {event.preventDefault();event.stopImmediatePropagation();nativePaste();}
    else if(value && supportedLink(value)) {event.preventDefault();event.stopImmediatePropagation();const url=new URL(value);addLink({title:decodeURIComponent(url.pathname.split('/').pop() || url.hostname),url:value},cursor);}
    else if(files.length) {
      event.preventDefault();event.stopImmediatePropagation();
      if (window.ipc && files.some(file=>file.type.startsWith('image/'))) nativePaste();
      else notice('Use Add file to link the original file. Images can be pasted directly.');
    }
    else if(!value && window.ipc) {event.preventDefault();event.stopImmediatePropagation();nativePaste();}
  },true);
}
