import { test, expect, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

declare global { interface Window { __messages: any[]; __stored: any; __target: any } }
async function openBoard(page: Page) {
  await page.addInitScript(() => {
    window.__messages=[];
    window.__target={path:'/tmp/Brainz test.board.brainzboard'};
    window.ipc={postMessage(value:string){
      const message=JSON.parse(value);window.__messages.push(message);
      if(message.type==='ready') queueMicrotask(()=>window.dispatchEvent(new CustomEvent('brainz',{detail:{type:'load',document:JSON.parse(localStorage.getItem('test-board') || 'null'),viewState:JSON.parse(localStorage.getItem('test-view') || 'null'),target:window.__target,attach:localStorage.getItem('test-attach')==='true'}})));
      if(message.type==='save') {localStorage.setItem('test-board',JSON.stringify(message.document));queueMicrotask(()=>window.dispatchEvent(new CustomEvent('brainz',{detail:{type:'saved',revision:message.revision}})));}
      if(message.type==='viewState') localStorage.setItem('test-view',JSON.stringify(message.viewport));
    }};
  });
  await page.goto('/');
  await page.waitForFunction(()=>Boolean(window.__brainzBoard));
}
async function drawBox(page:Page,from:[number,number],to:[number,number]) {
  await page.getByRole('button',{name:'Box',exact:true}).click();
  await page.mouse.move(...from);await page.mouse.down();await page.mouse.move(...to,{steps:15});await page.mouse.up();
}
const state = (page:Page) => page.evaluate(()=> (window.__brainzBoard as any).service.edgelessElements.map((element:any)=>({id:element.id,type:element.type,xywh:element.xywh,source:element.source,target:element.target})));

test('Ten seconds of panning and zooming save only local view state; reopening does not rewrite the canvas',async({page})=>{
  await openBoard(page);
  await expect(page.locator('#save-state')).toContainText('Saved');
  const before = await page.evaluate(()=>localStorage.getItem('test-board'));
  await page.evaluate(async()=>{
    window.__messages=[];
    const {service} = window.__brainzBoard as any;
    for(let index=0;index<100;index++) {
      service.viewport.setViewport(0.5+index/100,[index*12,-index*7]);
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    window.dispatchEvent(new Event('pagehide'));
  });
  const messages = await page.evaluate(()=>window.__messages);
  expect(messages.filter(message=>message.type==='save')).toEqual([]);
  const views = messages.filter(message=>message.type==='viewState');
  expect(views.length).toBeGreaterThan(0); expect(views.length).toBeLessThanOrEqual(11);
  expect(views.at(-1).viewport).toEqual([1188,-693,1.49]);
  expect(await page.evaluate(()=>localStorage.getItem('test-board'))).toBe(before);
  const context = await page.evaluate(async()=>new Promise<any>(resolve=>{
    const post = window.ipc!.postMessage;
    window.ipc!.postMessage = value => { const message=JSON.parse(value); if(message.type==='canvasResponse') { window.ipc!.postMessage=post; resolve(message.result.context); } else post(value); };
    window.dispatchEvent(new CustomEvent('brainz',{detail:{type:'canvasRequest',request:{requestId:'live-read',kind:'read'}}}));
  }));
  expect(context.viewport.zoom).toBe(1.49);
  expect(context.viewport.x).toBeGreaterThan(500);
  expect(await page.evaluate(()=>window.__messages.filter(message=>message.type==='save'))).toEqual([]);
  await page.reload(); await page.waitForFunction(()=>Boolean(window.__brainzBoard));
  await expect.poll(()=>page.evaluate(()=>{const {service}=window.__brainzBoard as any;return [service.viewport.centerX,service.viewport.centerY,service.zoom];})).toEqual([1188,-693,1.49]);
  await page.waitForTimeout(1200);
  expect(await page.evaluate(()=>window.__messages.filter(message=>message.type==='save'))).toEqual([]);
});

async function colorCounts(page:Page, points:number[][], color:number[], radius=7) {
  const screenshot=(await page.screenshot()).toString('base64');
  return page.evaluate(async({screenshot,points,color,radius})=>{
    const image=new Image();image.src=`data:image/png;base64,${screenshot}`;await image.decode();
    const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
    const context=canvas.getContext('2d')!;context.drawImage(image,0,0);
    return points.map(([x,y])=>{
      const pixels=context.getImageData(Math.round(x)-radius,Math.round(y)-radius,radius*2+1,radius*2+1).data;
      let count=0;
      for(let index=0;index<pixels.length;index+=4) if(color.every((value,channel)=>Math.abs(pixels[index+channel]-value)<8))count++;
      return count;
    });
  },{screenshot,points,color,radius});
}

const objectPorts=(page:Page)=>page.evaluate(()=>{
  const {service}=window.__brainzBoard as any;
  const canvas=document.getElementById('canvas')!.getBoundingClientRect();
  return service.edgelessElements.filter((element:any)=>element.connectable).map((element:any)=>{
    const [x,y,width,height]=JSON.parse(element.xywh);
    const angle=(element.rotate||0)*Math.PI/180;
    const ports=[[0,-height/2],[width/2,0],[0,height/2],[-width/2,0]].map(([dx,dy])=>{
      const point=service.viewport.toViewCoord(x+width/2+dx*Math.cos(angle)-dy*Math.sin(angle),y+height/2+dx*Math.sin(angle)+dy*Math.cos(angle));
      return [point[0]+canvas.left,point[1]+canvas.top];
    });
    return {id:element.id,ports};
  });
});

test('Connector shows object ports immediately and binds arrows at every zoom',async({page})=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await openBoard(page);
  await drawBox(page,[270,230],[460,350]);await drawBox(page,[800,230],[990,350]);
  await page.getByRole('button',{name:'Sticky note',exact:true}).click();await page.mouse.click(500,510);
  await page.getByRole('button',{name:'Connector',exact:true}).click();
  let objects=await objectPorts(page);
  expect(objects).toHaveLength(3);
  const amber=[226,199,107];
  // Software rasterization leaves 11–12 fully amber pixels in the thin ring;
  // its remaining pixels blend with the background. Check every port, while
  // keeping the same tolerance used for the rotated/zoomed rings below.
  await expect.poll(async()=>Math.min(...await colorCounts(page,objects.flatMap((object:any)=>object.ports),amber)), {message:'Every connector port should visibly render its amber ring'}).toBeGreaterThanOrEqual(10);
  await page.screenshot({path:test.info().outputPath('connector-ports.png')});
  const [source,target]=objects;
  await page.mouse.move(source.ports[1][0],source.ports[1][1]);await page.mouse.down();
  await page.mouse.move(target.ports[3][0],target.ports[3][1],{steps:20});
  await expect.poll(async()=>(await colorCounts(page,objects[2].ports,amber)).every(count=>count>=10)).toBe(true);
  await page.mouse.up();
  const connector=(await state(page)).find((element:any)=>element.type==='connector');
  expect(connector.source).toMatchObject({id:source.id,position:[1,.5]});
  expect(connector.target).toMatchObject({id:target.id,position:[0,.5]});
  await expect(page.getByRole('button',{name:'Select',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect.poll(async()=>(await colorCounts(page,objects[2].ports,amber)).every(count=>count===0)).toBe(true);

  await page.evaluate(id=>{
    const {service}=window.__brainzBoard as any;
    service.gfx.updateElement(service.gfx.getElementById(id),{rotate:30});
    service.viewport.setViewport(.65,[service.viewport.centerX+40,service.viewport.centerY-30]);
  },source.id);
  await page.getByRole('button',{name:'Connector',exact:true}).click();
  objects=await objectPorts(page);
  await page.screenshot({path:test.info().outputPath('rotated-ports.png')});
  // At fractional zoom the software renderer retains 7–8 fully opaque pixels
  // in some rings. The rest remain visible but are antialiased.
  await expect.poll(async()=>Math.min(...await colorCounts(page,objects.flatMap((object:any)=>object.ports),amber))).toBeGreaterThanOrEqual(6);
  await page.mouse.move(objects[0].ports[2][0],objects[0].ports[2][1]);await page.mouse.down();
  await page.mouse.move(objects[2].ports[0][0],objects[2].ports[0][1],{steps:20});await page.mouse.up();
  const rotatedConnector=(await state(page)).filter((element:any)=>element.type==='connector')[1];
  expect(rotatedConnector.source.id).toBe(source.id);
  expect(rotatedConnector.source.position[0]).toBeCloseTo(.5,1);
  expect(rotatedConnector.source.position[1]).toBeCloseTo(1,1);
  expect(rotatedConnector.target.id).toBe(objects[2].id);
  await expect(page.locator('#save-state')).toHaveText('Saved locally');
  await page.reload();await page.waitForFunction(()=>Boolean(window.__brainzBoard));
  expect((await state(page)).filter((element:any)=>element.type==='connector')).toHaveLength(2);
  expect(errors).toEqual([]);
});

test('transparent fill removes the background and survives reopening',async({page})=>{
  const errors:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));
  await openBoard(page);
  await drawBox(page,[350,300],[630,480]);
  await page.getByRole('button',{name:'Select',exact:true}).click();
  await page.mouse.click(450,400);
  await page.locator('editor-icon-button[aria-label="Fill color"]').click();
  const palette=page.locator('edgeless-color-panel[aria-label="Fill colors"]');
  await palette.locator('[aria-label="--affine-palette-shape-green"]').click();
  const fill=()=>page.evaluate(()=>{
    const shape=(window.__brainzBoard as any).service.edgelessElements[0];
    return {filled:shape.filled,fillColor:shape.fillColor};
  });
  await expect.poll(fill).toEqual({filled:true,fillColor:'--affine-palette-shape-green'});
  expect((await colorCounts(page,[[500,420]],[20,20,19]))[0]).toBe(0);
  await page.locator('editor-icon-button[aria-label="Fill color"]').click();
  await palette.locator('[aria-label="--affine-palette-transparent"]').click();
  await expect.poll(fill).toEqual({filled:false,fillColor:'--affine-palette-transparent'});
  expect(errors).toEqual([]);
  await page.mouse.click(950,650);
  await expect.poll(async()=>(await colorCounts(page,[[500,420]],[20,20,19]))[0]).toBeGreaterThan(150);
  await expect(page.locator('#save-state')).toHaveText('Saved locally');
  await page.screenshot({path:test.info().outputPath('transparent-fill.png')});
  await page.reload();await page.waitForFunction(()=>Boolean(window.__brainzBoard));
  await expect.poll(fill).toEqual({filled:false,fillColor:'--affine-palette-transparent'});
  await expect.poll(async()=>(await colorCounts(page,[[500,420]],[20,20,19]))[0]).toBeGreaterThan(150);
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('brainz',{detail:{type:'attach'}})));
  await expect.poll(()=>page.evaluate(()=>window.__messages.some(message=>message.type==='attachToChat'))).toBe(true);
  const center=await page.evaluate(async()=>{
    const {png}=window.__messages.find(message=>message.type==='attachToChat');
    const image=new Image();image.src=`data:image/png;base64,${png}`;await image.decode();
    const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
    const context=canvas.getContext('2d')!;context.drawImage(image,0,0);
    return [...context.getImageData(image.width/2,image.height/2,1,1).data];
  });
  expect(center).toEqual([20,20,19,255]);
  expect(errors).toEqual([]);
});

test('Copy PNG exports only selected items with equal padding',async({page})=>{
  await openBoard(page);
  await drawBox(page,[300,270],[500,410]);
  await drawBox(page,[400,300],[460,360]);
  await page.evaluate(()=>{
    const {service}=window.__brainzBoard as any;
    const [selected,other]=service.edgelessElements;
    service.gfx.updateElement(selected,{fillColor:'#55aaff',strokeColor:'#55aaff',strokeWidth:0,radius:0});
    service.gfx.updateElement(other,{fillColor:'#ff2200',strokeColor:'#ff2200'});
    service.selection.set({elements:[selected.id],editing:false});
  });
  await page.locator('editor-icon-button[aria-label="Copy PNG"]').click();
  await expect.poll(()=>page.evaluate(()=>window.__messages.filter(message=>message.type==='copyImage').length)).toBe(1);
  const capture=await page.evaluate(async()=>{
    const {png}=window.__messages.find(message=>message.type==='copyImage');
    const image=new Image();image.src=`data:image/png;base64,${png}`;await image.decode();
    const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
    const context=canvas.getContext('2d')!;context.drawImage(image,0,0);
    const pixels=context.getImageData(0,0,image.width,image.height).data;
    let left=image.width,top=image.height,right=0,bottom=0,red=0;
    for(let y=0;y<image.height;y++)for(let x=0;x<image.width;x++) {
      const index=(y*image.width+x)*4;
      if(pixels[index]===85&&pixels[index+1]===170&&pixels[index+2]===255) {left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);}
      if(pixels[index]>240&&pixels[index+1]<60&&pixels[index+2]<10)red++;
    }
    return {width:image.width,height:image.height,padding:[left,top,image.width-1-right,image.height-1-bottom],red};
  });
  expect(capture).toMatchObject({width:264,height:204,red:0});
  // Rasterizers can antialias the edge by one pixel; the margin must still be equal on all sides.
  expect(new Set(capture.padding).size).toBe(1);
  for(const margin of capture.padding) { expect(margin).toBeGreaterThanOrEqual(32); expect(margin).toBeLessThanOrEqual(33); }
  expect((await state(page))).toHaveLength(2);
  const png=await page.evaluate(()=>window.__messages.find(message=>message.type==='copyImage').png);
  await test.info().attach('Selected objects PNG',{body:Buffer.from(png,'base64'),contentType:'image/png'});
});

test('filing a canvas updates its saved context and object links',async({page})=>{
  await openBoard(page);await drawBox(page,[320,240],[520,420]);
  await page.getByRole('textbox',{name:'Board name'}).fill('Project map');
  await page.getByLabel('Canvas options',{exact:true}).click();
  await page.getByRole('menuitem',{name:'Move to folder…'}).click();
  expect(await page.evaluate(()=>window.__messages.some(message=>message.type==='moveCanvas'))).toBe(true);
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('brainz',{detail:{type:'relocated',target:{path:'/tmp/Projects/Project map.brainzboard'}}})));
  await page.getByRole('button',{name:'Copy link',exact:true}).click();
  const link=await page.evaluate(()=>window.__messages.filter(message=>message.type==='copy').at(-1).text);
  expect(new URL(link).searchParams.get('path')).toBe('/tmp/Projects/Project map.brainzboard');
  await expect(page.locator('#save-state')).toHaveText('Saved locally');
  const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('test-board')!));
  expect(saved.title).toBe('Project map');
  expect(JSON.stringify(saved.scene)).toContain('/tmp/Projects/Project map.brainzboard');
});

test('single clicks keep notes draggable and double click enters text editing',async({page})=>{
  await openBoard(page);
  await page.getByRole('button',{name:'Add your first note'}).click();
  const note = page.locator('affine-edgeless-note');
  const editing = () => page.evaluate(()=>(window.__brainzBoard as any).service.selection.editing);
  expect(await editing()).toBe(false);
  await note.click({position:{x:50,y:45}});
  await page.waitForTimeout(600);
  await note.click({position:{x:50,y:45}});
  expect(await editing()).toBe(false);
  const before = (await state(page))[0];
  const bounds = (await note.boundingBox())!;
  await page.mouse.move(bounds.x+65,bounds.y+45);await page.mouse.down();
  await page.mouse.move(bounds.x+145,bounds.y+135,{steps:20});await page.mouse.up();
  await expect.poll(async()=>(await state(page))[0].xywh).not.toBe(before.xywh);
  await note.dblclick({position:{x:50,y:45}});
  await expect.poll(editing).toBe(true);
  await page.keyboard.type('Drag me without changing this');
  await page.keyboard.press('Escape');
  await page.mouse.click(1100,700);
  await note.click({position:{x:55,y:45}});
  expect(await editing()).toBe(false);
  const afterTyping = (await state(page))[0];
  const movedBounds = (await note.boundingBox())!;
  await page.mouse.move(movedBounds.x+60,movedBounds.y+45);await page.mouse.down();
  await page.mouse.move(movedBounds.x-40,movedBounds.y-45,{steps:20});await page.mouse.up();
  await expect.poll(async()=>(await state(page))[0].xywh).not.toBe(afterTyping.xywh);
  expect(await page.evaluate(()=>(window.__brainzBoard as any).editor.doc.getBlocksByFlavour('affine:paragraph').map((block:any)=>block.model.text.toString()))).toEqual(['Drag me without changing this']);
});

test('all drawing controls remain reachable above an open chat dock',async({page})=>{
  await page.setViewportSize({width:1200,height:375});
  await openBoard(page);
  for (const name of ['Select','Sticky note','Box','Capture area']) {
    const button=page.getByRole('button',{name,exact:true});
    const bounds=(await button.boundingBox())!;
    expect(bounds.y).toBeGreaterThanOrEqual(55);
    expect(bounds.y+bounds.height).toBeLessThan(305);
    await button.click();
  }
  await page.keyboard.press('Escape');
});

test('chat context includes explicit arrows, the visual canvas, and images after reopening',async({page})=>{
  page.on('console',message=>{if(message.type()==='error')console.log(message.text());});
  await openBoard(page);
  await drawBox(page,[250,240],[440,360]);await drawBox(page,[780,240],[970,360]);
  await page.getByRole('button',{name:'Connector',exact:true}).click();
  await page.mouse.move(435,300);await page.mouse.down();await page.mouse.move(785,300,{steps:20});await page.mouse.up();
  await page.evaluate(()=>{
    const canvas=document.createElement('canvas');canvas.width=160;canvas.height=100;
    const context=canvas.getContext('2d')!;context.fillStyle='#ff6600';context.fillRect(0,0,160,100);
    context.fillStyle='#ffffff';context.fillRect(25,25,110,50);
    window.dispatchEvent(new CustomEvent('brainz',{detail:{type:'files',files:[{title:'diagram.png',url:'file:///tmp/diagram.png',image:{mime:'image/png',data:canvas.toDataURL('image/png').split(',')[1]}}],position:[400,480]}}));
  });
  await expect(page.locator('affine-edgeless-image img')).toBeVisible();
  await expect(page.locator('#save-state')).toHaveText('Saved locally');
  await page.reload();await page.waitForFunction(()=>Boolean(window.__brainzBoard));
  await expect(page.locator('affine-edgeless-image img')).toBeVisible();
  expect(await page.locator('affine-edgeless-image img').evaluate(image=>(image as HTMLImageElement).naturalWidth)).toBe(160);
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('brainz',{detail:{type:'attach'}})));
  await expect.poll(()=>page.evaluate(()=>window.__messages.some(message=>message.type==='attachToChat'))).toBe(true);
  const context=await page.evaluate(()=>window.__messages.find(message=>message.type==='attachToChat'));
  const objects=(await state(page)).filter((object:any)=>object.type==='shape');
  expect(context.scene.connections).toHaveLength(1);
  expect(context.scene.connections[0].source.objectId).toBe(objects[0].id);
  expect(context.scene.connections[0].target.objectId).toBe(objects[1].id);
  expect(context.scene.connections[0].target.marker).toBe('Arrow');
  const image=context.scene.objects.find((object:any)=>object.kind==='image');
  expect(image.image.original).toBe('file:///tmp/diagram.png');
  expect(image.bounds.width).toBeGreaterThan(0);
  expect(context.preview).toContain('whole canvas');
  const png=Buffer.from(context.png,'base64');expect(png.subarray(1,4).toString()).toBe('PNG');
  const orangePixels = await page.evaluate(async png=>{
    const image=new Image();image.src=`data:image/png;base64,${png}`;await image.decode();
    const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
    const context=canvas.getContext('2d')!;context.drawImage(image,0,0);
    const pixels=context.getImageData(0,0,canvas.width,canvas.height).data;
    let orange=0;for(let index=0;index<pixels.length;index+=4) if(pixels[index]>240&&pixels[index+1]>90&&pixels[index+1]<120&&pixels[index+2]<10)orange++;
    return orange;
  },context.png);
  expect(orangePixels).toBeGreaterThan(1000);
  await test.info().attach('AI canvas preview',{body:png,contentType:'image/png'});
  const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('test-board')!));
  expect(saved.scene.connections[0].source.objectId).toBe(objects[0].id);
  expect(Object.keys(saved.images)).toHaveLength(1);
});

test('shape text uses the loaded canvas font and fit restores the previous view',async({page})=>{
  await openBoard(page);await drawBox(page,[300,260],[550,410]);
  await page.mouse.dblclick(420,325);await page.keyboard.type('Hey');await page.keyboard.press('Escape');
  await page.mouse.click(850,650);
  expect(await page.evaluate(()=>document.fonts.check('18px "blocksuite:surface:Inter"'))).toBe(true);
  expect(await page.evaluate(()=>(window.__brainzBoard as any).service.edgelessElements[0].fontFamily)).toBe('blocksuite:surface:Inter');
  await page.evaluate(()=>{
    const board=window.__brainzBoard as any;
    board.editor.doc.spaceDoc.getMap('brainz:migrations').delete('canvas-font');
    board.service.gfx.updateElement(board.service.edgelessElements[0],{fontFamily:'Inter'});
  });
  await expect(page.locator('#save-state')).toHaveText('Saved locally');
  await page.reload();await page.waitForFunction(()=>Boolean(window.__brainzBoard));
  expect(await page.evaluate(()=>(window.__brainzBoard as any).service.edgelessElements[0].fontFamily)).toBe('blocksuite:surface:Inter');
  await page.getByRole('button',{name:'Fit to content',exact:true}).click();
  await page.getByRole('button',{name:'Restore previous view',exact:true}).click();
  await expect(page.getByRole('button',{name:'Fit to content',exact:true})).toBeVisible();
  await page.screenshot({path:test.info().outputPath('shape-font.png')});
});

test('draw, attach connectors, move boxes, edit notes and reopen the saved board',async({page})=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await openBoard(page);
  await drawBox(page,[270,240],[470,370]);await drawBox(page,[760,240],[960,370]);
  await page.getByRole('button',{name:'Connector',exact:true}).click();
  await page.mouse.move(465,305);await page.mouse.down();await page.mouse.move(765,305,{steps:25});await page.mouse.up();
  await expect.poll(async()=> (await state(page)).filter((e:any)=>e.type==='connector').length).toBe(1);
  const before=await state(page);const connector=before.find((e:any)=>e.type==='connector');
  expect(connector.source.id).toBe(before[0].id);expect(connector.target.id).toBe(before[1].id);
  await page.getByRole('button',{name:'Select',exact:true}).click();
  await page.mouse.move(350,280);await page.mouse.down();await page.mouse.move(390,490,{steps:20});await page.mouse.up();
  await expect.poll(async()=> (await state(page)).find((e:any)=>e.id===before[0].id)?.xywh).not.toBe(before[0].xywh);
  expect((await state(page)).find((e:any)=>e.id===connector.id)?.source.id).toBe(before[0].id);
  await page.getByRole('button',{name:'Sticky note',exact:true}).click();await page.mouse.click(700,550);
  await page.locator('affine-edgeless-note').dblclick({position:{x:50,y:45}});
  await expect(page.locator('rich-text [contenteditable=true]')).toBeVisible();
  await page.keyboard.type('Ideas worth keeping');await page.keyboard.press('Escape');await page.mouse.click(560,700);
  await expect.poll(()=>page.evaluate(()=> (window.__brainzBoard as any).editor.doc.getBlocksByFlavour('affine:paragraph').map((b:any)=>b.model.text.toString()))).toContain('Ideas worth keeping');
  await page.getByRole('textbox',{name:'Board name'}).fill('Project map');await page.getByRole('textbox',{name:'Board name'}).press('Tab');
  await expect(page.locator('#save-state')).toHaveText('Saved locally');
  const saved=await state(page);
  await page.reload();await page.waitForFunction(()=>Boolean(window.__brainzBoard));
  expect(await state(page)).toEqual(saved);await expect(page.getByRole('textbox',{name:'Board name'})).toHaveValue('Project map');
  await expect(page.locator('affine-paragraph')).toContainText('Ideas worth keeping');
  await page.screenshot({path:'test-results/canvas-drawing.png'});
  expect(errors).toEqual([]);
});

test('file cards open originals and stable object links refocus after reopening',async({page})=>{
  await openBoard(page);
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('brainz',{detail:{type:'files',files:[{title:'Plan.md',url:'file:///tmp/Plan.md'}],position:[400,280]}})));
  await page.locator('edgeless-element-toolbar-widget').getByLabel('More',{exact:true}).click();
  await page.getByText('Open linked file',{exact:true}).click();
  expect(await page.evaluate(()=>window.__messages.find(m=>m.type==='open').url)).toBe('file:///tmp/Plan.md');
  await page.locator('edgeless-element-toolbar-widget').getByLabel('More',{exact:true}).click();
  await page.getByText('Copy object link',{exact:true}).click();
  const link=await page.evaluate(()=>window.__messages.find(m=>m.type==='copy').text);
  const url=new URL(link);expect(url.protocol).toBe('brainz:');expect(url.searchParams.get('path')).toBe('/tmp/Brainz test.board.brainzboard');
  const id=url.searchParams.get('object');expect(id).toBeTruthy();
  await page.reload();await page.waitForFunction(()=>Boolean(window.__brainzBoard));
  await page.evaluate(object=>window.dispatchEvent(new CustomEvent('brainz',{detail:{type:'focus',target:{path:'/tmp/Brainz test.board.brainzboard',object}}})),id);
  await page.locator('edgeless-element-toolbar-widget').getByLabel('More',{exact:true}).click();
  await expect(page.getByText('Open linked file',{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>(window.__brainzBoard as any).service.selection.selectedIds)).toEqual([id]);
});

test('capture pans at all four edges and copies offscreen content as PNG',async({page})=>{
  page.on('console',m=>{if(m.type()==='error')console.log(m.text());});
  await openBoard(page);await drawBox(page,[290,240],[520,410]);
  await page.getByRole('button',{name:'Capture area',exact:true}).click();
  await page.mouse.move(200,160);await page.mouse.down();
  const center=()=>page.evaluate(()=>{const v=(window.__brainzBoard as any).service.viewport;return [v.centerX,v.centerY]});
  let previous=await center();
  for(const [point,axis,direction] of [[[1275,400],0,1],[[5,400],0,-1],[[600,845],1,1],[[600,60],1,-1]] as const) {
    await page.mouse.move(...point,{steps:8});
    await expect.poll(async()=> ((await center())[axis]-previous[axis])*direction).toBeGreaterThan(120);
    previous=await center();
  }
  await page.mouse.move(1275,650,{steps:12});
  await expect.poll(async()=> (await center())[0]).toBeGreaterThan(700);
  await page.mouse.up();
  await expect.poll(()=>page.evaluate(()=>window.__messages.some(m=>m.type==='copyImage'))).toBe(true);
  const png=await page.evaluate(()=>window.__messages.find(m=>m.type==='copyImage').png);
  const bytes=Buffer.from(png,'base64');expect(bytes.subarray(1,4).toString()).toBe('PNG');expect(bytes.readUInt32BE(16)).toBeGreaterThan(1280);
  await test.info().attach('Captured area',{body:bytes,contentType:'image/png'});
  expect((await state(page)).length).toBe(1);
  const count=await page.evaluate(()=>window.__messages.filter(m=>m.type==='copyImage').length);
  await page.getByRole('button',{name:'Capture area',exact:true}).click();await page.mouse.move(400,350);await page.mouse.down();await page.mouse.move(700,500);await page.keyboard.press('Escape');await page.mouse.up();
  expect(await page.evaluate(()=>window.__messages.filter(m=>m.type==='copyImage').length)).toBe(count);
});


test('capture includes sticky-note text and keeps the document unchanged',async({page})=>{
  await openBoard(page);
  await page.getByRole('button',{name:'Add your first note'}).click();
  await page.locator('affine-edgeless-note').dblclick({position:{x:50,y:45}});
  await expect(page.locator('rich-text [contenteditable=true]')).toBeVisible();
  await page.keyboard.type('Capture this thought');await page.keyboard.press('Escape');
  await expect.poll(()=>page.evaluate(()=> (window.__brainzBoard as any).editor.doc.getBlocksByFlavour('affine:paragraph').map((b:any)=>b.model.text.toString()))).toContain('Capture this thought');
  await page.mouse.click(950,650);
  const before=await state(page);
  await page.screenshot({path:test.info().outputPath('before-capture.png')});
  await page.getByRole('button',{name:'Capture area',exact:true}).click();
  await page.mouse.move(420,300);await page.mouse.down();await page.mouse.move(880,670,{steps:15});await page.mouse.up();
  await expect.poll(()=>page.evaluate(()=>window.__messages.some(m=>m.type==='copyImage'))).toBe(true);
  const png=await page.evaluate(()=>window.__messages.find(m=>m.type==='copyImage').png);
  await writeFile(test.info().outputPath('sticky-capture.png'),Buffer.from(png,'base64'));
  await test.info().attach('Sticky note capture',{body:Buffer.from(png,'base64'),contentType:'image/png'});
  expect(await state(page)).toEqual(before);
});


test('the canvas picker attaches a fresh board after opening and an already open board',async({page})=>{
  await openBoard(page);
  await expect(page.getByRole('button',{name:'Use in chat',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'Add your first note'}).click();
  await page.locator('affine-edgeless-note').dblclick({position:{x:50,y:45}});
  await page.keyboard.type('Picker context'); await page.keyboard.press('Escape');
  await expect(page.locator('#save-state')).toHaveText('Saved locally');
  await page.evaluate(()=>localStorage.setItem('test-attach','true'));
  await page.reload();
  await expect.poll(()=>page.evaluate(()=>window.__messages.filter(message=>message.type==='attachToChat').length)).toBe(1);
  const first=await page.evaluate(()=>window.__messages.find(message=>message.type==='attachToChat'));
  expect(first.scene.objects.some((object:any)=>object.text==='Picker context')).toBe(true);
  expect(Buffer.from(first.png,'base64').subarray(1,4).toString()).toBe('PNG');
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('brainz',{detail:{type:'attach'}})));
  await expect.poll(()=>page.evaluate(()=>window.__messages.filter(message=>message.type==='attachToChat').length)).toBe(2);
});

test('Copy link confirms clipboard success briefly in the toolbar',async({page})=>{
  await openBoard(page);
  const button=page.getByRole('button',{name:'Copy link',exact:true});
  const width=await button.evaluate(element=>element.getBoundingClientRect().width);
  await button.click();
  await expect(button).toHaveText('Copy link');
  const link=await page.evaluate(()=>window.__messages.filter(message=>message.type==='copy').at(-1).text);
  expect(new URL(link).searchParams.get('path')).toBe('/tmp/Brainz test.board.brainzboard');
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('brainz',{detail:{type:'notice',message:'Link copied'}})));
  const copied=page.getByRole('button',{name:'Copied',exact:true});
  await expect(copied).toHaveClass(/copied/);
  expect(await copied.evaluate(element=>element.getBoundingClientRect().width)).toBe(width);
  await expect(page.getByRole('status').filter({hasText:'Link copied'})).toBeVisible();
  await expect(button).toBeVisible({timeout:4000});
  await expect(button).not.toHaveClass(/copied/);
});
