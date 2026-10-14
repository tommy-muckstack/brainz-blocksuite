import * as Y from 'yjs';
import { base64ToBytes, bytesToBase64, type BoardDocument, type ImageAsset } from './model';

type Post = (message: Record<string, unknown>) => void;

export class CanvasStorage {
  enabled = false;
  private confirmed = false;
  private stamp?: string;
  private checkpointStamp?: string;
  private migration?: BoardDocument;
  private collected: Uint8Array[] = [];
  private pending = new Map<number, Uint8Array>();
  private assets = new Map<string, {resolve: (hash: string) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>}>();

  constructor(private post: Post) {}

  open(document: BoardDocument | null, enabled: boolean) {
    this.enabled = enabled || document?.version === 2;
    this.confirmed = document?.version === 2;
  }

  changed(update: Uint8Array, origin: unknown) {
    if (this.enabled && origin !== 'external') this.collected.push(update);
  }

  save(revision: number, title: string, snapshot: () => BoardDocument, baseHash?: string) {
    if (!this.enabled) { this.post({type:'save',revision,document:snapshot(),baseHash}); return; }
    if (!this.confirmed && !this.migration) {
      this.migration = snapshot();
      this.post({type:'migrateStorage',revision,document:this.migration,baseHash});
    }
    if (this.collected.length) {
      this.pending.set(revision,Y.mergeUpdates(this.collected));
      this.collected = [];
    }
    const updates = [...this.pending.values()];
    this.post({type:'appendUpdate',revision,title,update:updates.length ? bytesToBase64(Y.mergeUpdates(updates)) : undefined});
  }

  saved(revision: number, status: {version?:number;stamp?:string;needsCompaction?:boolean} | undefined, checkpoint?: () => {snapshot:Uint8Array;usedAssets:string[]}) {
    for (const key of this.pending.keys()) if (key <= revision) this.pending.delete(key);
    if (status?.version === 2) { this.confirmed = true; this.migration = undefined; }
    if (status?.stamp) this.stamp = status.stamp;
    if (status?.needsCompaction && checkpoint) this.checkpoint(checkpoint);
  }

  checkpoint(capture: () => {snapshot:Uint8Array;usedAssets:string[]}) {
    if (!this.enabled || !this.stamp || this.checkpointStamp === this.stamp || this.collected.length || this.pending.size) return;
    const {snapshot,usedAssets} = capture(); this.checkpointStamp = this.stamp;
    this.post({type:'compactStorage',snapshot:bytesToBase64(snapshot),stamp:this.stamp,usedAssets});
  }

  putImage(asset: ImageAsset, name?: string): Promise<string> {
    const requestId = crypto.randomUUID();
    return new Promise((resolve,reject) => {
      const timer = setTimeout(() => { this.assets.delete(requestId); reject(new Error('The image could not be saved. Please try again.')); },30000);
      this.assets.set(requestId,{resolve,reject,timer});
      this.post({type:'putAsset',requestId,mime:asset.mime,data:asset.data,name});
    });
  }

  assetStored(message: Record<string, unknown>) {
    const requestId = String(message.requestId);
    const pending = this.assets.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer); this.assets.delete(requestId);
    if (typeof message.error === 'string') pending.reject(new Error(message.error));
    else if (typeof message.hash === 'string' && /^[a-f0-9]{64}$/.test(message.hash)) pending.resolve(message.hash);
    else pending.reject(new Error('The saved image response was invalid'));
  }
}

export function documentUpdate(document: BoardDocument): Uint8Array {
  if (document.format !== 'brainz-whiteboard' || ![1,2].includes(document.version)) throw new Error('Update Brainz to open this canvas. Its contents have been preserved.');
  return Y.mergeUpdates([base64ToBytes(document.data),...(document.updates ?? []).map(base64ToBytes)]);
}

export async function hydrateImages(document: BoardDocument | null, set: (id:string,blob:Blob) => Promise<unknown>, loaded: Set<string>) {
  for (const [id,asset] of Object.entries(document?.images ?? {})) if (!loaded.has(id)) { await set(id,new Blob([base64ToBytes(asset.data)],{type:asset.mime})); loaded.add(id); }
  const sources = Object.entries(document?.assets ?? {}).filter(([id])=>!loaded.has(id));
  let index = 0;
  // Limit concurrent image decoding and copies in the webview process.
  await Promise.all(Array.from({length:Math.min(4,sources.length)},async() => {
    while (index < sources.length) {
      const [id,asset] = sources[index++];
      const response = await fetch(`brainz-board://app/board-assets/${encodeURIComponent(id)}`);
      if (!response.ok) throw new Error(`Canvas image could not be loaded: ${id}`);
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > 25*1024*1024) throw new Error('Canvas image is too large');
      await set(id,new Blob([bytes],{type:asset.mime}));
      loaded.add(id);
    }
  }));
}
