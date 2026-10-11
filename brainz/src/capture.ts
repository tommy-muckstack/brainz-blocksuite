import type { EdgelessEditor } from '@blocksuite/presets';
import { type EdgelessRootService, type EdgelessRootBlockComponent, BlocksUtils } from '@blocksuite/blocks';
import { ImageBlockModel } from '@blocksuite/affine-model';
import { Bound, getCommonBound } from '@blocksuite/global/utils';

type Point = [number, number];

export function installCapture(
  editor: EdgelessEditor,
  service: EdgelessRootService,
  copy: (png: string) => void,
  notice: (message: string) => void,
) {
  const button = document.getElementById('capture') as HTMLButtonElement;
  const overlay = document.createElement('div');
  overlay.className = 'capture-overlay'; overlay.hidden = true;
  overlay.innerHTML = '<div class="capture-region" hidden><span></span></div><div class="capture-hint">Drag an area to copy · Hold near any edge to keep moving · Esc to cancel</div>';
  document.getElementById('canvas')!.append(overlay);
  const region = overlay.querySelector<HTMLElement>('.capture-region')!;
  const dimensions = region.querySelector('span')!;
  let start: Point | undefined;
  let pointer: Point = [0, 0];
  let end: Point = [0, 0];
  let animation = 0;
  let previousFrame = 0;
  let busy = false;

  const cancel = () => {
    cancelAnimationFrame(animation); animation = 0; start = undefined;
    overlay.hidden = true; region.hidden = true;
    button.setAttribute('aria-pressed', 'false');
    document.body.classList.remove('capturing');
  };
  const activate = () => {
    if (busy) return;
    if (!overlay.hidden) return cancel();
    service.selection.clear();
    overlay.hidden = false; button.setAttribute('aria-pressed', 'true');
    document.body.classList.add('capturing');
  };
  const update = () => {
    if (!start) return;
    const rectangle = overlay.getBoundingClientRect();
    const local: Point = [Math.max(0, Math.min(rectangle.width, pointer[0] - rectangle.left)), Math.max(0, Math.min(rectangle.height, pointer[1] - rectangle.top))];
    end = service.viewport.toModelCoord(...local);
    const first = service.viewport.toViewCoord(...start);
    const last = service.viewport.toViewCoord(...end);
    Object.assign(region.style, {left: `${Math.min(first[0],last[0])}px`,top: `${Math.min(first[1],last[1])}px`,width: `${Math.abs(last[0]-first[0])}px`,height: `${Math.abs(last[1]-first[1])}px`});
    dimensions.textContent = `${Math.round(Math.abs(end[0]-start[0]))} × ${Math.round(Math.abs(end[1]-start[1]))}`;
  };
  const tick = (now: number) => {
    if (!start) return;
    const elapsed = previousFrame ? Math.min((now-previousFrame)/1000,.04) : 0;
    previousFrame = now;
    const rectangle = overlay.getBoundingClientRect();
    const velocity = (value: number, size: number) => {
      const threshold = Math.min(64,size/4);
      if (value < threshold) return -Math.pow(Math.min(1,(threshold-value)/threshold),2)*750;
      if (value > size-threshold) return Math.pow(Math.min(1,(value-size+threshold)/threshold),2)*750;
      return 0;
    };
    const horizontal = velocity(pointer[0]-rectangle.left,rectangle.width);
    const vertical = velocity(pointer[1]-rectangle.top,rectangle.height);
    if (horizontal || vertical) service.viewport.setViewport(service.zoom,[service.viewport.centerX+horizontal*elapsed/service.zoom,service.viewport.centerY+vertical*elapsed/service.zoom]);
    update(); animation = requestAnimationFrame(tick);
  };
  button.onclick = activate;
  document.addEventListener('keydown',event => {
    if (event.key === 'Escape' && !overlay.hidden) { event.preventDefault(); event.stopImmediatePropagation(); cancel(); }
  },true);
  overlay.onpointerdown = event => {
    if (event.button !== 0 || busy) return;
    event.preventDefault(); overlay.setPointerCapture(event.pointerId);
    const rectangle = overlay.getBoundingClientRect();
    pointer = [event.clientX,event.clientY];
    start = service.viewport.toModelCoord(event.clientX-rectangle.left,event.clientY-rectangle.top);
    region.hidden = false; previousFrame = 0; update(); animation = requestAnimationFrame(tick);
  };
  overlay.onpointermove = event => { pointer = [event.clientX,event.clientY]; update(); };
  overlay.onpointercancel = cancel;
  overlay.onpointerup = async event => {
    if (!start) return;
    pointer = [event.clientX,event.clientY]; update();
    const bounds = new Bound(Math.min(start[0],end[0]),Math.min(start[1],end[1]),Math.abs(end[0]-start[0]),Math.abs(end[1]-start[1]));
    cancel();
    if (bounds.w*service.zoom < 8 || bounds.h*service.zoom < 8) { notice('Drag to select the area you want to capture.'); return; }
    busy = true; button.disabled = true; notice('Copying canvas…');
    try { copy(await renderCapture(editor,service,bounds)); }
    catch (error) { console.error(error); notice(`Could not capture: ${error instanceof Error ? error.message : String(error)}`); }
    finally { busy = false; button.disabled = false; }
  };
  return { cancel };
}

export async function renderCapture(editor: EdgelessEditor, service: EdgelessRootService, bounds: Bound): Promise<string> {
  const elements = service.gfx.getElementsByBound(bounds);
  const common = getCommonBound(elements.map(element => element.elementBound));
  const ratio = Math.min(2,window.devicePixelRatio || 1);
  const maximumSide = Math.max(bounds.w,bounds.h,common?.w ?? 0,common?.h ?? 0);
  // The engine also allocates an intermediate canvas at the display's DPR.
  if (maximumSide * Math.max(ratio,window.devicePixelRatio) > 8192 || bounds.w*bounds.h*ratio*ratio > 32_000_000) throw new Error('Select a smaller area (up to 8,192 pixels per side).');
  const output = document.createElement('canvas');
  output.width = Math.ceil(bounds.w*ratio); output.height = Math.ceil(bounds.h*ratio);
  const context = output.getContext('2d');
  if (!context) throw new Error('Image rendering is unavailable.');
  context.fillStyle = '#141413'; context.fillRect(0,0,output.width,output.height);
  if (common && elements.length) {
    const root = editor.std.view.getBlock(editor.doc.root!.id) as EdgelessRootBlockComponent;
    const {notes,frames,images,edgelessTexts,embedSyncedDocs,shapes} = BlocksUtils.splitElements(elements);
    const original: [number,Point] = [service.zoom,[service.viewport.centerX,service.viewport.centerY]];
    let exportContainer: HTMLDivElement | undefined;
    const ignoredImages: [HTMLElement, string | null][] = [];
    try {
      document.body.classList.add('exporting-canvas');
      // Mount notes outside the current screen before exporting their rich text.
      service.viewport.setViewportByBound(common,[40,40,40,40],false);
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const blocks = [...notes,...frames,...images,...edgelessTexts,...embedSyncedDocs];
      // BlockSuite's exporter requires a note container even for an image-only
      // board. Supply the empty DOM container without adding a document block.
      if (blocks.length && !root.querySelector('.affine-block-children-container')) {
        exportContainer = document.createElement('div');
        exportContainer.className = 'affine-block-children-container';
        exportContainer.hidden = true;
        root.append(exportContainer);
      }
      // WebKit can leave html2canvas's cloned document loading forever when it
      // contains blob images on our custom scheme. Draw saved image bytes directly
      // and exclude their DOM from rich-text clones, including offscreen images.
      for (const element of root.querySelectorAll<HTMLElement>('affine-edgeless-image')) {
        ignoredImages.push([element,element.getAttribute('data-html2canvas-ignore')]);
        element.setAttribute('data-html2canvas-ignore','true');
      }
      for (const block of blocks.sort((left,right) => left.index < right.index ? -1 : left.index > right.index ? 1 : 0)) {
        const rectangle = Bound.deserialize(block.xywh);
        if (block instanceof ImageBlockModel) {
          const blob = block.sourceId ? await editor.doc.blobSync.get(block.sourceId) : null;
          if (!blob) throw new Error('An image is unavailable. Reopen the canvas and try again.');
          const url = URL.createObjectURL(blob);
          try {
            const image = new Image(); image.src = url;
            await image.decode();
            context.save();
            context.translate((rectangle.x+rectangle.w/2-bounds.x)*ratio,(rectangle.y+rectangle.h/2-bounds.y)*ratio);
            context.rotate((block.rotate || 0)*Math.PI/180);
            context.drawImage(image,-rectangle.w*ratio/2,-rectangle.h*ratio/2,rectangle.w*ratio,rectangle.h*ratio);
            context.restore();
          } finally { URL.revokeObjectURL(url); }
        } else {
          const image = await root.clipboardController.toCanvas([block],[],{padding:0,dpr:ratio});
          if (!image) throw new Error('The canvas could not be rendered.');
          context.drawImage(image,(rectangle.x-bounds.x)*ratio,(rectangle.y-bounds.y)*ratio,rectangle.w*ratio,rectangle.h*ratio);
        }
      }
      const surface = root.surface.renderer.getCanvasByBound(common,shapes);
      context.drawImage(surface,(common.x-bounds.x)*ratio,(common.y-bounds.y)*ratio,common.w*ratio,common.h*ratio);
    } finally {
      for (const [element,previous] of ignoredImages) {
        if (previous === null) element.removeAttribute('data-html2canvas-ignore');
        else element.setAttribute('data-html2canvas-ignore',previous);
      }
      exportContainer?.remove();
      document.body.classList.remove('exporting-canvas');
      service.viewport.setViewport(original[0],original[1]);
    }
  }
  return output.toDataURL('image/png').split(',')[1];
}
