import type { EdgelessEditor } from '@blocksuite/presets';
import type { EdgelessRootService } from '@blocksuite/blocks';
import { ConnectorMode, FontFamily, FrameBlockModel, NoteBlockModel, NoteDisplayMode, NoteShadow, PointStyle, ShapeStyle, ShapeType, StrokeStyle } from '@blocksuite/affine-model';
import { Bound } from '@blocksuite/global/utils';
import { Text } from '@blocksuite/store';
import * as Y from 'yjs';
import { boardLink, type BoardTarget, type LinkReference } from './model';
import { describeScene } from './scene';
import { objectVersion, overlaps, palette, prepareBatch, unionBounds, type BatchResult, type Box, type CanvasObject, type Change, type ObjectKind, type Plan } from './ops';

type Attribution = { createdBy: string; updatedBy: string; at: string; opId: string; batchId: string };
interface AgentOptions {
  editor: EdgelessEditor; service: EdgelessRootService; links: Y.Map<LinkReference>;
  target: () => BoardTarget; title: () => string; boardId: string; workspace?: string;
  post: (message: Record<string, unknown>) => void; notice: (message: string) => void; save: () => void;
}
const svgNamespace = 'http://www.w3.org/2000/svg';

export class CanvasAgent {
  private readonly pending = new Map<string, Plan>();
  private readonly completed = new Map<string, BatchResult>();
  private readonly arrivals = new Map<string, number[]>();
  private readonly overlay = document.createElementNS(svgNamespace, 'svg');
  private readonly review = document.createElement('section');
  private readonly heading = document.createElement('strong');
  private readonly detail = document.createElement('span');
  private readonly metadata: Y.Map<Attribution>;
  private readonly preferences: Y.Map<unknown>;
  private readonly batches: Y.Map<BatchResult>;
  private current?: string;
  private readonly recent: Record<string, unknown>[] = [];
  private previous = new Map<string, string>();
  private eventTimer?: ReturnType<typeof setTimeout>;
  private applying = false;

  constructor(private readonly options: AgentOptions) {
    const { editor, service, links } = options;
    this.metadata = editor.doc.spaceDoc.getMap<Attribution>('brainz:meta');
    this.preferences = editor.doc.spaceDoc.getMap('brainz:preferences');
    this.batches = editor.doc.spaceDoc.getMap<BatchResult>('brainz:batches');
    editor.doc.history.addToScope([this.metadata, links, editor.doc.spaceDoc.getMap('brainz:agent'), this.batches]);
    this.overlay.classList.add('agent-preview'); this.overlay.setAttribute('aria-hidden', 'true');
    document.getElementById('canvas')!.append(this.overlay);
    this.review.className = 'agent-review'; this.review.hidden = true;
    this.review.setAttribute('aria-label', 'Review proposed canvas changes');
    this.review.setAttribute('role', 'region');
    const text = document.createElement('div'); text.append(this.heading, this.detail);
    const apply = document.createElement('button'); apply.textContent = 'Apply'; apply.className = 'primary';
    apply.onclick = () => this.current && this.decide(this.current, true);
    const discard = document.createElement('button'); discard.textContent = 'Discard'; discard.className = 'text-button';
    discard.onclick = () => this.current && this.decide(this.current, false);
    this.review.append(text, discard, apply); document.getElementById('app')!.append(this.review);
    service.viewport.viewportUpdated.on(() => this.render());
    this.previous = new Map(this.objects().map(object => [object.id, object.version]));
    editor.doc.spaceDoc.on('update', () => {
      if (this.applying) return;
      this.render();
      if (!this.applying) { clearTimeout(this.eventTimer); this.eventTimer = setTimeout(() => this.recordUserEdit(), 1000); }
    });
    window.addEventListener('resize', () => this.render());
    window.addEventListener('keydown', event => {
      if (!this.current || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || service.selection.editing) return;
      if (event.composedPath().some(node => node instanceof HTMLElement && (node.isContentEditable || ['INPUT', 'TEXTAREA', 'BUTTON'].includes(node.tagName)))) return;
      if (event.key === 'Escape' || event.key === 'Enter') {
        event.preventDefault(); event.stopImmediatePropagation(); this.decide(this.current, event.key === 'Enter');
      }
    }, true);
  }

  get allowDirect(): boolean { return this.preferences.get('agentWrites') === 'direct'; }
  set allowDirect(allow: boolean) { this.preferences.set('agentWrites', allow ? 'direct' : 'staged'); }

  objects(): CanvasObject[] {
    const scene = describeScene(this.options.service, this.options.links, this.options.target(), this.options.title());
    const connections = new Map(scene.connections.map(connection => [connection.id, connection]));
    return scene.objects.map(object => {
      const element = this.options.service.getElementById(object.id)!;
      const connection = connections.get(object.id);
      const color = 'fillColor' in element ? element.fillColor : 'background' in element ? element.background : 'stroke' in element ? element.stroke : 'color' in element ? element.color : undefined;
      const result: CanvasObject = {
        id: object.id, kind: (object.link ? 'card' : object.kind === 'note' ? 'sticky' : object.kind === 'edgeless-text' ? 'text' : object.kind) as ObjectKind,
        xywh: [object.bounds.x, object.bounds.y, object.bounds.width, object.bounds.height],
        text: 'title' in element && element.title ? String(element.title) : object.text,
        color: typeof color === 'string' ? color : color && typeof color === 'object' && 'normal' in color ? String(color.normal) : undefined,
        rotate: object.rotation, shape: typeof object.shape === 'string' ? object.shape : undefined,
        parent: this.options.service.frame.getParentFrame(element)?.id ?? object.group,
        url: object.link?.url, from: connection?.source.objectId ?? undefined, to: connection?.target.objectId ?? undefined,
        children: element instanceof FrameBlockModel ? element.childElements.map(child=>child.id) : object.children, version: '',
      };
      const style = Object.fromEntries(['color', 'strokeColor', 'strokeWidth', 'strokeStyle', 'filled', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'textAlign', 'radius', 'lockedBySelf'].map(key => [key, key in element ? (element as unknown as Record<string, unknown>)[key] : undefined]));
      result.version = objectVersion({ ...result, layer: object.layer, connection, style });
      return result;
    });
  }

  read() {
    const { service } = this.options, objects = this.objects(), bound = service.viewport.viewportBounds;
    const viewport: Box = [bound.x, bound.y, bound.w, bound.h];
    const scene = describeScene(service, this.options.links, this.options.target(), this.options.title());
    const buckets = new Map<string, CanvasObject[]>();
    for (const object of objects) {
      if (overlaps(viewport, object.xywh)) continue;
      const key = object.parent ?? `${Math.floor(object.xywh[0] / 1500)}:${Math.floor(object.xywh[1] / 1500)}`;
      const members = buckets.get(key) ?? []; members.push(object); buckets.set(key, members);
    }
    const byId = new Map(objects.map(object => [object.id, object]));
    return {
      ...scene, version: 2, board: { id: this.options.boardId, title: this.options.title(), path: this.options.target().path },
      viewport: { x: bound.x, y: bound.y, w: bound.w, h: bound.h, zoom: service.zoom },
      selection: service.selection.selectedIds,
      objects: scene.objects.map(object => ({ ...byId.get(object.id), ...object, version: byId.get(object.id)?.version })),
      inView: objects.filter(object => overlaps(viewport, object.xywh)),
      offscreenClusters: [...buckets].map(([key, members]) => ({
        bbox: unionBounds(members), count: members.length,
        kinds: Object.fromEntries([...new Set(members.map(object => object.kind))].map(kind => [kind, members.filter(object => object.kind === kind).length])),
        frameTitle: objects.find(object => object.id === key)?.text,
        sample: members.filter(object => object.text).slice(0, 3).map(object => object.text.slice(0, 160)),
      })),
      lints: scene.connections.filter(edge => !edge.source.objectId || !edge.target.objectId).map(edge => ({ kind: 'unconnected-endpoint', ids: [edge.id] })),
      recentUserActions: this.recent.slice(-20), comments: [],
      agentTodo: this.options.editor.doc.spaceDoc.getMap('brainz:agent').get('todo') ?? [],
    };
  }

  private recordUserEdit() {
    const next = new Map(this.objects().map(object => [object.id, object.version]));
    const ids = [...new Set([...this.previous.keys(), ...next.keys()])].filter(id => this.previous.get(id) !== next.get(id));
    this.previous = next;
    if (!ids.length) return;
    const event = { at: new Date().toISOString(), actor: 'user', kind: 'updated', ids, summary: `Edited ${ids.length} canvas objects` };
    this.recent.push(event); if (this.recent.length > 20) this.recent.shift();
    this.options.post({ type: 'canvasEvent', event }); this.options.save();
  }

  submit(input: unknown): BatchResult {
    let plan: Plan;
    try {
      const { service } = this.options, bound = service.viewport.viewportBounds;
      plan = prepareBatch(input, this.objects(), { workspace: this.options.workspace, selection: service.selection.selectedIds, viewport: [bound.x, bound.y, bound.w, bound.h] });
    } catch (error) {
      const batchId = input && typeof input === 'object' && 'batchId' in input && typeof input.batchId === 'string' ? input.batchId : '';
      return this.report({ batchId, status: 'rejected', refs: {}, ops: [], message: error instanceof Error ? error.message : String(error) });
    }
    const { batch, result } = plan;
    const previous = this.batches.get(batch.batchId) ?? this.completed.get(batch.batchId) ?? this.pending.get(batch.batchId)?.result;
    if (previous) return this.report(previous);
    const now = performance.now(), recent = (this.arrivals.get(batch.actor) ?? []).filter(at => now - at < 1000);
    recent.push(now); this.arrivals.set(batch.actor, recent);
    if (recent.length > 10 || this.pending.size >= 20) return this.report({ ...result, status: 'rejected', message: recent.length > 10 ? 'rate_limited' : 'Review the pending proposals before adding more' });
    if (result.status === 'rejected') return this.report(result);
    if (batch.mode === 'direct' && !this.allowDirect) return this.report({ ...result, status: 'rejected', message: 'Direct edits are disabled for this canvas. Submit a staged proposal.' });
    this.pending.set(batch.batchId, plan);
    if (batch.mode === 'direct') return this.decide(batch.batchId, true);
    this.current ??= batch.batchId; this.render();
    return this.report(result);
  }

  status(batchId: string): BatchResult | undefined { return this.batches.get(batchId) ?? this.completed.get(batchId) ?? this.pending.get(batchId)?.result; }

  decide(batchId: string, apply: boolean): BatchResult {
    const plan = this.pending.get(batchId);
    if (!plan) return this.report(this.completed.get(batchId) ?? { batchId, status: 'rejected', refs: {}, ops: [], message: 'Proposal not found' });
    let result: BatchResult = { ...plan.result, status: 'discarded' };
    if (apply) {
      const current = new Map(this.objects().map(object => [object.id, object]));
      const conflict = [...plan.versions].find(([id, version]) => current.get(id)?.version !== version);
      if (conflict) {
        this.options.notice('An object changed while this proposal was pending. Ask the agent to read the canvas and try again.');
        result = { ...result, status: 'rejected', message: 'conflict', ops: [{ i: -1, status: 'conflict', current: current.get(conflict[0]), message: `Object ${conflict[0]} changed` }] };
      } else {
        try { result = this.commit(plan); }
        catch (error) { result = { ...result, status: 'rejected', refs: {}, message: String(error) }; this.options.notice('The proposal could not be applied. Your canvas has been restored.'); }
      }
    }
    this.pending.delete(batchId); this.completed.set(batchId, result);
    if (this.completed.size > 500) this.completed.delete(this.completed.keys().next().value!);
    if (this.current === batchId) this.current = this.pending.keys().next().value;
    this.render(); return this.report(result);
  }

  private report(result: BatchResult): BatchResult {
    this.options.post({ type: 'opsResult', batchId: result.batchId, result });
    return result;
  }

  private commit(plan: Plan): BatchResult {
    const { editor, service, links } = this.options, doc = editor.doc;
    const ids = new Map<string, string>(), resolve = (id: string) => ids.get(id) ?? id;
    const changed = new Set<string>(), at = new Date().toISOString();
    const undoCount = doc.history.undoStack.length;
    const previousRedo = [...doc.history.redoStack];
    const captureTimeout = doc.history.captureTimeout;
    this.recordUserEdit();
    this.applying = true;
    doc.captureSync();
    doc.history.captureTimeout = Infinity;
    try {
      // BlockSuite's Doc.transact catches callback errors. Use the underlying
      // Yjs transaction with its normal history origin so failures reach our
      // rollback handler instead of silently committing a partial batch.
      // Block models materialize at the end of a Yjs transaction. Flush each
      // operation before the next one resolves new frames or notes, retaining
      // one uninterrupted synchronous history capture for the whole proposal.
      for (const change of plan.changes) {
        doc.spaceDoc.transact(() => {
          if (change.op === 'create') {
            const object = change.object, id = this.create(object, resolve);
            ids.set(object.id, id); changed.add(id);
          } else if (change.op === 'update') {
            const id = resolve(change.id); this.update(id, change.set); changed.add(id);
          } else if (change.op === 'delete') {
            for (const id of change.ids.map(resolve)) {
              if (service.getElementById(id)) service.removeElement(id);
              links.delete(id); this.metadata.delete(id); changed.add(id);
            }
          } else if (change.op === 'reorder') {
            const element = service.getElementById(resolve(change.id));
            if (element) { service.reorderElement(element, change.direction); changed.add(element.id); }
          } else if (change.op === 'todo') doc.spaceDoc.getMap('brainz:agent').set('todo', change.items);
        }, doc.rootDoc.clientID);
      }
      doc.spaceDoc.transact(() => {
        for (const id of changed) {
          if (service.getElementById(id)) this.metadata.set(id, {
            ...this.metadata.get(id),
            createdBy: this.metadata.get(id)?.createdBy ?? plan.batch.actor, updatedBy: plan.batch.actor,
            at, opId: `${plan.batch.batchId}:${id}`, batchId: plan.batch.batchId,
          });
        }
        // The receipt travels with the document. A crash after saving but before
        // acknowledging the inbox must not apply the same batch a second time.
        this.batches.set(plan.batch.batchId, { ...plan.result, status: 'applied', refs: Object.fromEntries(Object.entries(plan.result.refs).map(([ref, id]) => [ref, resolve(id)])) });
      }, doc.rootDoc.clientID);
    } catch (error) {
      if (doc.history.undoStack.length > undoCount) {
        doc.undo(); doc.history.redoStack.splice(0, doc.history.redoStack.length, ...previousRedo);
      }
      throw error;
    } finally { doc.captureSync(); doc.history.captureTimeout = captureTimeout; this.applying = false; this.previous = new Map(this.objects().map(object => [object.id, object.version])); }
    for (const change of plan.changes) if (change.op === 'setView' && change.follow) service.viewport.setViewportByBound(new Bound(...change.bound), [80, 80, 80, 80], true);
    const result: BatchResult = {
      ...plan.result, status: 'applied', refs: Object.fromEntries(Object.entries(plan.result.refs).map(([ref, id]) => [ref, resolve(id)])),
      links: Object.fromEntries([...changed].filter(id => service.getElementById(id)).map(id => [id, boardLink(this.options.target(), [service.viewport.centerX, service.viewport.centerY, service.zoom], id)])),
    };
    service.selection.set({ elements: [...changed].filter(id => service.getElementById(id)), editing: false });
    this.options.save();
    this.options.notice(`${plan.batch.actor.replace(/^agent:/, '')} updated ${changed.size} ${changed.size === 1 ? 'object' : 'objects'} · ⌘Z to undo`);
    this.options.post({ type: 'canvasEvent', event: { at, actor: plan.batch.actor, kind: 'batch', ids: [...changed], summary: `Applied ${plan.batch.ops.length} canvas operations`, batchId: plan.batch.batchId } });
    return result;
  }

  private create(object: CanvasObject, resolve: (id: string) => string): string {
    const { editor, service } = this.options, doc = editor.doc;
    const color = palette[object.color ?? 'amber'] ?? palette.amber;
    const xywh = new Bound(...object.xywh).serialize();
    let id: string;
    if (object.kind === 'sticky') {
      id = doc.addBlock('affine:note', { xywh, index: service.generateIndex(), background: { normal: color }, displayMode: NoteDisplayMode.EdgelessOnly,
        edgeless: { collapse: true, collapsedHeight: object.xywh[3], style: { borderRadius: 14, borderSize: 0, borderStyle: StrokeStyle.Solid, shadowType: NoteShadow.Box } } }, doc.root);
      doc.addBlock('affine:paragraph', { type: 'text', text: new Text(object.text) }, id);
    } else if (object.kind === 'frame') {
      id = doc.addBlock('affine:frame', { title: new Text(object.text), background: {normal:color}, xywh, index: service.generateIndex(), presentationIndex: service.frame.generatePresentationIndex(), childElementIds: {} }, service.surface);
    } else if (object.kind === 'group') {
      id = service.createGroup((object.children ?? []).map(resolve));
      if (object.text) service.surface.updateElement(id,{title:new Y.Text(object.text)});
    }
    else if (object.kind === 'connector') {
      id = service.surface.addElement({ type: 'connector', index: service.generateIndex(),
        source: { id: resolve(object.from!), position: [1, 0.5] }, target: { id: resolve(object.to!), position: [0, 0.5] },
        mode: object.mode === 'straight' ? ConnectorMode.Straight : object.mode === 'curve' ? ConnectorMode.Curve : ConnectorMode.Orthogonal,
        frontEndpointStyle: ['start', 'both'].includes(object.arrow ?? '') ? PointStyle.Arrow : PointStyle.None,
        rearEndpointStyle: ['end', 'both'].includes(object.arrow ?? 'end') ? PointStyle.Arrow : PointStyle.None,
        stroke: color, strokeWidth: 2, text: new Y.Text(object.text), fontFamily: FontFamily.Inter, color: '#e5e3da' });
    } else if (object.kind === 'text') {
      id = service.surface.addElement({ type: 'text', index: service.generateIndex(), xywh, text: new Y.Text(object.text), fontFamily: FontFamily.Inter, fontSize: 20, color, hasMaxWidth: true });
    } else {
      id = service.surface.addElement({ type: 'shape', index: service.generateIndex(), xywh,
        shapeType: object.shape && object.shape !== 'roundedRect' ? object.shape : ShapeType.Rect,
        radius: object.shape === 'rect' ? 0 : 0.1, shapeStyle: ShapeStyle.General, filled: true,
        fillColor: color, strokeColor: '#a6b995', strokeWidth: 2, fontFamily: FontFamily.Inter, fontSize: 18,
        color: object.color === 'black' || object.color === 'transparent' ? '#e5e3da' : '#292c28', text: new Y.Text(object.text) });
    }
    if (object.url) this.options.links.set(id, { title: object.text, url: object.url });
    if (object.parent) {
      const parent = service.getElementById(resolve(object.parent)), element = service.getElementById(id);
      if (parent instanceof FrameBlockModel && element) parent.addChild(element);
    }
    return id;
  }

  private update(id: string, set: Partial<CanvasObject>) {
    const { editor, service, links } = this.options, element = service.getElementById(id);
    if (!element) throw new Error(`Object ${id} is missing`);
    const properties: Record<string, unknown> = {};
    if (set.xywh) properties.xywh = new Bound(...set.xywh).serialize();
    if (set.rotate !== undefined) properties.rotate = set.rotate;
    if (set.shape) { properties.shapeType = set.shape === 'roundedRect' ? ShapeType.Rect : set.shape; properties.radius = set.shape === 'roundedRect' ? 0.1 : 0; }
    if (set.color) {
      const property = element instanceof NoteBlockModel || element instanceof FrameBlockModel ? 'background' : 'fillColor' in element ? 'fillColor' : 'stroke' in element ? 'stroke' : 'color';
      properties[property] = { normal: palette[set.color] };
    }
    if (set.text !== undefined) {
      if (element instanceof NoteBlockModel) {
        const oldChildren = [...element.children];
        const first = element.children.find(child => child.flavour === 'affine:paragraph');
        if (first) editor.doc.updateBlock(first, { text: new Text(set.text) });
        else editor.doc.addBlock('affine:paragraph', { type: 'text', text: new Text(set.text) }, element);
        for (const child of oldChildren.filter(child => child !== first && child.flavour === 'affine:paragraph')) editor.doc.deleteBlock(child);
      } else if (element instanceof FrameBlockModel) properties.title = new Text(set.text);
      else if ('type' in element && element.type === 'group') properties.title = new Y.Text(set.text);
      else properties.text = new Y.Text(set.text);
    }
    service.gfx.updateElement(element, properties);
    if (set.url) links.set(id, { title: set.text ?? links.get(id)?.title ?? 'Linked item', url: set.url });
    else if (set.text !== undefined && links.has(id)) links.set(id, { ...links.get(id)!, title: set.text });
  }

  private render() {
    this.overlay.replaceChildren();
    const plan = this.current ? this.pending.get(this.current) : undefined;
    this.review.hidden = !plan;
    document.getElementById('app')!.classList.toggle('has-agent-proposal', Boolean(plan));
    if (!plan) return;
    const { service } = this.options;
    const definitions = document.createElementNS(svgNamespace, 'defs');
    const marker = document.createElementNS(svgNamespace, 'marker');
    for (const [key, value] of Object.entries({id:'agent-arrow',viewBox:'0 0 10 10',refX:'9',refY:'5',markerWidth:'7',markerHeight:'7',orient:'auto-start-reverse'})) marker.setAttribute(key,value);
    const tip = document.createElementNS(svgNamespace, 'path'); tip.setAttribute('d','M1 1 L9 5 L1 9'); tip.setAttribute('fill','none'); tip.setAttribute('stroke','#e2c76b'); tip.setAttribute('stroke-width','1.5');
    marker.append(tip); definitions.append(marker); this.overlay.append(definitions);
    const deleted = new Set(plan.changes.flatMap(change=>change.op === 'delete' ? change.ids : []));
    const original = new Map(this.objects().map(object=>[object.id,object]));
    const changed = new Set(plan.changes.flatMap(change => change.op === 'create' ? [change.object.id] : change.op === 'update' ? [change.id] : change.op === 'delete' ? change.ids : []));
    this.heading.textContent = `${plan.batch.actor.replace(/^agent:/, '')} · ${changed.size} proposed ${changed.size === 1 ? 'object' : 'objects'}`;
    const messages = plan.changes.filter((change): change is Extract<Change, {op: 'message'}> => change.op === 'message');
    this.detail.textContent = messages.at(-1)?.text ?? `${plan.batch.ops.length} operations${this.pending.size > 1 ? ` · ${this.pending.size} proposals waiting` : ''} · Enter to apply · Esc to discard`;
    for (const id of changed) {
      const object = plan.objects.get(id) ?? (deleted.has(id) ? original.get(id) : undefined);
      if (!object) continue;
      const [x, y] = service.viewport.toViewCoord(object.xywh[0], object.xywh[1]);
      if (object.kind === 'connector') {
        const from = plan.objects.get(object.from!) ?? original.get(object.from!), to = plan.objects.get(object.to!) ?? original.get(object.to!);
        if (!from || !to) continue;
        const start = service.viewport.toViewCoord(from.xywh[0] + from.xywh[2], from.xywh[1] + from.xywh[3] / 2);
        const end = service.viewport.toViewCoord(to.xywh[0], to.xywh[1] + to.xywh[3] / 2);
        const line = document.createElementNS(svgNamespace, 'path');
        const middle = (start[0] + end[0]) / 2;
        line.setAttribute('d', object.mode === 'straight' ? `M${start} L${end}` : object.mode === 'curve' ? `M${start} C${middle},${start[1]} ${middle},${end[1]} ${end}` : `M${start} L${middle},${start[1]} L${middle},${end[1]} L${end}`);
        if (['start','both'].includes(object.arrow ?? 'end')) line.setAttribute('marker-start','url(#agent-arrow)');
        if (['end','both'].includes(object.arrow ?? 'end')) line.setAttribute('marker-end','url(#agent-arrow)');
        line.setAttribute('fill', 'none'); line.setAttribute('stroke', deleted.has(id) ? '#ed8c89' : '#e2c76b'); line.setAttribute('stroke-width', '2'); line.setAttribute('stroke-dasharray', '6 4'); this.overlay.append(line);
        if (object.text) {
          const label = document.createElementNS(svgNamespace,'text'); label.setAttribute('x',String(middle)); label.setAttribute('y',String((start[1]+end[1])/2-10)); label.setAttribute('text-anchor','middle'); label.setAttribute('fill','#e5e3da'); label.setAttribute('font-size','13');
          label.setAttribute('paint-order','stroke'); label.setAttribute('stroke','#141413'); label.setAttribute('stroke-width','5'); label.textContent = object.text.slice(0,40); this.overlay.append(label);
        }
        continue;
      }
      const group = document.createElementNS(svgNamespace, 'g'); group.setAttribute('transform', `translate(${x} ${y}) scale(${service.zoom})`);
      const [, , width, height] = object.xywh;
      if (object.rotate) group.setAttribute('transform', `${group.getAttribute('transform')} rotate(${object.rotate} ${width/2} ${height/2})`);
      const rect = document.createElementNS(svgNamespace, object.shape === 'ellipse' ? 'ellipse' : ['diamond','triangle'].includes(object.shape ?? '') ? 'polygon' : 'rect');
      if (object.shape === 'ellipse') { rect.setAttribute('cx',String(width/2)); rect.setAttribute('cy',String(height/2)); rect.setAttribute('rx',String(width/2)); rect.setAttribute('ry',String(height/2)); }
      else if (object.shape === 'diamond') rect.setAttribute('points',`${width/2},0 ${width},${height/2} ${width/2},${height} 0,${height/2}`);
      else if (object.shape === 'triangle') rect.setAttribute('points',`${width/2},0 ${width},${height} 0,${height}`);
      else { rect.setAttribute('width',String(width)); rect.setAttribute('height',String(height)); rect.setAttribute('rx',object.shape === 'rect' ? '0' : '12'); }
      rect.setAttribute('fill', palette[object.color ?? 'black'] ?? '#292c28'); rect.setAttribute('fill-opacity', '0.65');
      rect.setAttribute('stroke', deleted.has(id) ? '#ed8c89' : '#e2c76b'); rect.setAttribute('stroke-width', String(2 / service.zoom)); rect.setAttribute('stroke-dasharray', '7 5');
      const centered = object.kind === 'shape';
      const text = document.createElementNS(svgNamespace, 'text'); text.setAttribute('x',String(centered ? width/2 : 16)); text.setAttribute('y',String(centered ? height/2+6 : 30));
      if (centered) text.setAttribute('text-anchor','middle');
      text.setAttribute('fill', object.color === 'black' || object.color === 'transparent' ? '#e5e3da' : '#20211e'); text.setAttribute('font-size', '16');
      const maximum = Math.max(1,Math.floor((width-(centered ? width/2 : 32))/9));
      text.textContent = object.text.length > maximum ? `${object.text.slice(0,maximum-1)}…` : object.text;
      if (deleted.has(id)) { text.textContent = 'Remove'; text.setAttribute('fill','#ed8c89'); }
      group.append(rect, text); this.overlay.append(group);
    }
  }
}
