import { supportedLink } from './model';

export type Box = [number, number, number, number];
export type ObjectKind = 'shape' | 'sticky' | 'text' | 'frame' | 'card' | 'connector' | 'group' | 'image' | 'brush';
export interface CanvasObject {
  id: string; kind: ObjectKind; xywh: Box; text: string; version: string;
  color?: string; shape?: string; rotate?: number; parent?: string; url?: string;
  from?: string; to?: string; mode?: string; arrow?: string; children?: string[];
}
export interface OpBatch {
  format: 'brainz-canvas-ops'; version: 1; batchId: string; actor: string;
  mode?: 'staged' | 'direct'; atomic?: boolean; ops: Record<string, unknown>[];
  anchor?: { near?: 'selection' | 'viewport'; placement?: 'right' | 'below' | 'left'; gap?: number };
}
export interface OpStatus { i: number; status: 'ok' | 'invalid' | 'not_found' | 'conflict' | 'forbidden'; message?: string; current?: CanvasObject }
export interface BatchResult {
  batchId: string; status: 'applied' | 'staged' | 'rejected' | 'discarded';
  refs: Record<string, string>; ops: OpStatus[]; message?: string; links?: Record<string, string>;
}
export type Change =
  | { op: 'create'; object: CanvasObject }
  | { op: 'update'; id: string; set: Partial<CanvasObject> }
  | { op: 'delete'; ids: string[] }
  | { op: 'reorder'; id: string; direction: 'front' | 'forward' | 'backward' | 'back' }
  | { op: 'setView'; bound: Box; follow: boolean }
  | { op: 'message'; text: string }
  | { op: 'todo'; items: { text: string; done: boolean }[] };
export interface Plan {
  batch: OpBatch; result: BatchResult; changes: Change[]; objects: Map<string, CanvasObject>;
  versions: Map<string, string>;
}
export interface PlanContext { workspace?: string; selection?: string[]; viewport?: Box }
export const palette: Record<string, string> = {
  amber: '#e6cc78', green: '#a1cf91', blue: '#aedbea', red: '#ed8c89', purple: '#b3a1df',
  grey: '#aaa99f', white: '#f2efe4', black: '#292c28', transparent: 'transparent',
};
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OpError('invalid', 'Expected an object');
  return value as Record<string, unknown>;
};
function string(value: unknown, name: string, maximum = 20_000): string {
  if (typeof value !== 'string' || value.length > maximum) throw new OpError('invalid', `${name} must be text of at most ${maximum} characters`);
  return value;
}
function number(value: unknown, name: string, minimum = -1_000_000, maximum = 1_000_000): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) throw new OpError('invalid', `Invalid ${name}`);
  return value;
}
function point(value: unknown, name: string, positive = false): [number, number] {
  if (!Array.isArray(value) || value.length !== 2) throw new OpError('invalid', `${name} requires two coordinates`);
  return [number(value[0], name, positive ? 1 : undefined), number(value[1], name, positive ? 1 : undefined)];
}
function choice<T extends string>(value: unknown, choices: readonly T[], name: string): T {
  if (!choices.includes(value as T)) throw new OpError('invalid', `Unsupported ${name}: ${String(value)}`);
  return value as T;
}
class OpError extends Error {
  constructor(readonly status: OpStatus['status'], message: string, readonly current?: CanvasObject) { super(message); }
}
export function parseBatch(input: unknown): OpBatch {
  const batch = record(input);
  if (batch.format !== 'brainz-canvas-ops' || batch.version !== 1) throw new OpError('invalid', 'Expected brainz-canvas-ops version 1');
  const batchId = string(batch.batchId, 'batchId', 100);
  if (!/^[a-zA-Z0-9_-]+$/.test(batchId)) throw new OpError('invalid', 'Invalid batchId');
  const actor = string(batch.actor ?? 'agent:unknown', 'actor', 120);
  if (!actor || (!actor.startsWith('agent:') && actor !== 'user')) throw new OpError('invalid', 'actor must be user or agent:<name>');
  if (!Array.isArray(batch.ops) || !batch.ops.length || batch.ops.length > 500) throw new OpError('invalid', 'A batch requires 1–500 operations');
  if (batch.atomic !== undefined && typeof batch.atomic !== 'boolean') throw new OpError('invalid', 'atomic must be a boolean');
  const mode = choice(batch.mode ?? 'staged', ['staged', 'direct'], 'mode');
  let anchor: OpBatch['anchor'];
  if (batch.anchor !== undefined) {
    const value = record(batch.anchor);
    anchor = {
      near: choice(value.near ?? 'selection', ['selection', 'viewport'] as const, 'anchor'),
      placement: choice(value.placement ?? 'right', ['right', 'below', 'left'] as const, 'placement'),
      gap: number(value.gap ?? 80, 'gap', 0, 10_000),
    };
  }
  return { format: 'brainz-canvas-ops', version: 1, batchId, actor, mode, atomic: batch.atomic !== false, anchor, ops: batch.ops.map(record) };
}
export function unionBounds(objects: Iterable<CanvasObject>): Box | undefined {
  const values = [...objects];
  if (!values.length) return;
  const left = Math.min(...values.map(item => item.xywh[0])), top = Math.min(...values.map(item => item.xywh[1]));
  return [left, top, Math.max(...values.map(item => item.xywh[0] + item.xywh[2])) - left, Math.max(...values.map(item => item.xywh[1] + item.xywh[3])) - top];
}
export const overlaps = (first: Box, second: Box) => first[0] < second[0] + second[2] && first[0] + first[2] > second[0] && first[1] < second[1] + second[3] && first[1] + first[3] > second[1];

export function scopedLink(value: unknown, workspace?: string): string {
  const text = string(value, 'link', 4096), url = supportedLink(text);
  if (!url) throw new OpError('forbidden', 'Unsupported link');
  if (url.protocol === 'file:' || url.protocol === 'brainz:') {
    const root = workspace?.replace(/\/$/, '');
    const path = url.protocol === 'file:' ? decodeURIComponent(url.pathname) : url.searchParams.get('path');
    if (!root || !path || (url.protocol === 'file:' && url.hostname && url.hostname !== 'localhost') || path.split('/').some(part => part === '..' || part === '.')) throw new OpError('forbidden', 'Links must stay inside this brain');
    if (path !== root && !path.startsWith(`${root}/`)) throw new OpError('forbidden', 'Links must stay inside this brain');
  }
  return url.toString();
}

export function prepareBatch(input: unknown, existing: CanvasObject[], context: PlanContext = {}): Plan {
  const batch = parseBatch(input);
  let objects = new Map(existing.map(object => [object.id, structuredClone(object)]));
  let refs: Record<string, string> = Object.create(null);
  const statuses: OpStatus[] = [], changes: Change[] = [], versions = new Map<string, string>();
  const original = new Map(existing.map(object => [object.id, object]));
  const requireObject = (value: unknown, op: Record<string, unknown>): CanvasObject => {
    const reference = string(value, 'object id', 256), id = own(refs, reference) ? refs[reference] : reference;
    const object = objects.get(id);
    if (!object) throw new OpError('not_found', `Object ${reference} no longer exists`);
    if (op.ifVersion !== undefined && op.ifVersion !== object.version) throw new OpError('conflict', 'This object changed since it was read', object);
    if (original.has(id)) versions.set(id, original.get(id)!.version);
    return object;
  };
  const requireObjects = (op: Record<string, unknown>): CanvasObject[] => {
    if (!Array.isArray(op.ids) || !op.ids.length || op.ids.length > 500) throw new OpError('invalid', 'ids requires 1–500 objects');
    return [...new Set(op.ids)].map(id => requireObject(id, op));
  };
  const update = (object: CanvasObject, set: Partial<CanvasObject>) => {
    if (set.xywh && (object.kind === 'group' || object.kind === 'frame')) {
      const dx = set.xywh[0]-object.xywh[0], dy = set.xywh[1]-object.xywh[1];
      if (dx || dy) {
        const children = [...objects.values()].filter(child=>child.parent === object.id || object.children?.includes(child.id));
        for (const child of children) {
          requireObject(child.id, {});
          update(child,{xywh:[child.xywh[0]+dx,child.xywh[1]+dy,child.xywh[2],child.xywh[3]]});
        }
      }
    }
    const next = { ...object, ...set };
    objects.set(object.id, next); changes.push({ op: 'update', id: object.id, set });
  };
  for (const [index, op] of batch.ops.entries()) {
    const previousObjects = new Map(objects), previousRefs = { ...refs }, start = changes.length;
    try {
      if (op.ifExists !== undefined && typeof op.ifExists !== 'boolean') throw new OpError('invalid', 'ifExists must be a boolean');
      switch (op.op) {
        case 'create': case 'connect': case 'group': {
          const kind = op.op === 'connect' ? 'connector' : op.op === 'group' ? 'group' : choice(op.type, ['sticky', 'text', 'shape', 'frame', 'card'], 'object type');
          const id = `staged:${batch.batchId}:${index}`;
          if (objects.has(id)) throw new OpError('invalid', 'Duplicate object id');
          const at = point(op.at ?? [0, 0], 'position');
          const size = point(op.size ?? (kind === 'frame' ? [800, 500] : kind === 'sticky' ? [280, 200] : [240, 120]), 'size', true);
          const parent = op.parent === undefined ? undefined : requireObject(op.parent, {});
          if (parent && parent.kind !== 'frame') throw new OpError('invalid', 'parent must be a frame');
          const object: CanvasObject = {
            id, kind, xywh: [at[0] + (parent?.xywh[0] ?? 0), at[1] + (parent?.xywh[1] ?? 0), ...size],
            text: string(op.text ?? op.title ?? op.label ?? '', 'text'), version: `${batch.batchId}:${index}`, parent: parent?.id,
            color: choice(op.color ?? (kind === 'shape' ? 'black' : kind === 'frame' ? 'transparent' : kind === 'text' ? 'white' : kind === 'connector' ? 'green' : 'amber'), Object.keys(palette), 'color'),
          };
          if (kind === 'shape') object.shape = choice(op.shape ?? 'roundedRect', ['rect', 'roundedRect', 'diamond', 'ellipse', 'triangle'], 'shape');
          if (kind === 'card') {
            if (op.path !== undefined) {
              const path = string(op.path, 'path', 4096);
              if (!context.workspace || path.startsWith('/') || path.split('/').some(part => part === '..' || part === '.')) throw new OpError('forbidden', 'Use a path relative to this brain');
              const url = new URL('file:///'); url.pathname = `${context.workspace}/${path}`;
              object.url = scopedLink(url.toString(), context.workspace);
              object.text ||= path.split('/').pop() ?? path;
            } else object.url = scopedLink(op.url, context.workspace);
          }
          if (kind === 'connector') {
            const from = requireObject(op.from, {}), to = requireObject(op.to, {});
            if (['connector', 'group', 'brush'].includes(from.kind) || ['connector', 'group', 'brush'].includes(to.kind)) throw new OpError('invalid', 'Connect to a shape, note, card, image, or frame');
            object.from = from.id; object.to = to.id;
            object.xywh = unionBounds([from, to])!;
            object.mode = choice(op.mode ?? 'orthogonal', ['orthogonal', 'straight', 'curve'], 'connector mode');
            object.arrow = choice(op.arrow ?? 'end', ['end', 'start', 'both', 'none'], 'arrow');
          }
          if (kind === 'group') {
            const children = requireObjects(op);
            if (children.some(child => child.parent || child.kind === 'frame' || child.kind === 'group')) throw new OpError('invalid', 'Group ungrouped objects outside frames');
            object.children = children.map(child => child.id); object.xywh = unionBounds(children)!;
            for (const child of children) objects.set(child.id,{...child,parent:id});
          }
          if (op.ref !== undefined) {
            const ref = string(op.ref, 'ref', 100);
            if (!/^\$[a-zA-Z0-9_-]+$/.test(ref) || own(refs, ref)) throw new OpError('invalid', 'References must be unique and start with $');
            refs[ref] = id;
          }
          objects.set(id, object); changes.push({ op: 'create', object }); break;
        }
        case 'update': {
          const object = requireObject(op.id, op), props = record(op.set), set: Partial<CanvasObject> = {};
          for (const key of Object.keys(props)) if (!['text', 'color', 'at', 'size', 'rotate', 'shape', 'url'].includes(key)) throw new OpError('invalid', `Unsupported property ${key}`);
          if (props.text !== undefined) set.text = string(props.text, 'text');
          if (props.color !== undefined) set.color = choice(props.color, Object.keys(palette), 'color');
          if (props.color !== undefined && ['group','image'].includes(object.kind)) throw new OpError('invalid','This object has no editable color');
          if (props.shape !== undefined) {
            if (object.kind !== 'shape') throw new OpError('invalid', 'Only shapes have a shape style');
            set.shape = choice(props.shape, ['rect', 'roundedRect', 'diamond', 'ellipse', 'triangle'], 'shape');
          }
          if (props.url !== undefined) set.url = scopedLink(props.url, context.workspace);
          if (props.rotate !== undefined) set.rotate = number(props.rotate, 'rotation', -360, 360);
          if ((props.rotate !== undefined || props.size !== undefined) && object.kind === 'group') throw new OpError('invalid','Resize or rotate group members individually');
          if (props.rotate !== undefined && object.kind === 'frame') throw new OpError('invalid','Frames stay axis-aligned');
          if (props.at !== undefined || props.size !== undefined) set.xywh = [...point(props.at ?? object.xywh.slice(0, 2), 'position'), ...point(props.size ?? object.xywh.slice(2), 'size', true)];
          update(object, set); break;
        }
        case 'delete': {
          if (!Array.isArray(op.ids) || op.ids.length > 500) throw new OpError('invalid', 'Invalid ids');
          const ids: string[] = [];
          for (const value of op.ids) {
            try { ids.push(requireObject(value, op).id); }
            catch (error) { if (!(error instanceof OpError && error.status === 'not_found' && op.ifExists)) throw error; }
          }
          for (let index=0;index<ids.length;index++) {
            const object = objects.get(ids[index]);
            if (!object || !['frame','group'].includes(object.kind)) continue;
            for (const child of objects.values()) if (!ids.includes(child.id) && (child.parent === object.id || object.children?.includes(child.id))) ids.push(requireObject(child.id,{}).id);
          }
          // Attached edges must disappear with the object, including in the proposal.
          for (const object of objects.values()) if ((object.from && ids.includes(object.from)) || (object.to && ids.includes(object.to))) ids.push(object.id);
          for (const id of ids) requireObject(id,{});
          ids.forEach(id => objects.delete(id)); changes.push({ op: 'delete', ids }); break;
        }
        case 'move': case 'resize': case 'rotate': {
          let selected = op.ids ? requireObjects(op) : [requireObject(op.id, op)];
          if (op.op === 'move') {
            const selectedIds = new Set(selected.map(object=>object.id));
            selected = selected.filter(object=>!object.parent || !selectedIds.has(object.parent));
          }
          const bounds = unionBounds(selected)!;
          for (const object of selected) {
            if (op.op !== 'move' && object.kind === 'group') throw new OpError('invalid','Resize or rotate group members individually');
            if (op.op === 'rotate' && object.kind === 'frame') throw new OpError('invalid','Frames stay axis-aligned');
            if (op.op === 'rotate') update(object, { rotate: number(op.angle, 'rotation', -360, 360) });
            else if (op.op === 'resize') update(object, { xywh: [object.xywh[0], object.xywh[1], ...point(op.size, 'size', true)] });
            else {
              const by = op.by !== undefined ? point(op.by, 'offset') : point(op.to, 'position').map((value, axis) => value - bounds[axis]);
              update(object, { xywh: [object.xywh[0] + by[0], object.xywh[1] + by[1], object.xywh[2], object.xywh[3]] });
            }
          }
          break;
        }
        case 'layout': case 'stack': case 'align': case 'distribute': {
          const selected = requireObjects(op), bounds = unionBounds(selected)!;
          const gap = number(op.gap ?? 40, 'gap', 0, 10_000);
          const kind = op.op === 'stack' ? 'column' : op.op === 'layout' ? choice(op.kind, ['row', 'column', 'grid'], 'layout') : op.op;
          const edge = kind === 'align' ? choice(op.edge, ['left', 'right', 'top', 'bottom', 'center', 'middle'], 'edge') : undefined;
          const axis = kind === 'distribute' ? choice(op.axis, ['x', 'y'], 'axis') === 'x' ? 0 : 1 : 0;
          if (kind === 'distribute') selected.sort((first, second) => first.xywh[axis] - second.xywh[axis]);
          const columns = Math.ceil(Math.sqrt(selected.length));
          const cellWidth = Math.max(...selected.map(object => object.xywh[2])) + gap, cellHeight = Math.max(...selected.map(object => object.xywh[3])) + gap;
          const distributeGap = selected.length < 2 ? 0 : (bounds[axis + 2] - selected.reduce((sum, object) => sum + object.xywh[axis + 2], 0)) / (selected.length - 1);
          let cursor = 0;
          selected.forEach((object, index) => {
            const next: Box = [...object.xywh];
            if (kind === 'row') { next[0] = bounds[0] + cursor; next[1] = bounds[1]; cursor += next[2] + gap; }
            if (kind === 'column') { next[0] = bounds[0]; next[1] = bounds[1] + cursor; cursor += next[3] + gap; }
            if (kind === 'grid') { next[0] = bounds[0] + (index % columns) * cellWidth; next[1] = bounds[1] + Math.floor(index / columns) * cellHeight; }
            if (kind === 'distribute') { next[axis] = bounds[axis] + cursor; cursor += next[axis + 2] + distributeGap; }
            if (edge === 'left') next[0] = bounds[0];
            if (edge === 'right') next[0] = bounds[0] + bounds[2] - next[2];
            if (edge === 'top') next[1] = bounds[1];
            if (edge === 'bottom') next[1] = bounds[1] + bounds[3] - next[3];
            if (edge === 'center') next[0] = bounds[0] + (bounds[2] - next[2]) / 2;
            if (edge === 'middle') next[1] = bounds[1] + (bounds[3] - next[3]) / 2;
            update(object, { xywh: next });
          }); break;
        }
        case 'reorder': {
          const object = requireObject(op.id, op);
          changes.push({ op: 'reorder', id: object.id, direction: choice(op.direction, ['front', 'forward', 'backward', 'back'], 'direction') }); break;
        }
        case 'setView': {
          if (!Array.isArray(op.bound) || op.bound.length !== 4) throw new OpError('invalid', 'bound requires four coordinates');
          changes.push({ op: 'setView', bound: [...point(op.bound.slice(0, 2), 'position'), ...point(op.bound.slice(2), 'size', true)], follow: op.follow === true }); break;
        }
        case 'message': case 'think': changes.push({ op: 'message', text: string(op.text, 'message') }); break;
        case 'todo': {
          if (!Array.isArray(op.items) || op.items.length > 100) throw new OpError('invalid', 'Use at most 100 todo items');
          changes.push({ op: 'todo', items: op.items.map(value => { const item = record(value); return { text: string(item.text, 'todo'), done: item.done === true }; }) }); break;
        }
        default: throw new OpError('invalid', `Unsupported operation: ${String(op.op)}`);
      }
      statuses.push({ i: index, status: 'ok' });
    } catch (error) {
      objects = previousObjects; refs = previousRefs; changes.splice(start);
      const failure = error instanceof OpError ? error : new OpError('invalid', String(error));
      statuses.push({ i: index, status: failure.status, message: failure.message, current: failure.current });
    }
  }
  const rejected = statuses.some(status => status.status !== 'ok') && batch.atomic !== false;
  if (rejected) { changes.length = 0; refs = Object.create(null); objects = new Map(original); }
  if (batch.anchor && !rejected) {
    const created = changes.filter((change): change is Extract<Change, {op: 'create'}> => change.op === 'create');
    const newBounds = unionBounds(created.map(change => objects.get(change.object.id)!));
    if (newBounds) {
      const selection = existing.filter(object => context.selection?.includes(object.id));
      const near = batch.anchor.near === 'viewport' ? context.viewport : unionBounds(selection) ?? context.viewport;
      const base = near ?? [0, 0, 0, 0], gap = batch.anchor.gap ?? 80;
      const placements: [number, number][] = [[base[0] + base[2] + gap, base[1]], [base[0], base[1] + base[3] + gap], [base[0] - newBounds[2] - gap, base[1]]];
      if (batch.anchor.placement === 'below') placements.unshift(placements[1]);
      if (batch.anchor.placement === 'left') placements.unshift(placements[2]);
      for (let index = 1; index <= existing.length + 1; index++) placements.push([base[0] + base[2] + index * (newBounds[2] + gap), base[1]]);
      const allBounds = unionBounds(existing);
      if (allBounds) placements.push([allBounds[0] + allBounds[2] + gap, allBounds[1]]);
      const position = placements.find(at => !existing.some(object => overlaps([at[0] - gap / 2, at[1] - gap / 2, newBounds[2] + gap, newBounds[3] + gap], object.xywh)))!;
      const offset = [position[0] - newBounds[0], position[1] - newBounds[1]];
      const createdIds = new Set(created.map(change => change.object.id));
      for (const change of changes) {
        const box = change.op === 'create' ? change.object.xywh : change.op === 'update' && createdIds.has(change.id) ? change.set.xywh : undefined;
        if (box) { box[0] += offset[0]; box[1] += offset[1]; }
      }
      // Changes and projected objects can share a box; rebuild projection from
      // the last geometry change to avoid applying the placement offset twice.
      for (const change of changes) {
        if (change.op === 'create') objects.set(change.object.id, { ...objects.get(change.object.id)!, xywh: change.object.xywh });
        if (change.op === 'update' && createdIds.has(change.id) && change.set.xywh) objects.set(change.id, { ...objects.get(change.id)!, xywh: change.set.xywh });
      }
    }
  }
  return { batch, result: { batchId: batch.batchId, status: rejected ? 'rejected' : 'staged', refs, ops: statuses }, changes, objects, versions };
}

export function objectVersion(value: unknown): string {
  let hash = 14695981039346656037n;
  for (const character of JSON.stringify(value)) hash = BigInt.asUintN(64, (hash ^ BigInt(character.codePointAt(0)!)) * 1099511628211n);
  return hash.toString(16);
}
