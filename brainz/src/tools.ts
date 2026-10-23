import { ConnectorMode, EditPropsStore, EdgelessRootService, FontFamily, MindmapElementModel, MindmapStyle, NoteBlockModel, ShapeElementModel, ShapeType } from '@blocksuite/blocks';
import { ToolController } from '@blocksuite/block-std/gfx';
import { LassoMode } from '@blocksuite/affine-shared/types';
import { Point } from '@blocksuite/global/utils';
import type { EdgelessEditor } from '@blocksuite/presets';
import { CanvasCommands, type CanvasCommand } from './commands';
import { createNote, editNote, editShape, keepCreationTool } from './interactions';
import { icon, tool } from './shell';

const definitions = [
  ['pointer','Select','V'],['hand','Pan','H'],['note','Sticky note','N'],['box','Box','R'],['ellipse','Ellipse','O'],['diamond','Diamond','D'],['triangle','Triangle','⇧R'],['connector','Connector','C'],['text','Text','T'],['pen','Draw','P'],['eraser','Eraser','E'],['frame','Frame','F'],['mindmap','Mind map','M'],['lasso','Lasso','L'],['laser','Laser','K'],
] as const;
const shapeNames = {box:'roundedRect',ellipse:ShapeType.Ellipse,diamond:ShapeType.Diamond,triangle:ShapeType.Triangle} as const;
const keys: Record<string,string> = {v:'pointer',h:'hand',n:'note',r:'box',o:'ellipse',d:'diamond',c:'connector',a:'connector',t:'text',p:'pen',e:'eraser',f:'frame',m:'mindmap',l:'lasso',k:'laser'};

export function isTextInput(event: Event) {
  return event.composedPath().some(node=>node instanceof HTMLElement && (node.isContentEditable || ['INPUT','TEXTAREA','SELECT'].includes(node.tagName)));
}

export class CanvasTools {
  private active='pointer';
  private locked=false;
  private repeatTool?:string;
  private selecting=false;
  private laser=document.createElement('canvas');
  private points:{x:number;y:number;at:number}[]=[];
  private laserFrame=0;
  private previousTool='pointer';
  private expanded=false;
  private pinned=false;
  private ignoreHover=false;
  readonly commands:CanvasCommands;
  private controller:ToolController;

  constructor(private editor:EdgelessEditor, private service:EdgelessRootService, private save:()=>void, extra:()=>CanvasCommand[]) {
    this.controller=editor.std.get(ToolController);
    const rail=document.querySelector<HTMLElement>('.tools')!;
    const toggle=document.getElementById('tools-toggle')!;
    const content=document.getElementById('tools-content')!;
    const setExpanded=(expanded:boolean)=>{
      this.expanded=expanded;rail.classList.toggle('expanded',expanded);
      toggle.setAttribute('aria-expanded',String(expanded));
      toggle.setAttribute('aria-label',expanded?'Collapse drawing tools':'Expand drawing tools');
      content.inert=!expanded;
    };
    rail.addEventListener('pointerenter',()=>{if(!this.ignoreHover)setExpanded(true);});
    rail.addEventListener('pointerleave',()=>{this.ignoreHover=false;if(!this.pinned)setExpanded(false);});
    rail.addEventListener('focusin',()=>setExpanded(true));
    rail.addEventListener('focusout',event=>{if(!rail.contains(event.relatedTarget as Node) && !this.pinned && !rail.matches(':hover'))setExpanded(false);});
    toggle.onclick=()=>{this.pinned=!this.pinned;this.ignoreHover=!this.pinned;setExpanded(this.pinned);};
    rail.addEventListener('keydown',event=>{if(event.key==='Escape'){this.pinned=false;this.ignoreHover=true;setExpanded(false);toggle.focus();}});
    rail.querySelector('[data-tool="box"]')!.insertAdjacentHTML('afterend',`${tool('ellipse','Ellipse','O')}${tool('diamond','Diamond','D')}`);
    rail.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach(button=>{
      button.onclick=()=>this.select(button.dataset.tool!);
      const positionTooltip=()=>{
        const tooltip=button.querySelector<HTMLElement>('.tooltip');
        if(tooltip) tooltip.style.left=`${rail.getBoundingClientRect().right-button.getBoundingClientRect().left+10}px`;
      };
      button.addEventListener('pointerenter',positionTooltip);
      button.addEventListener('focus',positionTooltip);
    });
    const lock=document.getElementById('lock-tool')!;lock.onclick=()=>this.toggleLock();
    this.commands=new CanvasCommands(()=>[
      ...definitions.map(([id,label,shortcut])=>({id:`tool-${id}`,label,group:'Tools' as const,keys:shortcut,run:()=>this.select(id)})),
      {id:'keep-tool',label:this.locked?'Release current tool':'Keep current tool active',group:'Tools',keys:'Q',run:()=>this.toggleLock()},
      {id:'fit',label:'Fit canvas to content',group:'View',keys:'⇧1',run:()=>service.zoomToFit()},
      {id:'reset-zoom',label:'Zoom to 100%',group:'View',run:()=>service.viewport.setZoom(1)},
      {id:'undo',label:'Undo',group:'Arrange',keys:'⌘Z',run:()=>editor.doc.undo()},
      {id:'redo',label:'Redo',group:'Arrange',keys:'⇧⌘Z',run:()=>editor.doc.redo()},
      {id:'shortcuts',label:'Keyboard shortcuts',group:'View',keys:'?',run:()=>this.commands.show('shortcuts')},
      ...extra(),
    ]);
    document.getElementById('commands')!.onclick=()=>this.commands.show();
    editor.addEventListener('contextmenu',event=>{
      if(isTextInput(event) || service.selection.editing)return;
      event.preventDefault();event.stopImmediatePropagation();this.commands.show('context',{x:event.clientX,y:event.clientY});
    },true);
    this.installLaser(); this.installShapeMenu();
    this.controller.currentToolName$.subscribe(name=>{
      if(this.selecting)return;
      const mapped:Record<string,string>={default:'pointer',pan:'hand',shape:this.active in shapeNames?this.active:'box','affine:note':'note',connector:'connector',text:'text',brush:'pen',eraser:'eraser',frame:'frame',lasso:'lasso',frameNavigator:'frame'};
      if(name==='default' && this.repeatTool && !service.selection.editing) {
        const repeat=this.repeatTool;queueMicrotask(()=>{if(this.locked && !service.selection.editing)this.select(repeat);});
      }
      this.active=mapped[String(name)]??'pointer';this.render();
    });
    service.selection.slots.updated.on(()=>this.render());
    window.addEventListener('keydown',event=>this.keydown(event),true);
    this.render();
  }

  select(name:string) {
    if(name==='triangle' || name==='ellipse' || name==='diamond' || name==='box') this.previousTool=name;
    this.active=name;this.selecting=true;this.laser.hidden=name!=='laser';
    if(name!=='laser') {this.points=[];cancelAnimationFrame(this.laserFrame);}
    this.repeatTool=this.locked && ['box','ellipse','diamond','triangle','note','connector','text','frame'].includes(name)?name:undefined;
    const controller=this.controller;
    try {
      if(name in shapeNames) controller.setTool('shape',{shapeName:shapeNames[name as keyof typeof shapeNames]});
      else switch(name) {
        case 'pointer': controller.setTool('default');this.service.selection.set({elements:this.service.selection.selectedIds,editing:false});window.getSelection()?.removeAllRanges();break;
        case 'hand':controller.setTool('pan',{panning:false});break;
        case 'note':controller.setTool('affine:note',{childFlavour:'affine:paragraph',childType:'text',tip:'Write something…'});break;
        case 'connector':controller.setTool('connector',{mode:ConnectorMode.Orthogonal});break;
        case 'text':controller.setTool('text');break;
        case 'pen':controller.setTool('brush');break;
        case 'eraser':controller.setTool('eraser');break;
        case 'lasso':controller.setTool('lasso',{mode:LassoMode.FreeHand});break;
        case 'frame':
          if(this.service.selection.selectedIds.length) {const frame=this.service.frame.createFrameOnSelected();controller.setTool('default');if(frame)this.service.selection.set({elements:[frame.id],editing:false});this.active='pointer';}
          else controller.setTool('frame');break;
        case 'mindmap':this.createMindmap();break;
        case 'laser':controller.setTool('default');this.service.selection.set({elements:[],editing:false});break;
      }
    } finally {this.selecting=false;this.render();}
  }

  private toggleLock() {this.locked=!this.locked;keepCreationTool(this.editor.std,this.locked);this.repeatTool=this.locked && ['box','ellipse','diamond','triangle','note','connector','text','frame'].includes(this.active)?this.active:undefined;this.render();}

  private createMindmap() {
    this.editor.doc.captureSync();
    const x=this.service.viewport.centerX-80,y=this.service.viewport.centerY-28;
    const id=this.service.addElement('mindmap',{style:MindmapStyle.ONE,children:{text:'',xywh:JSON.stringify([x,y,160,56]),children:[]}});
    const map=this.service.getElementById(id);
    if(map instanceof MindmapElementModel) {
      const root=this.service.getElementById(map.tree.id);
      if(root instanceof ShapeElementModel) {this.service.gfx.updateElement(root,{fontFamily:FontFamily.Inter});editShape(this.editor,root);}
    }
    this.save();
  }

  private keydown(event:KeyboardEvent) {
    const key=event.key.toLowerCase(), modified=event.metaKey || event.ctrlKey;
    if(modified && (key==='k' || key==='/')) {event.preventDefault();event.stopImmediatePropagation();this.commands.open?this.commands.close():this.commands.show();return;}
    if(this.commands.open || document.querySelector('dialog[open]') || this.editor.querySelector('edgeless-auto-complete-panel'))return;
    if(modified && key==='s') {event.preventDefault();event.stopImmediatePropagation();this.save();return;}
    const selected=this.service.selection.selectedElements;
    const mindmapNode=selected.length===1 && selected[0] instanceof ShapeElementModel && selected[0].group instanceof MindmapElementModel?selected[0]:undefined;
    if(mindmapNode && !event.isComposing && (event.key==='Tab' || (event.key==='Enter' && !event.shiftKey))) {
      event.preventDefault();event.stopImmediatePropagation();
      const map=mindmapNode.group as MindmapElementModel;
      if(map.isLocked())return;
      if(document.activeElement instanceof HTMLElement)document.activeElement.blur();
      this.service.selection.set({elements:[mindmapNode.id],editing:false});
      if(modified)return;
      this.editor.doc.captureSync();
      const current=map.getNode(mindmapNode.id);
      if(!current)return;
      const parent=event.key==='Tab'?current:map.getParentNode(current.id)??current;
      const id=event.key==='Tab'?map.addNode(parent.id):map.addNode(parent.id,current.id,'after');
      const next=this.service.getElementById(id);
      if(next instanceof ShapeElementModel)editShape(this.editor,next);
      return;
    }
    const note=selected.length===1 && selected[0] instanceof NoteBlockModel?selected[0]:undefined;
    if(note && this.service.selection.editing && (event.key==='Tab' || (modified && event.key==='Enter'))) {
      event.preventDefault();event.stopImmediatePropagation();
      this.editor.std.selection.setGroup('note',[]);
      this.service.selection.set({elements:[note.id],editing:false});window.getSelection()?.removeAllRanges();
      if(document.activeElement instanceof HTMLElement)document.activeElement.blur();
      if(event.key==='Tab') {
        const bound=note.elementBound;
        const position=this.service.viewport.toViewCoord(event.shiftKey?bound.x:bound.x+bound.w+24,event.shiftKey?bound.y+bound.h+24:bound.y);
        const defaults=this.editor.std.get(EditPropsStore);defaults.recordLastProps('affine:note',{background:{normal:typeof note.background==='string'?note.background:note.background.normal??note.background.dark??note.background.light??'#e6ca78'}});
        createNote(this.editor.std,new Point(...position),bound.w,bound.h,true);
      }
      return;
    }
    if(isTextInput(event) || this.service.selection.editing)return;
    if(event.key==='?') {event.preventDefault();event.stopImmediatePropagation();this.commands.show('shortcuts');return;}
    if(event.key==='Escape') {this.select('pointer');return;}
    if(event.key==='Enter' && selected.length===1 && !modified) {
      if(note) {event.preventDefault();event.stopImmediatePropagation();editNote(this.editor.std,note);return;}
      if(selected[0] instanceof ShapeElementModel && !(selected[0].group instanceof MindmapElementModel)) {event.preventDefault();event.stopImmediatePropagation();editShape(this.editor,selected[0]);return;}
    }
    if(modified || event.altKey)return;
    if(event.shiftKey && event.key==='!') {event.preventDefault();event.stopImmediatePropagation();this.service.zoomToFit();return;}
    if(event.shiftKey && key==='r') {event.preventDefault();event.stopImmediatePropagation();const shapes=Object.keys(shapeNames);this.select(shapes[(shapes.indexOf(this.previousTool)+1)%shapes.length]);return;}
    // Mind-map labels own printable keys and their Tab/Enter navigation.
    if(selected.length===1 && selected[0].group instanceof MindmapElementModel)return;
    if(key==='q') {event.preventDefault();event.stopImmediatePropagation();this.toggleLock();return;}
    if(selected.length===1 && selected[0] instanceof ShapeElementModel && this.active==='pointer' && event.key.length===1 && key!==' ' && key!=='f') {
      event.preventDefault();event.stopImmediatePropagation();editShape(this.editor,selected[0],event.key);return;
    }
    if(keys[key]) {event.preventDefault();event.stopImmediatePropagation();this.select(keys[key]);}
  }

  private render() {
    document.getElementById('tools-toggle')!.querySelector('svg')?.remove();
    document.getElementById('tools-toggle')!.insertAdjacentHTML('afterbegin',icon(this.active));
    document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.tool===this.active || (this.active==='triangle' && button.dataset.tool==='box'))));
    document.getElementById('lock-tool')!.setAttribute('aria-pressed',String(this.locked));
    const selected=this.service.selection.selectedElements;
    const hint=document.querySelector('.hint')!;
    hint.textContent=selected.length===1 && selected[0].group instanceof MindmapElementModel?'Tab adds a child · Enter adds a sibling':selected.length===1 && selected[0] instanceof NoteBlockModel && this.service.selection.editing?'Tab: next sticky · ⇧Tab: below · ⌘Enter: finish':this.active==='note'?'Click to place · Tab for the next sticky':this.active==='laser'?'Point to highlight · Escape to finish':this.active==='eraser'?'Drag across objects to erase · ⌘Z to undo':selected.length>1?'F to frame · ⌘G to group · ⌘K for commands':selected.length===1?'Enter to edit · Drag to move · ⌘K for commands':'Space + drag to pan · Pinch to zoom · ? for shortcuts';
  }

  private installShapeMenu() {
    const button=document.querySelector<HTMLButtonElement>('[data-tool="box"]')!;
    const menu=document.createElement('div');menu.className='shape-flyout';menu.hidden=true;menu.setAttribute('role','menu');
    for(const name of Object.keys(shapeNames)) {const item=document.createElement('button');item.setAttribute('role','menuitem');item.innerHTML=icon(name);item.title=name;item.setAttribute('aria-label',name);item.onclick=()=>{menu.hidden=true;this.select(name);};menu.append(item);}
    document.body.append(menu);let timer:ReturnType<typeof setTimeout>|undefined;let longPress=false;
    const show=()=>{longPress=true;const bounds=button.getBoundingClientRect();menu.style.left=`${bounds.right+10}px`;menu.style.top=`${bounds.top}px`;menu.hidden=false;};
    button.addEventListener('pointerdown',()=>{longPress=false;timer=setTimeout(show,400);});
    for(const event of ['pointerup','pointerleave','pointercancel'])button.addEventListener(event,()=>clearTimeout(timer));
    button.addEventListener('click',event=>{if(longPress){event.preventDefault();event.stopImmediatePropagation();}},true);
    button.addEventListener('contextmenu',event=>{event.preventDefault();show();});
    document.addEventListener('pointerdown',event=>{if(!menu.contains(event.target as Node) && !button.contains(event.target as Node))menu.hidden=true;});
  }

  private installLaser() {
    this.laser.id='canvas-laser';this.laser.hidden=true;this.laser.setAttribute('aria-label','Laser pointer');document.getElementById('canvas')!.append(this.laser);
    const paint=()=>{
      const now=performance.now();this.points=this.points.filter(point=>now-point.at<600);
      const bounds=this.laser.getBoundingClientRect(),ratio=devicePixelRatio;
      if(this.laser.width!==Math.round(bounds.width*ratio)||this.laser.height!==Math.round(bounds.height*ratio)){this.laser.width=Math.round(bounds.width*ratio);this.laser.height=Math.round(bounds.height*ratio);}
      const context=this.laser.getContext('2d');if(!context)return;
      context.setTransform(ratio,0,0,ratio,0,0);context.clearRect(0,0,bounds.width,bounds.height);context.lineCap='round';context.strokeStyle='#f6d877';context.shadowColor='#f6d877';context.shadowBlur=8;context.lineWidth=3;
      for(let index=1;index<this.points.length;index++){const before=this.points[index-1],point=this.points[index];context.globalAlpha=1-(now-point.at)/600;context.beginPath();context.moveTo(before.x,before.y);context.lineTo(point.x,point.y);context.stroke();}
      this.laserFrame=this.points.length?requestAnimationFrame(paint):0;
    };
    this.laser.addEventListener('pointermove',event=>{const bounds=this.laser.getBoundingClientRect();this.points.push({x:event.clientX-bounds.left,y:event.clientY-bounds.top,at:performance.now()});if(!this.laserFrame)this.laserFrame=requestAnimationFrame(paint);event.stopPropagation();});
    this.laser.addEventListener('pointerdown',event=>{event.preventDefault();event.stopPropagation();});
  }
}
