import type { EdgelessEditor } from '@blocksuite/presets';
import type { EdgelessRootService } from '@blocksuite/blocks';
import { bytesToBase64, supportedLink, type LinkReference } from './model';
import { isTextInput } from './tools';

export function installPaste(editor: EdgelessEditor, service: EdgelessRootService, addFile: (reference:LinkReference,position:[number,number])=>Promise<void>, addLink:(reference:LinkReference,position?:[number,number])=>unknown, notice:(message:string)=>void) {
  let cursor:[number,number]|undefined;
  let keyboardPaste: ReturnType<typeof setTimeout>|undefined;
  const nativePaste=()=>{
    if (!window.ipc) return;
    window.ipc.postMessage(JSON.stringify({type:'pasteClipboard',position:cursor ?? [service.viewport.centerX-140,service.viewport.centerY-100]}));
  };
  editor.addEventListener('pointermove',event=>{cursor=service.viewport.toModelCoordFromClientCoord([event.clientX,event.clientY]);});
  // WKWebView sometimes omits the paste event when its clipboard contains only an image.
  document.addEventListener('keydown',event=>{
    if (!window.ipc || event.key.toLowerCase()!=='v' || !(event.metaKey || event.ctrlKey) || isTextInput(event)) return;
    if (keyboardPaste) clearTimeout(keyboardPaste);
    keyboardPaste=setTimeout(()=>{keyboardPaste=undefined;nativePaste();},80);
  },true);
  document.addEventListener('paste',event=>{
    if (keyboardPaste) {clearTimeout(keyboardPaste);keyboardPaste=undefined;}
    const insideEditor=event.composedPath().includes(editor);
    if(isTextInput(event) && !insideEditor)return;
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
    if(value && supportedLink(value)) {event.preventDefault();event.stopImmediatePropagation();const url=new URL(value);addLink({title:decodeURIComponent(url.pathname.split('/').pop() || url.hostname),url:value},cursor);}
    else if(files.length) {
      event.preventDefault();event.stopImmediatePropagation();
      if (window.ipc && files.some(file=>file.type.startsWith('image/'))) nativePaste();
      else notice('Use Add file to link the original file. Images can be pasted directly.');
    }
    else if(!value && window.ipc) {event.preventDefault();event.stopImmediatePropagation();nativePaste();}
  },true);
}
