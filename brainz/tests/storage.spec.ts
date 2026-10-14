import { test, expect, type Page } from '@playwright/test';

async function openStorageBoard(page: Page) {
  await page.addInitScript(() => {
    const state = window as any; state.__messages = [];
    const respond = (message: unknown) => queueMicrotask(()=>window.dispatchEvent(new CustomEvent('brainz',{detail:message})));
    const load = () => JSON.parse(localStorage.getItem('storage-board') ?? 'null');
    const write = (document: unknown) => localStorage.setItem('storage-board',JSON.stringify(document));
    const acknowledge = (revision: number) => respond({type:'saved',revision,storage:load()?.version===2 ? {version:2,stamp:String(load().updates?.length ?? 0)} : undefined});
    const fetch = window.fetch.bind(window);
    window.fetch = (async(input:RequestInfo|URL,init?:RequestInit) => {
      const url = String(input);
      if (!url.startsWith('brainz-board://app/board-assets/')) return fetch(input,init);
      const source = decodeURIComponent(url.split('/').at(-1)!);
      const asset = JSON.parse(localStorage.getItem('storage-assets') ?? '{}')[source];
      return asset ? new Response(Uint8Array.from(atob(asset.data),character=>character.charCodeAt(0)),{headers:{'Content-Type':asset.mime}}) : new Response(null,{status:404});
    }) as typeof window.fetch;
    window.ipc = {postMessage(value:string) {
      const message = JSON.parse(value); state.__messages.push(message);
      if (message.type==='ready') respond({type:'load',document:load(),target:{path:'/brain/Projects/Plan.brainzboard'},incrementalStorage:localStorage.getItem('storage-enabled')==='true',agentEnabled:true});
      if (message.type==='save') { write(message.document); acknowledge(message.revision); }
      if (message.type==='migrateStorage') {
        localStorage.setItem('storage-backup',JSON.stringify(message.document));
        localStorage.setItem('storage-assets',JSON.stringify(message.document.images ?? {}));
        const assets = Object.fromEntries(Object.entries(message.document.images ?? {}).map(([id,asset]:[string,any])=>[id,{mime:asset.mime,bytes:atob(asset.data).length}]));
        write({...message.document,version:2,images:undefined,assets,updates:[]}); acknowledge(message.revision);
      }
      if (message.type==='appendUpdate') { const document=load(); if (message.update) document.updates.push(message.update); document.title=message.title; write(document); acknowledge(message.revision); }
      if (message.type==='compactStorage') { const document=load(); document.data=message.snapshot; document.updates=[]; write(document); }
      if (message.type==='putAsset') void(async()=>{
        const bytes=Uint8Array.from(atob(message.data),character=>character.charCodeAt(0));
        const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
        const assets=JSON.parse(localStorage.getItem('storage-assets') ?? '{}'); assets[hash]={data:message.data,mime:message.mime}; localStorage.setItem('storage-assets',JSON.stringify(assets));
        const document=load(); document.assets[hash]={mime:message.mime,bytes:bytes.length}; write(document); respond({type:'assetStored',requestId:message.requestId,hash});
      })();
      if (message.type==='saveContext') localStorage.setItem('storage-context',JSON.stringify(message.context));
    }};
  });
  await page.goto('/'); await page.waitForFunction(()=>Boolean(window.__brainzBoard));
}

test('Legacy canvas migrates with text, connections and images, then reopens without rewriting its content',async({page})=>{
  await openStorageBoard(page);
  await page.evaluate(async()=>{
    const board=window.__brainzBoard as any;
    board.agent.allowDirect=true;
    board.agent.submit({format:'brainz-canvas-ops',version:1,batchId:'storage-fixture',actor:'agent:test',mode:'direct',ops:[
      {op:'create',type:'shape',ref:'$source',text:'Start',at:[0,0],size:[180,100]},
      {op:'create',type:'shape',ref:'$target',text:'Finish',at:[300,0],size:[180,100]},
      {op:'connect',from:'$source',to:'$target',label:'Then'},
    ]});
    const sourceId='legacy-picture'; const canvas=document.createElement('canvas'); canvas.width=120; canvas.height=120; canvas.getContext('2d')!.fillRect(0,0,120,120); const data=canvas.toDataURL('image/png').split(',')[1];
    const envelope=board.snapshot();
    envelope.images={[sourceId]:{mime:'image/png',data}};
    board.editor.doc.addBlock('affine:image',{sourceId,size:68,width:120,height:120,xywh:'[0,180,120,120]'},board.service.surface);
    envelope.data=btoa(String.fromCharCode(...board.Y.encodeStateAsUpdate(board.editor.doc.spaceDoc)));
    // Preserve the image fixture in the original envelope after the UI's queued save.
    await new Promise(resolve=>setTimeout(resolve,300));
    localStorage.setItem('storage-board',JSON.stringify(envelope)); localStorage.setItem('storage-enabled','true');
  });
  await page.reload(); await page.waitForFunction(()=>Boolean(window.__brainzBoard));
  await expect(page.locator('#save-state')).toHaveText('Saved locally');
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('storage-backup')!).version)).toBe(1);
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('storage-board')!).version)).toBe(2);
  const before = await page.evaluate(()=>{
    const board=window.__brainzBoard as any;
    return board.service.edgelessElements.map((element:any)=>({id:element.id,type:element.type,text:element.text?.toString(),source:element.source,target:element.target,sourceId:element.sourceId}));
  });
  expect(before).toHaveLength(4);
  expect(before.filter((element:any)=>element.type==='connector')).toHaveLength(1);
  await page.reload(); await page.waitForFunction(()=>Boolean(window.__brainzBoard)); await page.waitForTimeout(1200);
  expect(await page.evaluate(()=>{
    const board=window.__brainzBoard as any;
    return board.service.edgelessElements.map((element:any)=>({id:element.id,type:element.type,text:element.text?.toString(),source:element.source,target:element.target,sourceId:element.sourceId}));
  })).toEqual(before);
  expect(await page.evaluate(()=>(window as any).__messages.filter((message:any)=>['save','migrateStorage','appendUpdate'].includes(message.type)))).toEqual([]);
  await page.evaluate(()=>{
    const board=window.__brainzBoard as any; const source=board.service.edgelessElements.find((element:any)=>element.text?.toString()==='Start');
    source.text.insert(5,' here');
  });
  await expect.poll(()=>page.evaluate(()=>(window as any).__messages.filter((message:any)=>message.type==='appendUpdate').length)).toBeGreaterThan(0);
  const edits = await page.evaluate(()=>(window as any).__messages.filter((message:any)=>['save','migrateStorage','appendUpdate'].includes(message.type)));
  expect(edits.every((message:any)=>message.type==='appendUpdate')).toBe(true); expect(JSON.stringify(edits).length).toBeLessThan(65536);
  await page.reload(); await page.waitForFunction(()=>Boolean(window.__brainzBoard));
  expect(await page.evaluate(()=>(window.__brainzBoard as any).service.edgelessElements.some((element:any)=>element.text?.toString()==='Start here'))).toBe(true);
});

test('Images are saved before their blocks, survive reopening, and never enter later edit payloads',async({page})=>{
  await openStorageBoard(page);
  await page.evaluate(()=>localStorage.setItem('storage-enabled','true')); await page.reload(); await page.waitForFunction(()=>Boolean(window.__brainzBoard));
  await page.evaluate(()=>{
    const canvas=document.createElement('canvas'); canvas.width=120; canvas.height=120; canvas.getContext('2d')!.fillRect(0,0,120,120);
    window.dispatchEvent(new CustomEvent('brainz',{detail:{type:'files',files:[{title:'Picture',url:'file:///brain/picture.png',image:{mime:'image/png',data:canvas.toDataURL('image/png').split(',')[1]}}]}}));
  });
  await expect.poll(()=>page.evaluate(()=>(window.__brainzBoard as any).service.edgelessElements.filter((element:any)=>element.flavour==='affine:image').length)).toBe(1);
  await expect(page.locator('#save-state')).toHaveText('Saved locally');
  const source = await page.evaluate(()=>(window.__brainzBoard as any).service.edgelessElements.find((element:any)=>element.flavour==='affine:image').sourceId);
  expect(source).toMatch(/^[a-f0-9]{64}$/);
  const document = await page.evaluate(()=>JSON.parse(localStorage.getItem('storage-board')!)); expect(document.images).toBeUndefined(); expect(document.assets[source]).toBeTruthy();
  await page.reload(); await page.waitForFunction(()=>Boolean(window.__brainzBoard));
  expect(await page.evaluate(()=>(window.__brainzBoard as any).service.edgelessElements.find((element:any)=>element.flavour==='affine:image').sourceId)).toBe(source);
  await page.evaluate(()=>{(window as any).__messages=[];const {service}=window.__brainzBoard as any;service.gfx.updateElement(service.edgelessElements[0],{xywh:'[100,200,120,120]'});});
  await expect.poll(()=>page.evaluate(()=>(window as any).__messages.filter((message:any)=>message.type==='appendUpdate').length)).toBeGreaterThan(0);
  expect(await page.evaluate(()=>(window as any).__messages.some((message:any)=>message.type==='putAsset' || message.document?.images))).toBe(false);
});
