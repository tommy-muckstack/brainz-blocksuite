import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { CanvasStorage, documentUpdate } from '../src/storage';
import { base64ToBytes, bytesToBase64, type BoardDocument } from '../src/model';

describe('incremental canvas persistence', () => {
  it('keeps edits made during migration and resends unacknowledged updates without another full snapshot', () => {
    const messages: any[] = [];
    const doc = new Y.Doc(); const text = doc.getText('note'); text.insert(0,'Before');
    const storage = new CanvasStorage(message=>messages.push(message)); storage.open(null,true);
    doc.on('update',(update,origin)=>storage.changed(update,origin));
    const snapshot = (): BoardDocument => ({format:'brainz-whiteboard',version:1,id:'board-one',title:'Plan',data:bytesToBase64(Y.encodeStateAsUpdate(doc))});
    storage.save(1,'Plan',snapshot);
    text.insert(text.length,' during migration'); storage.save(2,'Plan',snapshot);
    storage.save(3,'Plan',snapshot);
    expect(messages.filter(message=>message.type==='migrateStorage')).toHaveLength(1);
    const reopened = new Y.Doc(); Y.applyUpdate(reopened,base64ToBytes(messages[0].document.data));
    for (const message of messages.filter(message=>message.type==='appendUpdate' && message.update)) Y.applyUpdate(reopened,base64ToBytes(message.update));
    expect(reopened.getText('note').toString()).toBe('Before during migration');
    storage.saved(3,{version:2}); messages.length = 0;
    storage.save(4,'Renamed',snapshot);
    expect(messages).toEqual([{type:'appendUpdate',revision:4,title:'Renamed',update:undefined}]);
  });

  it('sends less than 64 KB for one note edit on a board with 2,000 objects and 30 MB of external assets', () => {
    const doc = new Y.Doc(); const objects = doc.getMap('objects');
    doc.transact(()=>{ for (let index=0;index<2000;index++) objects.set(`shape-${index}`,{text:`Object ${index}`,xywh:[index*100,100,80,80]}); });
    const assets = Object.fromEntries(Array.from({length:30},(_,index)=>[`image-${index}`,{mime:'image/png',bytes:1024*1024}]));
    const original: BoardDocument = {format:'brainz-whiteboard',version:2,title:'Large board',data:bytesToBase64(Y.encodeStateAsUpdate(doc)),assets};
    const messages: any[] = []; const storage = new CanvasStorage(message=>messages.push(message)); storage.open(original,false);
    doc.on('update',(update,origin)=>storage.changed(update,origin)); objects.set('shape-12',{text:'Edited one note',xywh:[1200,100,80,80]});
    storage.save(1,'Large board',()=>{ throw new Error('A small edit must not encode the whole board'); });
    expect(JSON.stringify(messages).length).toBeLessThan(64*1024);
    const reopened = new Y.Doc(); Y.applyUpdate(reopened,documentUpdate(original)); Y.applyUpdate(reopened,base64ToBytes(messages[0].update));
    expect(reopened.getMap('objects').size).toBe(2000);
    expect(reopened.getMap('objects').get('shape-12')).toEqual({text:'Edited one note',xywh:[1200,100,80,80]});
  });

  it('replays snapshots plus logs, rejects future formats and never checkpoints unacknowledged edits', () => {
    const doc = new Y.Doc(); doc.getText('note').insert(0,'A'); const original = Y.encodeStateAsUpdate(doc); const changes: Uint8Array[]=[];
    doc.on('update',update=>changes.push(update)); doc.getText('note').insert(1,'B');
    const document: BoardDocument = {format:'brainz-whiteboard',version:2,title:'Board',data:bytesToBase64(original),updates:changes.map(bytesToBase64)};
    const reopened = new Y.Doc(); Y.applyUpdate(reopened,documentUpdate(document)); expect(reopened.getText('note').toString()).toBe('AB');
    expect(()=>documentUpdate({...document,version:3 as any})).toThrow('Update Brainz');
    const messages: any[]=[]; const storage = new CanvasStorage(message=>messages.push(message)); storage.open(document,true);
    storage.changed(changes[0],undefined); storage.save(2,'Board',()=>document);
    storage.saved(1,{version:2,needsCompaction:true,stamp:'old'},()=>{throw new Error('Must not compact with a pending edit');});
    expect(messages.filter(message=>message.type==='compactStorage')).toHaveLength(0);
    storage.saved(2,{version:2,needsCompaction:true,stamp:'latest'},()=>({snapshot:Y.encodeStateAsUpdate(doc),usedAssets:[]}));
    expect(messages.at(-1).stamp).toBe('latest');
  });
});
