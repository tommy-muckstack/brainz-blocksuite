import { test, expect, type Page } from '@playwright/test';

async function open(page:Page,expandTools=true) {
  await page.addInitScript(()=>{
    (window as any).__messages=[];
    window.ipc={postMessage(value:string){
      const message=JSON.parse(value);(window as any).__messages.push(message);
      const send=(detail:unknown)=>queueMicrotask(()=>window.dispatchEvent(new CustomEvent('brainz',{detail})));
      if(message.type==='ready')send({type:'load',document:JSON.parse(localStorage.getItem('tools-board') ?? 'null'),target:{path:'/brain/Tools.brainzboard'},agentEnabled:true});
      if(message.type==='save'){localStorage.setItem('tools-board',JSON.stringify(message.document));send({type:'saved',revision:message.revision});}
      if(message.type==='recognizeImage')send({type:'imageText',objectId:message.objectId,sourceId:message.sourceId,text:'Text from the screenshot'});
    }};
  });
  await page.goto('/');await page.waitForFunction(()=>Boolean((window.__brainzBoard as any)?.canvasTools));
  if(expandTools) await page.locator('#tools-toggle').click();
}

test('Drawing tools expand on hover and shortcut labels appear only for the hovered tool',async({page})=>{
  await open(page,false);
  const tray=page.locator('.tools');
  await expect(tray).not.toHaveClass(/expanded/);
  await expect(page.locator('#tools-toggle')).toHaveAttribute('aria-expanded','false');
  await page.locator('#tools-toggle').hover();
  await expect(tray).toHaveClass(/expanded/);
  await page.getByRole('button',{name:'Pan',exact:true}).hover();
  await expect(page.getByRole('button',{name:'Pan',exact:true}).locator('.tooltip')).toBeVisible();
  await expect(page.getByRole('button',{name:'Pan',exact:true}).locator('.tooltip kbd')).toHaveText('H');
  await expect(page.getByRole('button',{name:'Select',exact:true}).locator('.tooltip')).toBeHidden();
  await expect.poll(()=>page.locator('.tools').evaluate(element=>Math.round(element.getBoundingClientRect().height))).toBe(515);
  await page.screenshot({path:test.info().outputPath('drawing-tools-expanded.png')});
  await page.mouse.move(500,400);
  await expect(tray).not.toHaveClass(/expanded/);
});

test('Command C and Command V duplicate a selected canvas shape',async({page,context})=>{
  await context.grantPermissions(['clipboard-read','clipboard-write']);
  await open(page);
  await page.getByRole('button',{name:'Box',exact:true}).click();
  await page.mouse.move(350,250);await page.mouse.down();await page.mouse.move(510,360,{steps:10});await page.mouse.up();
  await expect.poll(()=>page.evaluate(()=>(window.__brainzBoard as any).service.edgelessElements.filter((element:any)=>element.type==='shape').length)).toBe(1);
  await page.mouse.click(420,300);
  await page.keyboard.press('Meta+c');
  await expect.poll(()=>page.evaluate(async()=>{
    const items=await navigator.clipboard.read();
    return items[0]?.types.includes('text/html') && (await (await items[0].getType('text/html')).text()).includes('data-blocksuite-snapshot');
  })).toBe(true);
  await page.keyboard.press('Meta+v');
  await expect.poll(()=>page.evaluate(()=>(window.__brainzBoard as any).service.edgelessElements.filter((element:any)=>element.type==='shape').length)).toBe(2);
});

test('Dragging a box to its neighbor shows a snap cue and still allows pulling through',async({page})=>{
  await open(page);
  for(const [left,right] of [[300,430],[630,760]]) {
    await page.getByRole('button',{name:'Box',exact:true}).click();
    await page.mouse.move(left,250);await page.mouse.down();await page.mouse.move(right,350,{steps:10});await page.mouse.up();
  }
  await page.mouse.move(695,300);await page.mouse.down();
  await page.mouse.move(498,300,{steps:16});
  await expect(page.locator('.canvas-snap-feedback')).toHaveClass(/active/);
  await page.screenshot({path:test.info().outputPath('aligned-boxes.png')});
  const aligned=await page.evaluate(()=>(window.__brainzBoard as any).service.edgelessElements.filter((element:any)=>element.type==='shape').map((element:any)=>JSON.parse(element.xywh)).sort((a:any,b:any)=>a[0]-b[0]));
  expect(aligned[1][0]).toBeCloseTo(aligned[0][0]+aligned[0][2],0);
  await page.mouse.move(455,300,{steps:8});
  await expect(page.locator('.canvas-snap-feedback')).not.toHaveClass(/active/);
  await page.mouse.up();
});

test('Tool shortcuts select every drawing mode; laser trails never change the document',async({page})=>{
  await open(page);
  for(const [key,button] of [['e','Eraser'],['f','Frame'],['l','Lasso'],['o','Ellipse'],['d','Diamond'],['k','Laser'],['h','Pan'],['p','Draw'],['a','Connector'],['v','Select']]) {
    await page.keyboard.press(key);await expect(page.getByRole('button',{name:button,exact:true})).toHaveAttribute('aria-pressed','true');
  }
  const before=await page.evaluate(()=>localStorage.getItem('tools-board'));
  await page.keyboard.press('k');await page.mouse.move(350,280);await page.mouse.move(650,420,{steps:30});await page.waitForTimeout(700);
  expect(await page.evaluate(()=>localStorage.getItem('tools-board'))).toBe(before);
  await page.keyboard.press('Escape');await expect(page.locator('#canvas-laser')).toBeHidden();
  await page.keyboard.press('Shift+r');await expect.poll(()=>page.evaluate(()=>(window.__brainzBoard as any).service.gfx.tool.currentTool$.peek()?.activatedOption?.shapeName)).toBe('triangle');
});

test('New shapes take typed labels and the searchable palette frames a selection',async({page})=>{
  await open(page);await page.getByRole('button',{name:'Box',exact:true}).click();
  await page.mouse.move(320,230);await page.mouse.down();await page.mouse.move(520,360,{steps:12});await page.mouse.up();
  await expect(page.getByRole('button',{name:'Select',exact:true})).toHaveAttribute('aria-pressed','true');
  await page.keyboard.type('abc');
  await expect.poll(()=>page.evaluate(()=>(window.__brainzBoard as any).service.edgelessElements.find((element:any)=>element.type==='shape')?.text?.toString())).toBe('abc');
  await page.keyboard.press('Escape');await page.keyboard.press('Meta+k');
  await page.getByRole('combobox',{name:'Find a canvas command'}).fill('frm');
  await expect(page.getByRole('option').first()).toContainText('Frame');await expect(page.getByRole('option').first().locator('kbd')).toHaveText('F');
  await page.screenshot({path:test.info().outputPath('commands.png')});
  await page.keyboard.press('Enter');await expect(page.getByRole('dialog',{name:'Canvas commands'})).toBeHidden();
  await expect.poll(()=>page.evaluate(()=>(window.__brainzBoard as any).service.frames.length)).toBe(1);
});

test('Tab creates evenly spaced stickies while typing and command Enter finishes editing',async({page})=>{
  await open(page);await page.keyboard.press('n');await page.mouse.click(310,250);
  await expect.poll(()=>page.evaluate(()=>(window.__brainzBoard as any).service.selection.editing)).toBe(true);
  await page.keyboard.type('one');await page.keyboard.press('Tab');await page.keyboard.type('two');await page.keyboard.press('Tab');await page.keyboard.type('three');
  await page.keyboard.press('Meta+Enter');
  const notes=await page.evaluate(()=>(window.__brainzBoard as any).service.edgelessElements.filter((element:any)=>element.flavour==='affine:note').map((note:any)=>({text:note.children.map((child:any)=>child.text?.toString() ?? '').join(''),box:JSON.parse(note.xywh)})));
  expect(notes.map((note:any)=>note.text)).toEqual(['one','two','three']);
  expect(notes[1].box[0]-notes[0].box[0]).toBeCloseTo(notes[0].box[2]+24);
  expect(notes[2].box[0]-notes[1].box[0]).toBeCloseTo(notes[1].box[2]+24);
  expect(await page.evaluate(()=>(window.__brainzBoard as any).service.selection.editing)).toBe(false);
  await page.screenshot({path:test.info().outputPath('sticky-row.png')});
});

test('Locking a creation tool keeps it active, and typing in a title never triggers drawing shortcuts',async({page})=>{
  await open(page);await page.keyboard.press('r');await page.keyboard.press('q');
  for(const x of [300,620]) {await page.mouse.move(x,240);await page.mouse.down();await page.mouse.move(x+180,350,{steps:8});await page.mouse.up();await expect(page.getByRole('button',{name:'Box',exact:true})).toHaveAttribute('aria-pressed','true');}
  expect(await page.evaluate(()=>(window.__brainzBoard as any).service.edgelessElements.filter((element:any)=>element.type==='shape').length)).toBe(2);
  await page.getByRole('button',{name:'Keep tool active'}).click();await page.getByRole('button',{name:'Select',exact:true}).click();
  const title=page.getByRole('textbox',{name:'Board name'});await title.fill('');await title.pressSequentially('neat framework');
  await expect(title).toHaveValue('neat framework');await expect(page.getByRole('button',{name:'Select',exact:true})).toHaveAttribute('aria-pressed','true');
});

test('A mind map starts with an editable root and keeps Tab child and Enter sibling behavior',async({page})=>{
  await open(page);await page.keyboard.press('m');await page.keyboard.type('Project');await page.keyboard.press('Tab');await page.keyboard.type('First');await page.keyboard.press('Enter');await page.keyboard.type('Second');await page.keyboard.press('Escape');
  const labels=await page.evaluate(()=>(window.__brainzBoard as any).service.edgelessElements.filter((element:any)=>element.type==='shape').map((element:any)=>element.text?.toString()));
  expect(labels).toEqual(expect.arrayContaining(['Project','First','Second']));
});

test('Pasting a screenshot creates a persistent image with locally recognized text in assistant context',async({page})=>{
  await open(page);
  await page.evaluate(async()=>{
    const canvas=document.createElement('canvas');canvas.width=180;canvas.height=100;canvas.getContext('2d')!.fillText('Screenshot',12,30);
    const blob=await new Promise<Blob>(resolve=>canvas.toBlob(blob=>resolve(blob!),'image/png'));
    const transfer=new DataTransfer();transfer.items.add(new File([blob],'clipboard.png',{type:'image/png'}));
    document.dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true}));
  });
  await expect(page.locator('affine-edgeless-image img')).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>(window.__brainzBoard as any).agent.read().objects.find((object:any)=>object.kind==='image')?.image?.ocr)).toBe('Text from the screenshot');
  await expect(page.locator('#save-state')).toHaveText('Saved locally');await page.reload();await page.waitForFunction(()=>Boolean(window.__brainzBoard));
  await expect(page.locator('affine-edgeless-image img')).toBeVisible();
  expect(await page.evaluate(()=>(window.__brainzBoard as any).agent.read().objects.find((object:any)=>object.kind==='image')?.image?.ocr)).toBe('Text from the screenshot');
});

test('A screenshot omitted from the WebView paste event uses the native clipboard',async({page})=>{
  await open(page);
  await page.evaluate(()=>{
    const canvas=document.createElement('canvas');canvas.width=120;canvas.height=80;canvas.getContext('2d')!.fillRect(0,0,120,80);
    const image=canvas.toDataURL('image/png').split(',')[1];
    const ipc=window.ipc!;
    window.ipc={postMessage(value:string){
      const message=JSON.parse(value);
      if(message.type==='pasteClipboard') queueMicrotask(()=>window.dispatchEvent(new CustomEvent('brainz',{detail:{type:'pasteImage',position:message.position,mime:'image/png',data:image}})));
      else ipc.postMessage(value);
    }};
    document.dispatchEvent(new ClipboardEvent('paste',{clipboardData:new DataTransfer(),bubbles:true,cancelable:true}));
  });
  await expect(page.locator('affine-edgeless-image img')).toBeVisible();
  expect(await page.evaluate(()=>(window.__brainzBoard as any).service.edgelessElements.filter((element:any)=>element.flavour==='affine:image').length)).toBe(1);
});

test('Quick-create dots connect new shapes and stickies, focus text, and offer keyboard choices after a drag',async({page})=>{
  await open(page);
  await page.keyboard.press('n');await page.mouse.click(330,240);await page.keyboard.type('First');await page.keyboard.press('Meta+Enter');
  const right=page.getByRole('button',{name:'Add connected object right',exact:true});
  await expect(right).toBeVisible();
  await expect(page.locator('edgeless-auto-complete .edgeless-auto-complete-arrow')).toHaveCount(4);
  await right.click();await page.keyboard.type('Second');
  await expect.poll(()=>page.evaluate(()=>{const {service}=window.__brainzBoard as any;return service.edgelessElements.filter((element:any)=>element.flavour==='affine:note').map((note:any)=>note.children.map((child:any)=>child.text?.toString()??'').join(''));})).toEqual(['First','Second']);
  await expect.poll(()=>page.evaluate(()=>(window.__brainzBoard as any).service.edgelessElements.filter((element:any)=>element.type==='connector' && element.source.id && element.target.id).length)).toBe(1);
  await page.keyboard.press('Meta+Enter');
  const below=page.getByRole('button',{name:'Add connected object below',exact:true});const bounds=await below.boundingBox();
  await page.mouse.move(bounds!.x+bounds!.width/2,bounds!.y+bounds!.height/2);await page.mouse.down();await page.mouse.move(bounds!.x+100,bounds!.y+160,{steps:12});await page.mouse.up();
  await expect(page.locator('edgeless-auto-complete-panel .auto-complete-panel-container')).toBeVisible();await page.keyboard.press('6');
  await page.keyboard.type('Decision');
  await expect.poll(()=>page.evaluate(()=>(window.__brainzBoard as any).service.edgelessElements.find((element:any)=>element.type==='shape')?.text?.toString())).toBe('Decision');
  expect(await page.evaluate(()=>(window.__brainzBoard as any).service.edgelessElements.find((element:any)=>element.type==='shape')?.shapeType)).toBe('diamond');
  await page.keyboard.press('Escape');await page.screenshot({path:test.info().outputPath('quick-create.png')});
  await page.locator('#save-state').dispatchEvent('click');await expect(page.locator('#save-state')).toContainText('Saved');await page.reload();await page.waitForFunction(()=>Boolean(window.__brainzBoard));
  expect(await page.evaluate(()=>(window.__brainzBoard as any).service.edgelessElements.find((element:any)=>element.type==='shape')?.text?.toString())).toBe('Decision');
});

test('Sticky Auto sizing keeps its bounds, persists explicit sizing, and restores it on reopen',async({page})=>{
  await open(page);await page.keyboard.press('n');await page.mouse.click(400,280);await page.keyboard.type('A longer sticky note. '.repeat(24));await page.keyboard.press('Meta+Enter');
  const note=page.locator('affine-edgeless-note');
  await expect.poll(()=>note.evaluate(element=>parseFloat(getComputedStyle(element).getPropertyValue('--brainz-sticky-font-size')))).toBeLessThan(28);
  expect(await note.evaluate((element:any)=>JSON.parse(element.model.xywh).slice(2))).toEqual([280,200]);
  await page.getByRole('combobox',{name:'Sticky text size'}).selectOption('14');
  await expect.poll(()=>note.evaluate(element=>getComputedStyle(element).getPropertyValue('--brainz-sticky-font-size'))).toBe('14px');
  await page.locator('#save-state').dispatchEvent('click');await expect(page.locator('#save-state')).toContainText('Saved');await page.reload();await page.waitForFunction(()=>Boolean(window.__brainzBoard));
  await expect.poll(()=>note.evaluate(element=>getComputedStyle(element).getPropertyValue('--brainz-sticky-font-size'))).toBe('14px');
});

test('Selection actions use one toolbar and links stay nonmodal; shortcuts and context menu share commands',async({page})=>{
  await open(page);
  await page.locator('#add-link').click();await page.locator('#link-url').fill('brainz://open?path=%2Fbrain%2FPlan.md');await page.locator('#link-title').fill('Plan');
  expect(await page.locator('#link-dialog').evaluate(element=>element.matches(':modal'))).toBe(false);
  await page.getByRole('button',{name:'Add to canvas',exact:true}).click();
  await expect(page.locator('.selection-bar')).toHaveCount(0);
  await page.keyboard.press('Meta+k');await page.getByRole('combobox',{name:'Find a canvas command'}).fill('Open linked');await page.keyboard.press('Enter');
  expect(await page.evaluate(()=>(window as any).__messages.some((message:any)=>message.type==='open' && message.url.includes('Plan.md')))).toBe(true);
  await page.keyboard.press('?');await expect(page.getByRole('dialog',{name:'Canvas shortcuts'})).toBeVisible();await page.keyboard.press('Escape');
  await page.mouse.click(700,550,{button:'right'});await expect(page.locator('.canvas-command-panel')).toHaveAttribute('data-mode','context');
  await page.getByRole('combobox',{name:'Find a canvas command'}).fill('laser');await page.keyboard.press('Enter');await expect(page.locator('#canvas-laser')).toBeVisible();
});

test('Quick-created shapes copy their style, keep original labels, and undo the new shape and connector together',async({page})=>{
  await open(page);await page.keyboard.press('r');await page.mouse.move(300,240);await page.mouse.down();await page.mouse.move(490,360,{steps:8});await page.mouse.up();await page.keyboard.type('Start');await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'Add connected object right',exact:true}).click();await page.keyboard.type('Next');await page.keyboard.press('Escape');
  const shapes=await page.evaluate(()=>(window.__brainzBoard as any).service.edgelessElements.filter((element:any)=>element.type==='shape').map((element:any)=>({id:element.id,text:element.text?.toString(),fill:element.fillColor,font:element.fontFamily})));
  expect(shapes.map((shape:any)=>shape.text)).toEqual(['Start','Next']);expect(shapes[0].id).not.toBe(shapes[1].id);expect(shapes[1].fill).toEqual(shapes[0].fill);expect(shapes[1].font).toBe(shapes[0].font);
  await page.locator('#undo').click();await page.locator('#undo').click();
  await expect.poll(()=>page.evaluate(()=>(window.__brainzBoard as any).service.edgelessElements.length)).toBe(1);
});

test('Connectors bind inside a box and reroute before the drag ends; Command disables alignment snapping',async({page})=>{
  await open(page);
  for(const [x,y] of [[330,240],[730,360]]) {await page.getByRole('button',{name:'Box',exact:true}).click();await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+180,y+100,{steps:8});await page.mouse.up();}
  await page.getByRole('button',{name:'Connector',exact:true}).click();await page.mouse.move(420,290);await page.mouse.down();await page.mouse.move(815,410,{steps:12});await page.mouse.up();
  const original=await page.evaluate(()=>{const element=(window.__brainzBoard as any).service.edgelessElements.find((element:any)=>element.type==='connector');return {source:element.source,target:element.target,path:element.absolutePath.map((point:any)=>[point[0],point[1]])};});
  expect(original.source.id).toBeTruthy();expect(original.target.id).toBeTruthy();
  await page.getByRole('button',{name:'Select',exact:true}).click();await page.mouse.move(810,400);await page.mouse.down();await page.keyboard.down('Meta');await page.mouse.move(858,496,{steps:12});
  expect(await page.evaluate(()=>globalThis.__brainzSuppressSnap)).toBe(true);
  const during=await page.evaluate(()=>{const element=(window.__brainzBoard as any).service.edgelessElements.find((element:any)=>element.type==='connector');return {source:element.source,target:element.target,path:element.absolutePath.map((point:any)=>[point[0],point[1]])};});
  expect(during.source.id).toBe(original.source.id);expect(during.target.id).toBe(original.target.id);expect(during.path).not.toEqual(original.path);
  await page.mouse.up();await page.keyboard.up('Meta');expect(await page.evaluate(()=>globalThis.__brainzSuppressSnap)).toBe(false);
});
