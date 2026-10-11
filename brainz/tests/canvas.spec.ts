import { test, expect, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

declare global { interface Window { __messages: any[]; __stored: any; __target: any } }
async function openBoard(page: Page) {
  await page.addInitScript(() => {
    window.__messages=[];
    window.__target={path:'/tmp/Brainz test.board.brainzboard'};
    window.ipc={postMessage(value:string){
      const message=JSON.parse(value);window.__messages.push(message);
      if(message.type==='ready') queueMicrotask(()=>window.dispatchEvent(new CustomEvent('brainz',{detail:{type:'load',document:JSON.parse(localStorage.getItem('test-board') || 'null'),target:window.__target}})));
      if(message.type==='save') {localStorage.setItem('test-board',JSON.stringify(message.document));queueMicrotask(()=>window.dispatchEvent(new CustomEvent('brainz',{detail:{type:'saved',revision:message.revision}})));}
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
  await page.getByRole('button',{name:'Open',exact:true}).click();
  expect(await page.evaluate(()=>window.__messages.find(m=>m.type==='open').url)).toBe('file:///tmp/Plan.md');
  await page.getByRole('button',{name:'Copy object link',exact:true}).click();
  const link=await page.evaluate(()=>window.__messages.find(m=>m.type==='copy').text);
  const url=new URL(link);expect(url.protocol).toBe('brainz:');expect(url.searchParams.get('path')).toBe('/tmp/Brainz test.board.brainzboard');
  const id=url.searchParams.get('object');expect(id).toBeTruthy();
  await page.reload();await page.waitForFunction(()=>Boolean(window.__brainzBoard));
  await page.evaluate(object=>window.dispatchEvent(new CustomEvent('brainz',{detail:{type:'focus',target:{path:'/tmp/Brainz test.board.brainzboard',object}}})),id);
  await expect(page.getByRole('button',{name:'Open',exact:true})).toBeVisible();
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
