import { test, expect, type Page } from '@playwright/test';

const batch = (ops: Record<string, unknown>[], extra = {}) => ({ format: 'brainz-canvas-ops', version: 1, batchId: 'agent-test', actor: 'agent:Claude', ops, ...extra });
async function open(page: Page) {
  await page.addInitScript(() => {
    window.ipc = { postMessage(value: string) {
      const message = JSON.parse(value);
      if (message.type === 'ready') queueMicrotask(() => window.dispatchEvent(new CustomEvent('brainz', { detail: { type: 'load', document: null, target: { path: '/brain/Ideas.brainzboard' }, workspace: '/brain', agentEnabled: true } })));
      if (message.type === 'save') queueMicrotask(() => window.dispatchEvent(new CustomEvent('brainz', { detail: { type: 'saved', revision: message.revision } })));
    } };
  });
  await page.goto('/'); await page.waitForFunction(() => Boolean((window.__brainzBoard as any)?.agent));
}
const objects = (page: Page) => page.evaluate(() => (window.__brainzBoard as any).agent.objects());
const submit = (page: Page, value: unknown) => page.evaluate(value => (window.__brainzBoard as any).agent.submit(value), value);

test('Agent proposals leave the original canvas untouched until Apply, with one undo and stable redo ids', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await open(page);
  const proposal = batch([
    { op: 'create', type: 'sticky', ref: '$a', text: 'Read the proposal', at: [-250, 0] },
    { op: 'create', type: 'shape', ref: '$b', text: 'Approve?', shape: 'diamond', at: [180, 0] },
    { op: 'connect', ref: '$edge', from: '$a', to: '$b', label: 'Review' },
  ]);
  expect((await submit(page, proposal)).status).toBe('staged');
  expect(await objects(page)).toEqual([]);
  await expect(page.getByRole('region', { name: 'Review proposed canvas changes' })).toBeVisible();
  await expect(page.locator('#empty')).toBeHidden();
  await expect(page.locator('.agent-preview polygon')).toHaveCount(1);
  await expect(page.locator('.agent-preview path[marker-end]')).toHaveCount(1);
  await page.screenshot({path:test.info().outputPath('staged-canvas-proposal.png')});
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  const applied = await objects(page); expect(applied).toHaveLength(3);
  expect(applied.find((object: any) => object.kind === 'connector')).toMatchObject({ from: applied.find((object: any) => object.kind === 'sticky').id, to: applied.find((object: any) => object.kind === 'shape').id });
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); expect(await objects(page)).toEqual([]);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  expect((await objects(page)).map((object: any) => object.id).sort()).toEqual(applied.map((object: any) => object.id).sort());
  expect(errors).toEqual([]);
});

test('Discard and invalid batches preserve existing content; intervening user edits win', async ({ page }) => {
  await open(page);
  await submit(page, batch([{ op: 'create', type: 'shape', text: 'Original', ref: '$original' }]));
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  const original = (await objects(page))[0];
  await submit(page, batch([{ op: 'update', id: original.id, ifVersion: original.version, set: { text: 'Proposal' } }], { batchId: 'discard' }));
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  expect(await objects(page)).toEqual([original]);
  const rejected = await submit(page, batch([{ op: 'delete', ids: [original.id] }, { op: 'create', type: 'unknown' }], { batchId: 'invalid' }));
  expect(rejected.status).toBe('rejected'); expect(await objects(page)).toEqual([original]);
  await submit(page, batch([{ op: 'update', id: original.id, set: { text: 'Agent text' } }], { batchId: 'conflict' }));
  await page.evaluate(id => { const { service } = window.__brainzBoard as any; service.gfx.updateElement(id, { xywh: '[30,40,240,120]' }); }, original.id);
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  expect((await objects(page))[0]).toMatchObject({ text: 'Original', xywh: [30, 40, 240, 120] });
  expect(await page.evaluate(() => (window.__brainzBoard as any).agent.status('conflict').status)).toBe('rejected');
});

test('Direct changes require a user setting and repeated batch ids are idempotent', async ({ page }) => {
  await open(page);
  const proposal = batch([{ op: 'create', type: 'shape', text: 'Direct' }], { mode: 'direct' });
  expect((await submit(page, proposal)).status).toBe('rejected'); expect(await objects(page)).toEqual([]);
  await page.getByLabel('Canvas options').click(); await page.getByLabel('Allow direct agent edits').check();
  expect((await submit(page, proposal)).status).toBe('applied');
  expect((await submit(page, proposal)).status).toBe('applied'); expect(await objects(page)).toHaveLength(1);
});

test('Read context separates offscreen objects and exposes versions and explicit connections', async ({ page }) => {
  await open(page);
  await submit(page, batch([
    { op: 'create', type: 'shape', text: 'Visible', at: [-100, -100], ref: '$a' },
    { op: 'create', type: 'sticky', text: 'Offscreen', at: [8000, 8000], ref: '$b' },
    { op: 'connect', from: '$a', to: '$b', label: 'depends on' },
  ]));
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  const context = await page.evaluate(() => (window.__brainzBoard as any).agent.read());
  expect(context.version).toBe(2);
  expect(context.inView.some((object: any) => object.text === 'Offscreen')).toBe(false);
  expect(context.offscreenClusters.some((cluster: any) => cluster.sample.includes('Offscreen'))).toBe(true);
  expect(context.connections[0].label).toBe('depends on');
  expect(context.objects.every((object: any) => typeof object.version === 'string' && object.version.length > 0)).toBe(true);
});

test('A valid external Yjs edit merges with local geometry without losing either edit', async ({ page }) => {
  await open(page);
  await submit(page, batch([{ op: 'create', type: 'sticky', text: 'Original', ref: '$note' }]));
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  const expected = await page.evaluate(async () => {
    const { editor, service, snapshot, Y } = window.__brainzBoard as any;
    const note = service.edgelessElements[0], paragraph = note.children[0];
    const external = snapshot(), peer = new Y.Doc();
    Y.applyUpdate(peer, Uint8Array.from(atob(external.data), character => character.charCodeAt(0)));
    peer.getMap('blocks').get(paragraph.id).set('prop:text', new Y.Text('External edit'));
    external.data = btoa(String.fromCharCode(...Y.encodeStateAsUpdate(peer)));
    service.gfx.updateElement(note.id, { xywh: '[60,70,280,200]' });
    window.dispatchEvent(new CustomEvent('brainz', { detail: { type: 'external', document: external, baseHash: 'external-version' } }));
    peer.destroy();
    return note.id;
  });
  await expect.poll(async () => (await objects(page)).find((object: any) => object.id === expected)?.text).toBe('External edit');
  expect((await objects(page)).find((object: any) => object.id === expected).xywh).toEqual([60, 70, 280, 200]);
});

test('An unexpected engine error rolls back the entire batch without making it redoable', async ({ page }) => {
  await open(page);
  await submit(page, batch([{ op: 'create', type: 'shape' }, { op: 'create', type: 'shape' }]));
  await page.evaluate(() => {
    const { service } = window.__brainzBoard as any;
    const original = service.surface.addElement.bind(service.surface); let calls = 0;
    service.surface.addElement = (props: unknown) => { if (++calls === 2) throw new Error('Simulated engine failure'); return original(props); };
  });
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  expect(await objects(page)).toEqual([]);
  await page.getByRole('button', { name: 'Redo', exact: true }).click(); expect(await objects(page)).toEqual([]);
});

test('The screenshot request returns only selected objects with even padding', async ({ page }) => {
  await open(page);
  await submit(page, batch([{ op: 'create', type: 'shape', text: 'Selected', size: [240, 120] }, { op: 'create', type: 'shape', at: [500, 0], text: 'Excluded' }]));
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  const result = await page.evaluate(async () => {
    const { service } = window.__brainzBoard as any;
    const id = service.edgelessElements[0].id;
    return await new Promise<any>(resolve => {
      const post = window.ipc!.postMessage;
      window.ipc!.postMessage = value => { const message = JSON.parse(value); if (message.type === 'canvasResponse') { window.ipc!.postMessage = post; resolve(message.result); } else post(value); };
      window.dispatchEvent(new CustomEvent('brainz', { detail: { type: 'canvasRequest', request: { requestId: 'screenshot-test', kind: 'screenshot', objectIds: [id] } } }));
    });
  });
  expect(result.error).toBeUndefined(); expect(result.bounds).toEqual([-32, -32, 304, 184]);
  const png = Buffer.from(result.png, 'base64'); expect(png.subarray(1, 4).toString()).toBe('PNG');
  expect(png.readUInt32BE(16)).toBe(304); expect(png.readUInt32BE(20)).toBe(184);
});

test('An invalid external document requests a durable copy of the intact local canvas', async ({ page }) => {
  await open(page);
  await submit(page, batch([{op:'create',type:'shape',text:'Keep my work'}]));
  await page.getByRole('button',{name:'Apply',exact:true}).click();
  const before = await objects(page);
  const recovery = await page.evaluate(async () => {
    const {snapshot} = window.__brainzBoard as any;
    return new Promise<any>(resolve => {
      const post = window.ipc!.postMessage;
      window.ipc!.postMessage = value => { const message = JSON.parse(value); if(message.type === 'recover') { window.ipc!.postMessage = post; resolve(message.document); } else post(value); };
      window.dispatchEvent(new CustomEvent('brainz',{detail:{type:'external',document:{...snapshot(),data:'invalid data'}}}));
    });
  });
  expect(await objects(page)).toEqual(before);
  expect(recovery.scene.objects[0].text).toBe('Keep my work');
  expect(recovery.data).not.toBe('invalid data');
});

test('Text and line colors update their rendered properties and style edits invalidate proposals', async ({ page }) => {
  await open(page);
  await submit(page,batch([{op:'create',type:'text',text:'Text',ref:'$t'}, {op:'create',type:'shape',at:[400,0],ref:'$s'}, {op:'connect',from:'$t',to:'$s'}]));
  await page.getByRole('button',{name:'Apply',exact:true}).click();
  const initial = await objects(page), text = initial.find((value:any)=>value.kind === 'text'), edge = initial.find((value:any)=>value.kind === 'connector');
  await submit(page,batch([{op:'update',id:text.id,set:{color:'red'}},{op:'update',id:edge.id,set:{color:'blue'}}],{batchId:'colors'}));
  await page.getByRole('button',{name:'Apply',exact:true}).click();
  const changed = await objects(page);
  expect(changed.find((value:any)=>value.id===text.id).color).toBe('#ed8c89');
  expect(changed.find((value:any)=>value.id===edge.id).color).toBe('#aedbea');
  await submit(page,batch([{op:'update',id:text.id,set:{text:'Changed'}}],{batchId:'style-conflict'}));
  await page.evaluate(id => { const {service} = window.__brainzBoard as any; service.gfx.updateElement(id,{fontSize:32}); },text.id);
  await page.getByRole('button',{name:'Apply',exact:true}).click();
  expect((await objects(page)).find((value:any)=>value.id===text.id).text).toBe('Text');
});

test('Moving a frame moves its children; deleting it previews and removes children and attached edges', async ({ page }) => {
  await open(page);
  await submit(page,batch([
    {op:'create',type:'frame',title:'Frame',ref:'$frame',at:[-400,-200]},
    {op:'create',type:'shape',text:'Child',parent:'$frame',ref:'$child',at:[50,50]},
    {op:'create',type:'shape',text:'Outside',ref:'$outside',at:[500,0]},
    {op:'connect',from:'$child',to:'$outside'},
  ]));
  await page.getByRole('button',{name:'Apply',exact:true}).click();
  let content = await objects(page);
  const frame = content.find((object:any)=>object.kind === 'frame'), child = content.find((object:any)=>object.text === 'Child');
  expect(child.parent).toBe(frame.id);
  await submit(page,batch([{op:'move',ids:[frame.id,child.id],by:[40,50]}],{batchId:'move-frame'}));
  await page.getByRole('button',{name:'Apply',exact:true}).click();
  content = await objects(page);
  expect(content.find((object:any)=>object.id === child.id).xywh.slice(0,2)).toEqual([child.xywh[0]+40,child.xywh[1]+50]);
  await submit(page,batch([{op:'delete',ids:[frame.id]}],{batchId:'delete-frame'}));
  await expect(page.locator('.agent-preview text').filter({hasText:'Remove'})).toHaveCount(2);
  expect(await objects(page)).toHaveLength(4);
  await page.getByRole('button',{name:'Apply',exact:true}).click();
  content = await objects(page); expect(content).toHaveLength(1); expect(content[0].text).toBe('Outside');
  await page.getByRole('button',{name:'Undo',exact:true}).click(); expect(await objects(page)).toHaveLength(4);
});

test('New notes and groups can be updated later in the same batch and undone together', async ({page}) => {
  await open(page);
  await submit(page,batch([
    {op:'create',type:'sticky',ref:'$note',text:'Initial'},
    {op:'update',id:'$note',set:{text:'Revised',color:'blue'}},
    {op:'create',type:'shape',ref:'$shape',at:[400,0]},
    {op:'group',ids:['$note','$shape'],ref:'$group',title:'Team'},
    {op:'move',id:'$group',by:[100,100]},
  ]));
  await page.getByRole('button',{name:'Apply',exact:true}).click();
  const content = await objects(page), group = content.find((object:any)=>object.kind==='group'), note = content.find((object:any)=>object.kind==='sticky');
  expect(content).toHaveLength(3); expect(group.text).toBe('Team');
  expect(note).toMatchObject({text:'Revised',color:'#aedbea',parent:group.id});
  expect(note.xywh.slice(0,2)).toEqual([100,100]);
  await page.getByRole('button',{name:'Undo',exact:true}).click(); expect(await objects(page)).toEqual([]);
});
