import { describe, expect, it } from 'vitest';
import { objectVersion, overlaps, prepareBatch, scopedLink, type CanvasObject } from '../src/ops';

const object: CanvasObject = { id: 'original', kind: 'shape', xywh: [10, 20, 200, 120], text: 'User text', version: 'v1' };
const batch = (ops: Record<string, unknown>[], extra = {}) => ({ format: 'brainz-canvas-ops', version: 1, batchId: 'test-1', actor: 'agent:claude', ops, ...extra });

describe('canvas proposal validation', () => {
  it('rejects an invalid atomic batch without changing the source objects or keeping valid prefixes', () => {
    const source = structuredClone(object);
    const plan = prepareBatch(batch([{ op: 'update', id: source.id, set: { text: 'Overwrite' } }, { op: 'connect', from: 'missing', to: source.id }]), [source]);
    expect(plan.result.status).toBe('rejected'); expect(plan.changes).toEqual([]);
    expect(plan.objects.get(source.id)).toEqual(object); expect(source).toEqual(object);
  });
  it('resolves references in order and preserves explicit edge direction', () => {
    const plan = prepareBatch(batch([{ op: 'create', type: 'sticky', text: 'Idea', ref: '$a' }, { op: 'create', type: 'shape', text: 'Decision', shape: 'diamond', ref: '$b' }, { op: 'connect', from: '$a', to: '$b', label: 'review', ref: '$edge' }]), []);
    const edge = plan.objects.get(plan.result.refs.$edge)!;
    expect(edge).toMatchObject({ from: plan.result.refs.$a, to: plan.result.refs.$b, text: 'review', arrow: 'end' });
    expect(plan.result.status).toBe('staged');
  });
  it('reports a stale version with the current object', () => {
    const plan = prepareBatch(batch([{ op: 'update', id: object.id, ifVersion: 'old', set: { text: 'Overwrite' } }]), [object]);
    expect(plan.result.ops[0]).toMatchObject({ status: 'conflict', current: object });
    expect(plan.objects.get(object.id)?.text).toBe('User text');
  });
  it('keeps valid independent operations only when partial application is explicitly requested', () => {
    const plan = prepareBatch(batch([{ op: 'create', type: 'shape', ref: '$a' }, { op: 'create', type: 'unknown', ref: '$b' }, { op: 'connect', from: '$b', to: '$a' }], { atomic: false }), []);
    expect(plan.result.status).toBe('staged'); expect(plan.objects.size).toBe(1);
    expect(Object.keys(plan.result.refs)).toEqual(['$a']);
    expect(plan.result.ops.map(op => op.status)).toEqual(['ok', 'invalid', 'not_found']);
  });
  it('places proposals without overlapping existing objects, retaining relative geometry', () => {
    const plan = prepareBatch(batch([{ op: 'create', type: 'shape', at: [0, 0], size: [100, 80], ref: '$a' }, { op: 'create', type: 'shape', at: [180, 0], size: [100, 80], ref: '$b' }, { op: 'layout', ids: ['$a', '$b'], kind: 'row', gap: 80 }], { anchor: { near: 'selection' } }), [object], { selection: [object.id] });
    const first = plan.objects.get(plan.result.refs.$a)!, second = plan.objects.get(plan.result.refs.$b)!;
    expect(overlaps(first.xywh, object.xywh)).toBe(false); expect(overlaps(second.xywh, object.xywh)).toBe(false);
    expect(second.xywh[0] - first.xywh[0]).toBe(180); expect(first.xywh[1]).toBe(second.xywh[1]);
    expect(plan.objects.get(object.id)).toEqual(object);
  });
  it('rejects unsafe coordinates, duplicate references, prototype references, and oversized batches', () => {
    for (const ops of [
      [{ op: 'create', type: 'shape', at: [Infinity, 2] }],
      [{ op: 'create', type: 'shape', ref: '$a' }, { op: 'create', type: 'shape', ref: '$a' }],
      [{ op: 'update', id: '__proto__', set: { text: 'Unsafe' } }],
    ]) expect(prepareBatch(batch(ops), []).result.status).toBe('rejected');
    expect(() => prepareBatch(batch(Array.from({ length: 501 }, () => ({ op: 'create', type: 'shape' }))), [])).toThrow('1–500');
  });
  it('keeps links inside the declared brain and rejects traversal and deceptive prefixes', () => {
    expect(scopedLink('file:///brain/Projects/Plan.md', '/brain')).toBe('file:///brain/Projects/Plan.md');
    for (const link of ['file:///brain-secret/key', 'file:///brain/../../secret', 'file://remote/brain/file.md', 'brainz://whiteboard?path=/secret/file', 'javascript:alert(1)']) expect(() => scopedLink(link, '/brain')).toThrow();
    expect(() => scopedLink('file:///brain/Plan.md')).toThrow();
  });
  it('records preconditions for implicit dependencies, not just objects being edited', () => {
    const plan = prepareBatch(batch([{ op: 'create', type: 'shape', ref: '$a' }, { op: 'connect', from: object.id, to: '$a' }]), [object]);
    expect(plan.versions.get(object.id)).toBe('v1');
    expect(objectVersion({ text: 'before' })).not.toBe(objectVersion({ text: 'after' }));
  });
  it('moves frame contents once and checks every descendant before deleting a container', () => {
    const frame: CanvasObject = {...object,id:'frame',kind:'frame',xywh:[0,0,800,500],children:[object.id]};
    const child = {...object,parent:frame.id};
    const move = prepareBatch(batch([{op:'move',ids:[frame.id,child.id],by:[40,50]}]),[frame,child]);
    expect(move.objects.get(child.id)?.xywh).toEqual([50,70,200,120]);
    expect(move.versions.size).toBe(2);
    const deletion = prepareBatch(batch([{op:'delete',ids:[frame.id]}]),[frame,child]);
    expect(deletion.objects.size).toBe(0);
    expect([...deletion.versions.keys()].sort()).toEqual(['frame','original']);
  });
});
