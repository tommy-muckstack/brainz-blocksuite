export interface BoardTarget { path: string; object?: string | null; viewport?: [number, number, number] | null }
export interface ImageAsset { data: string; mime: string }
export interface BoardDocument { format: 'brainz-whiteboard'; version: 1 | 2; id?: string; title: string; data: string; updates?: string[]; storageStamp?: string; assets?: Record<string,{mime:string;bytes:number}>; viewport?: [number, number, number]; images?: Record<string,ImageAsset>; scene?: unknown }
export interface LinkReference { title: string; url: string; image?: ImageAsset }
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}
export function base64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), character => character.charCodeAt(0));
}
export function supportedLink(value: string): URL | null {
  try { const url = new URL(value); return ['brainz:', 'myman:', 'file:', 'https:', 'http:', 'mailto:'].includes(url.protocol) ? url : null; }
  catch { return null; }
}
export function boardLink(target: BoardTarget, viewport: [number, number, number], object?: string): string {
  const url = new URL('brainz://whiteboard');
  url.searchParams.set('path', target.path);
  if (object) url.searchParams.set('object', object);
  url.searchParams.set('x', viewport[0].toFixed(2));
  url.searchParams.set('y', viewport[1].toFixed(2));
  url.searchParams.set('zoom', Math.min(10, Math.max(.05, viewport[2])).toFixed(3));
  return url.toString();
}
