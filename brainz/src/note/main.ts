import { effects as presetEffects } from '@blocksuite/presets/effects';
import { effects as blockEffects } from '@blocksuite/blocks/effects';
import { PageEditor } from '@blocksuite/presets';
import { AffineSchemas, AffineSlashMenuWidget, MarkdownAdapter, ThemeProvider } from '@blocksuite/blocks';
import { DocCollection, Job, Schema, Text, type BlockModel, type Doc } from '@blocksuite/store';
import { ColorScheme, FontFamily } from '@blocksuite/affine-model';
import { FontConfigExtension, FontLoaderService } from '@blocksuite/affine-shared/services';
import { combinedDarkCssVariables } from '@toeverything/theme';
import * as Y from 'yjs';
import { assemble, isContent, type Segment, type TopBlock } from './segments';
import { splitMarkdown } from './split';
import './note.css';

// Notes are plain Markdown, where "$" is money, not math: "$5 and $6" must not
// become a formula. Brainz's engine patch reads this switch; the canvas keeps math.
(globalThis as { __brainzMarkdownMath?: boolean }).__brainzMarkdownMath = false;

type Incoming =
  | { type: 'load'; path: string; readOnly: boolean; segments: Segment[] }
  | { type: 'focus' }
  | { type: 'saved'; revision: number };

declare global {
  interface Window {
    ipc?: { postMessage(message: string): void };
    brainzNote?: { receive(message: Incoming): void };
    __brainzNote?: unknown;
  }
}

blockEffects();
presetEffects();

// Kinds the Markdown adapter cannot be trusted with stay raw: they show as
// Markdown code and are written back as typed.
const RAW_KINDS = new Set(['html', 'footnote', 'other']);
const SAVE_DELAY = 400;

for (const [property, value] of Object.entries(combinedDarkCssVariables)) document.documentElement.style.setProperty(property, String(value));
const theme: Record<string, string> = {
  '--affine-font-family': "'Brainz Canvas', Gellix, sans-serif",
  '--affine-background-primary-color': '#141413',
  '--affine-background-secondary-color': '#22221f',
  '--affine-background-overlay-panel-color': '#282823',
  '--affine-text-primary-color': '#e5e3da',
  '--affine-text-secondary-color': '#99988e',
  '--affine-primary-color': '#e2c76b',
  '--affine-brand-color': '#e2c76b',
  '--affine-link-color': '#e2c76b',
  '--affine-border-color': '#3b3b34',
  '--affine-hover-color': '#d8c87a26',
  '--affine-tooltip': '#2e2e28',
  '--affine-editor-width': '760px',
};
for (const [key, value] of Object.entries(theme)) document.documentElement.style.setProperty(key, value);

// Only offer blocks that have a Markdown form; AFFiNE docs, databases,
// embeds and attachments would be lost on save.
{
  type Item = (typeof AffineSlashMenuWidget.DEFAULT_CONFIG.items)[number];
  const dropGroups = new Set(['Page', 'Database', 'Document Group & Frame']);
  const dropNames = new Set(['Inline equation', 'Equation', 'Underline']);
  const kept: Item[] = [];
  let group = '';
  for (const item of AffineSlashMenuWidget.DEFAULT_CONFIG.items) {
    if (typeof item === 'function') continue;
    if ('groupName' in item) { group = item.groupName; kept.push(item); continue; }
    if (dropGroups.has(group) || dropNames.has(item.name)) continue;
    if (group === 'Content & Media' && item.name !== 'Link') continue;
    kept.push(item);
  }
  const items = kept.filter((item, index) => !('groupName' in item) || (index + 1 < kept.length && !('groupName' in kept[index + 1])));
  AffineSlashMenuWidget.DEFAULT_CONFIG = { ...AffineSlashMenuWidget.DEFAULT_CONFIG, items };
}

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = '<main id="note" aria-label="Note"></main><button class="source-toggle" type="button" title="View Markdown source (⇧⌘M)">Markdown <kbd>⇧⌘M</kbd></button>';
const host = document.getElementById('note')!;

const collection = new DocCollection({ id: 'brainz-note', schema: new Schema().register(AffineSchemas) });
collection.meta.initialize();
const editor = new PageEditor();
editor.specs = [...editor.specs, FontConfigExtension(Object.values(FontFamily).flatMap(font => ['normal', 'italic'].flatMap(style => ['300', '400', '500', '600', '700'].map(weight => ({ font, style, weight, url: `fonts/Brainz-${style === 'italic' ? 'Italic' : 'Regular'}.ttf` })))))];

interface Loaded {
  doc: Doc;
  noteId: string;
  segments: Segment[];
  /** Segment id → the top-level block ids it produced. */
  original: Map<number, string[]>;
  /** Every block imported at load (any depth) → its segment. */
  segmentOf: Map<string, number>;
  raw: Set<string>;
  dirty: Set<number>;
  /** Set once the structure or any block changed, so an untouched note never writes. */
  touched: boolean;
}
let current: Loaded | undefined;
let generation = 0;
let revision = 0;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let lastSaved: string | undefined;

function post(message: Record<string, unknown>) {
  if (window.ipc) window.ipc.postMessage(JSON.stringify(message));
  else console.debug('[brainz-note]', message);
}

function newJob() { return new Job({ collection, middlewares: [] }); }

async function importSegment(doc: Doc, noteId: string, segment: Segment): Promise<{ ids: string[]; raw: boolean }> {
  const rawBlock = () => [doc.addBlock('affine:code', { text: new Text(segment.text), language: 'markdown' }, noteId)];
  // Images need their files loaded through Brainz; keep them as Markdown for now.
  if (RAW_KINDS.has(segment.kind) || segment.text.includes('![')) return { ids: rawBlock(), raw: true };
  try {
    const job = newJob();
    const adapter = new MarkdownAdapter(job);
    const slice = await adapter.toSliceSnapshot({ file: segment.text, assets: job.assetsManager, workspaceId: collection.id, pageId: doc.id });
    const snapshots = slice?.content.flatMap(content => content.children) ?? [];
    const ids: string[] = [];
    for (const snapshot of snapshots) {
      const model = await job.snapshotToBlock(snapshot, doc, noteId);
      if (model) ids.push(model.id);
    }
    if (ids.length > 0) return { ids, raw: false };
  } catch (error) {
    console.warn('Markdown import fell back to raw text', error);
  }
  return { ids: rawBlock(), raw: true };
}

function descendants(model: BlockModel): BlockModel[] {
  return [model, ...model.children.flatMap(descendants)];
}

function topLevelOf(state: Loaded, id: string): string | undefined {
  let model: BlockModel | null = state.doc.getBlock(id)?.model ?? null;
  while (model && model.parent && model.parent.id !== state.noteId) model = model.parent;
  return model?.parent?.id === state.noteId ? model.id : undefined;
}

function markChanged(state: Loaded, id: string, parent?: string) {
  if (id === state.noteId) { state.touched = true; return; }
  const top = topLevelOf(state, id) ?? (parent && parent !== state.noteId ? topLevelOf(state, parent) : undefined);
  const segment = (top ? state.segmentOf.get(top) : undefined) ?? state.segmentOf.get(id) ?? (parent ? state.segmentOf.get(parent) : undefined);
  if (segment !== undefined) state.dirty.add(segment);
  state.touched = true;
}

/** The bullet the note already uses for this list, or "-" for a new one. */
function bulletFor(state: Loaded, id: string): string {
  const segment = state.segmentOf.get(id);
  const text = segment === undefined ? '' : state.segments.find(entry => entry.id === segment)?.text ?? '';
  return /^\s*([-*+])\s/m.exec(text)?.[1] ?? '-';
}

// The adapter always writes "*" bullets.
const withBullet = (markdown: string, bullet: string) => bullet === '*' ? markdown : markdown.replace(/^(\s*)\* /gm, `$1${bullet} `);

async function serializeRun(state: Loaded, ids: string[]): Promise<string> {
  const note = state.doc.getBlock(state.noteId)?.model;
  if (!note) return '';
  // The adapter joins sibling paragraphs with a single newline, which would
  // merge them on the next read; only list items belong together.
  const groups: string[][] = [];
  for (const id of ids) {
    const isList = state.doc.getBlock(id)?.model.flavour === 'affine:list' && !state.raw.has(id);
    const previous = groups.at(-1);
    const previousIsList = previous !== undefined && state.doc.getBlock(previous[0])?.model.flavour === 'affine:list' && !state.raw.has(previous[0]);
    if (isList && previousIsList) previous.push(id); else groups.push([id]);
  }
  const chunks: string[] = [];
  for (const group of groups) {
    if (state.raw.has(group[0])) {
      const model = state.doc.getBlock(group[0])?.model as (BlockModel & { text?: Text }) | undefined;
      chunks.push(model?.text?.toString() ?? '');
      continue;
    }
    const job = newJob();
    const snapshot = job.blockToSnapshot(note);
    if (!snapshot) continue;
    const wanted = new Set(group);
    snapshot.children = snapshot.children.filter(child => wanted.has(child.id));
    const result = await new MarkdownAdapter(job).fromBlockSnapshot({ snapshot, assets: job.assetsManager });
    chunks.push(withBullet(result.file.replace(/\n+$/, ''), bulletFor(state, group[0])));
  }
  return chunks.filter(chunk => chunk.length > 0).join('\n\n');
}

async function render(state: Loaded): Promise<string> {
  const note = state.doc.getBlock(state.noteId)?.model;
  const blocks: TopBlock[] = (note?.children ?? []).map(child => ({ id: child.id, segment: state.segmentOf.get(child.id) ?? null }));
  // A top-level block is only "from" a segment if it was top-level there at load.
  for (const block of blocks) if (block.segment !== null && !state.original.get(block.segment)?.includes(block.id)) block.segment = null;
  return assemble(state.segments, blocks, state.original, state.dirty, ids => serializeRun(state, ids));
}

async function save() {
  clearTimeout(saveTimer); saveTimer = undefined;
  const state = current;
  if (!state || !state.touched || state.doc.readonly) return;
  const markdown = await render(state);
  if (state !== current || markdown === lastSaved) return;
  lastSaved = markdown;
  post({ type: 'save', revision: ++revision, markdown });
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { void save().catch(reportError); }, SAVE_DELAY);
}

function reportError(error: unknown) {
  post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
}

async function load(path: string, readOnly: boolean, segments: Segment[]) {
  const token = ++generation;
  const scroll = host.scrollTop;
  const hadFocus = host.contains(document.activeElement);
  const doc = collection.createDoc({ id: `note-${token}` });
  doc.load();
  const page = doc.addBlock('affine:page', { title: new Text('') });
  doc.addBlock('affine:surface', {}, page);
  const noteId = doc.addBlock('affine:note', {}, page);
  const state: Loaded = { doc, noteId, segments, original: new Map(), segmentOf: new Map(), raw: new Set(), dirty: new Set(), touched: false };
  for (const segment of segments) {
    if (!isContent(segment)) continue;
    const { ids, raw } = await importSegment(doc, noteId, segment);
    if (token !== generation) return;
    state.original.set(segment.id, ids);
    for (const id of ids) {
      if (raw) state.raw.add(id);
      const model = doc.getBlock(id)?.model;
      for (const block of model ? descendants(model) : []) state.segmentOf.set(block.id, segment.id);
    }
  }
  // An empty note still needs somewhere to type.
  if (segments.every(segment => !isContent(segment))) doc.addBlock('affine:paragraph', {}, noteId);
  doc.resetHistory();
  if (readOnly) {
    const blockCollection = (doc as unknown as { blockCollection: Parameters<typeof doc.awarenessStore.setReadonly>[0] }).blockCollection;
    doc.awarenessStore.setReadonly(blockCollection, true);
  }
  const previous = current;
  current = state;
  lastSaved = segments.map(segment => segment.text).join('');
  document.body.classList.toggle('read-only', readOnly);
  document.title = path.split('/').pop() || 'Note';
  editor.doc = doc;
  if (!editor.isConnected) host.append(editor);
  await editor.updateComplete;
  await editor.std.get(FontLoaderService).ready;
  editor.std.get(ThemeProvider).app$.value = ColorScheme.Dark;
  host.scrollTop = scroll;
  // The editor normalises some blocks as it mounts (an unknown code
  // language resets, for one); only changes after that are edits.
  await new Promise(requestAnimationFrame);
  await new Promise(requestAnimationFrame);
  if (token !== generation) return;
  doc.slots.blockUpdated.on(event => {
    if (token !== generation) return;
    markChanged(state, event.id, event.type === 'delete' ? event.parent : undefined);
    scheduleSave();
  });
  // Typing changes a block's Y.Text without a blockUpdated event.
  doc.spaceDoc.getMap('blocks').observeDeep((events: Y.YEvent<Y.AbstractType<unknown>>[]) => {
    if (token !== generation) return;
    for (const event of events) {
      const id = event.path[0];
      if (typeof id === 'string') markChanged(state, id);
    }
    scheduleSave();
  });
  if (previous) collection.removeDoc(previous.doc.id);
  if (hadFocus) focusEditor();
}

function focusEditor() {
  const first = host.querySelector<HTMLElement>('[contenteditable="true"]');
  first?.focus();
}

window.brainzNote = {
  receive(message: Incoming) {
    if (message.type === 'load') void load(message.path, message.readOnly, message.segments).catch(reportError);
    else if (message.type === 'focus') focusEditor();
    else if (message.type === 'saved') revision = Math.max(revision, message.revision);
  },
};

document.querySelector('.source-toggle')!.addEventListener('click', () => post({ type: 'source' }));
window.addEventListener('keydown', event => {
  if (!event.metaKey) return;
  const key = event.key.toLowerCase();
  if (key === 's' && !event.shiftKey) { event.preventDefault(); void save().catch(reportError); }
  else if (key === 'm' && event.shiftKey) { event.preventDefault(); post({ type: 'source' }); }
}, true);
// AppKit can hand navigation keys to the page as text: function-key codes
// (U+F700-U+F8FF) or control characters such as 0x01 for Home. A note never
// wants those typed into it, so the input is dropped before BlockSuite sees it.
const strayKeyText = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uF700-\uF8FF]/;
window.addEventListener('beforeinput', event => {
  if (event.data && strayKeyText.test(event.data)) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}, true);
window.addEventListener('blur', () => { if (saveTimer) void save().catch(reportError); });
host.addEventListener('focusout', () => { if (saveTimer) void save().catch(reportError); });
// Links open through Brainz; the web view never navigates away from the note.
document.addEventListener('click', event => {
  const anchor = (event.composedPath().find(node => node instanceof HTMLAnchorElement) as HTMLAnchorElement | undefined);
  const href = anchor?.getAttribute('href');
  if (!href) return;
  event.preventDefault(); event.stopPropagation();
  post({ type: 'open', href });
}, true);

const sample = '# Welcome to Brainz notes\n\nType `/` for blocks, drag the handle to move them. Links like [the plan](plan.md) open in Brainz.\n\n## This week\n\n- [ ] Try a checklist\n- [x] Done already\n\n> Notes save back to Markdown.\n\n```ts\nconst saved = true;\n```\n\n1. First\n2. Second\n';
if (import.meta.env.DEV || !window.ipc) {
  window.__brainzNote = {
    load: (markdown: string, readOnly = false) => load('preview.md', readOnly, splitMarkdown(markdown)),
    render: () => current ? render(current) : Promise.resolve(''),
    get state() { return current; },
    editor,
  };
}
post({ type: 'ready' });
if (!window.ipc) void load('preview.md', false, splitMarkdown(sample));
