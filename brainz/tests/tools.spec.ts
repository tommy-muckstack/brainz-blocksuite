import { test, expect, type Page } from '@playwright/test';

async function open(page:Page) {
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
}

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
