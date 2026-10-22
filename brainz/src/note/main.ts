import { effects as presetEffects } from '@blocksuite/presets/effects';
import { effects as blockEffects } from '@blocksuite/blocks/effects';
import { PageEditor } from '@blocksuite/presets';
import { AffineSchemas, AffineSlashMenuWidget, MarkdownAdapter, ThemeProvider } from '@blocksuite/blocks';
import { DocCollection, Job, Schema, Text, type BlockModel, type Doc } from '@blocksuite/store';
import { ColorScheme, FontFamily } from '@blocksuite/affine-model';
import { FontConfigExtension, FontLoaderService } from '@blocksuite/affine-shared/services';
import { LinkedDocIcon } from '@blocksuite/affine-components/icons';
import { ConfigExtension } from '@blocksuite/block-std';
import type { InlineEditor } from '@blocksuite/inline';
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
  | { type: 'saved'; revision: number }
  | { type: 'imageSaved'; request: number; src: string }
  | { type: 'imageFailed'; request: number; message: string }
  | { type: 'notes'; current: string; notes: NoteEntry[] }
  | { type: 'backlinks'; items: Backlink[] };

/** A note in the brain, by its path from the brain's folder. */
export interface NoteEntry { path: string; title: string }
export interface Backlink { path: string; title: string; snippet: string }

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
  const keptMedia = new Set(['Link', 'Image']);
  const kept: Item[] = [];
  let group = '';
  for (const item of AffineSlashMenuWidget.DEFAULT_CONFIG.items) {
    if (typeof item === 'function') continue;
    if ('groupName' in item) { group = item.groupName; kept.push(item); continue; }
    if (dropGroups.has(group) || dropNames.has(item.name)) continue;
    if (group === 'Content & Media' && !keptMedia.has(item.name)) continue;
    kept.push(item);
  }
  const items = kept.filter((item, index) => !('groupName' in item) || (index + 1 < kept.length && !('groupName' in kept[index + 1])));
  AffineSlashMenuWidget.DEFAULT_CONFIG = { ...AffineSlashMenuWidget.DEFAULT_CONFIG, items };
}

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = '<main id="note" aria-label="Note"></main><button class="source-toggle" type="button" title="View Markdown source (⇧⌘M)">Markdown <kbd>⇧⌘M</kbd></button><button class="copy-chip" type="button" hidden>Copy</button>';
const host = document.getElementById('note')!;

let notes: NoteEntry[] = [];
let notePath = 'preview.md';

/** The Markdown link from one note to another, both given from the brain's folder. */
export function relativeLink(from: string, to: string): string {
  const fromFolder = from.split('/').slice(0, -1);
  const target = to.split('/');
  let common = 0;
  while (common < fromFolder.length && common < target.length - 1 && fromFolder[common] === target[common]) common++;
  return [...fromFolder.slice(common).map(() => '..'), ...target.slice(common)].map(encodeURIComponent).join('/');
}

/** Notes whose title or path holds every word typed, best first. */
export function matchNotes(query: string, entries: NoteEntry[], exclude: string, limit = 8): NoteEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const lower = query.trim().toLowerCase();
  return entries
    .filter(entry => entry.path !== exclude)
    .filter(entry => { const haystack = `${entry.title} ${entry.path}`.toLowerCase(); return words.every(word => haystack.includes(word)); })
    .map(entry => ({ entry, rank: entry.title.toLowerCase().startsWith(lower) ? 0 : entry.title.toLowerCase().includes(lower) ? 1 : 2 }))
    .sort((a, b) => a.rank - b.rank || a.entry.path.length - b.entry.path.length || a.entry.path.localeCompare(b.entry.path))
    .slice(0, limit)
    .map(({ entry }) => entry);
}

function insertNoteLink(inlineEditor: InlineEditor, note: NoteEntry) {
  const range = inlineEditor.getInlineRange();
  if (!range) return;
  const title = note.title || note.path.split('/').pop()!.replace(/\.md$/i, '');
  inlineEditor.insertText({ index: range.index, length: 0 }, title, { link: relativeLink(notePath, note.path) } as never);
  inlineEditor.insertText({ index: range.index + title.length, length: 0 }, ' ');
  inlineEditor.setInlineRange({ index: range.index + title.length + 1, length: 0 });
}

const collection = new DocCollection({ id: 'brainz-note', schema: new Schema().register(AffineSchemas) });
collection.meta.initialize();
const editor = new PageEditor();
// "[[" lists the brain's notes and inserts a Markdown link to the one picked.
const notesMenu = ConfigExtension('affine:page', {
  linkedWidget: {
    triggerKeys: ['[['],
    convertTriggerKey: false,
    ignoreBlockTypes: ['affine:code'],
    getMenus: (query: string, abort: () => void, _host: unknown, inlineEditor: InlineEditor) => Promise.resolve([{
      name: notes.length ? 'Link to a note' : 'No notes found',
      items: matchNotes(query, notes, notePath).map(note => ({
        key: note.path,
        name: note.title,
        icon: LinkedDocIcon,
        action: () => { abort(); insertNoteLink(inlineEditor, note); },
      })),
      maxDisplay: 8,
    }]),
  },
});
editor.specs = [...editor.specs, notesMenu, FontConfigExtension(Object.values(FontFamily).flatMap(font => ['normal', 'italic'].flatMap(style => ['300', '400', '500', '600', '700'].map(weight => ({ font, style, weight, url: `fonts/Brainz-${style === 'italic' ? 'Italic' : 'Regular'}.ttf` })))))];

interface Loaded {
  doc: Doc;
  noteId: string;
  segments: Segment[];
  /** Segment id → the top-level block ids it produced. */
  original: Map<number, string[]>;
  /** Every block imported at load (any depth) → its segment. */
  segmentOf: Map<string, number>;
  raw: Set<string>;
  /** Image block → the Markdown it was read from, so an untouched image keeps its path. */
  images: Map<string, ImageRef & { sourceId: string }>;
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

/** `![alt](src)` alone on a line; `|300` after the alt is Obsidian's width. */
export interface ImageRef { src: string; alt: string; width: number }
const imageLine = /^!\[([^\]]*)\]\((?:<([^>]+)>|([^)\s]+))(?:\s+"[^"]*")?\)$/;

export function parseImage(text: string): ImageRef | null {
  const match = imageLine.exec(text.trim());
  if (!match) return null;
  const [alt, size] = match[1].split('|');
  return { src: match[2] ?? match[3], alt: size !== undefined && /^\d+$/.test(size.trim()) ? alt : match[1], width: size !== undefined && /^\d+$/.test(size.trim()) ? Number(size) : 0 };
}

export function imageMarkdown(image: ImageRef): string {
  const alt = image.alt.replace(/[\[\]\n]/g, ' ') + (image.width > 0 ? `|${Math.round(image.width)}` : '');
  const src = /[\s()]/.test(image.src) ? `<${image.src}>` : image.src;
  return `![${alt}](${src})`;
}

const isExternal = (src: string) => /^[a-z][a-z0-9+.-]*:/i.test(src);

/** Files in the brain are read through Brainz, relative to the open note. */
async function fetchBrainImage(src: string): Promise<Blob | null> {
  const response = await fetch(`brain-file?path=${encodeURIComponent(src)}`).catch(() => null);
  if (!response?.ok) return null;
  const blob = await response.blob();
  return blob.type.startsWith('image/') ? blob : null;
}

let imageRequests = 0;
const pendingImages = new Map<number, { resolve(src: string): void; reject(error: Error): void }>();

/** Writes a pasted or dropped image next to the note and returns its Markdown path. */
async function persistImage(blob: Blob): Promise<string> {
  const request = ++imageRequests;
  if (!window.ipc) return `attachments/image-${request}.${blob.type.split('/')[1] || 'png'}`;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  const saved = new Promise<string>((resolve, reject) => pendingImages.set(request, { resolve, reject }));
  post({ type: 'image', request, mime: blob.type || 'image/png', data: btoa(binary) });
  return saved;
}

async function importSegment(state: Loaded, segment: Segment): Promise<{ ids: string[]; raw: boolean }> {
  const { doc, noteId } = state;
  const rawBlock = () => [doc.addBlock('affine:code', { text: new Text(segment.text), language: 'markdown' }, noteId)];
  const image = segment.kind === 'paragraph' ? parseImage(segment.text) : null;
  if (image && !isExternal(image.src)) {
    const blob = await fetchBrainImage(image.src);
    if (blob) {
      const sourceId = `brain-image:${image.src}`;
      await doc.blobSync.set(sourceId, blob);
      const id = doc.addBlock('affine:image', { sourceId, caption: image.alt, width: image.width }, noteId);
      state.images.set(id, { ...image, sourceId });
      return { ids: [id], raw: false };
    }
  }
  // Web images, missing files and images inside text stay as Markdown.
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
    const block = state.doc.getBlock(group[0])?.model as (BlockModel & { sourceId?: string; caption?: string; width?: number }) | undefined;
    if (block?.flavour === 'affine:image') {
      const known = state.images.get(group[0]);
      let src = known && known.sourceId === block.sourceId ? known.src : undefined;
      if (src === undefined) {
        const blob = block.sourceId ? await state.doc.blobSync.get(block.sourceId) : null;
        if (!blob) continue;
        src = await persistImage(blob);
        state.images.set(group[0], { src, alt: block.caption ?? '', width: block.width ?? 0, sourceId: block.sourceId ?? '' });
      }
      chunks.push(imageMarkdown({ src, alt: block.caption ?? '', width: block.width ?? 0 }));
      continue;
    }
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
  // Another note's backlinks must not linger; Brainz sends this note's next.
  if (document.title !== (path.split('/').pop() || 'Note')) renderBacklinks([]);
  const scroll = host.scrollTop;
  const hadFocus = host.contains(document.activeElement);
  const doc = collection.createDoc({ id: `note-${token}` });
  doc.load();
  const page = doc.addBlock('affine:page', { title: new Text('') });
  doc.addBlock('affine:surface', {}, page);
  const noteId = doc.addBlock('affine:note', {}, page);
  const state: Loaded = { doc, noteId, segments, original: new Map(), segmentOf: new Map(), raw: new Set(), images: new Map(), dirty: new Set(), touched: false };
  for (const segment of segments) {
    if (!isContent(segment)) continue;
    const { ids, raw } = await importSegment(state, segment);
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
  if (!editor.isConnected) host.prepend(editor);
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
    else if (message.type === 'notes') { notes = message.notes; notePath = message.current; }
    else if (message.type === 'backlinks') renderBacklinks(message.items);
    else if (message.type === 'imageSaved') { pendingImages.get(message.request)?.resolve(message.src); pendingImages.delete(message.request); }
    else if (message.type === 'imageFailed') { pendingImages.get(message.request)?.reject(new Error(message.message)); pendingImages.delete(message.request); }
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

// "Mentioned in" lists the notes that link here. It sits under the note and
// is never part of the saved Markdown.
const backlinks = document.createElement('aside');
backlinks.className = 'backlinks';
backlinks.hidden = true;
function renderBacklinks(items: Backlink[]) {
  backlinks.replaceChildren();
  backlinks.hidden = items.length === 0;
  document.body.classList.toggle('has-backlinks', items.length > 0);
  if (!items.length) return;
  const heading = document.createElement('h2');
  heading.textContent = `Mentioned in ${items.length} ${items.length === 1 ? 'note' : 'notes'}`;
  backlinks.append(heading);
  for (const item of items) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'backlink';
    const title = document.createElement('strong');
    title.textContent = item.title;
    const path = document.createElement('span');
    path.textContent = item.path;
    const snippet = document.createElement('p');
    snippet.textContent = item.snippet;
    row.append(title, path, snippet);
    row.addEventListener('click', () => post({ type: 'open', href: relativeLink(notePath, item.path) }));
    backlinks.append(row);
  }
  if (!backlinks.isConnected) host.append(backlinks);
}

// Tables and images get a Copy button on hover. A table copies as tab-separated
// text and an HTML table, which Sheets and Excel paste as rows and columns.
const cell = (text: string) => text.trim().replace(/\\\|/g, '|');
function escapeHtml(text: string) { return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function inlineHtml(text: string): string {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*(?!\s)(.+?)\*/g, '$1<i>$2</i>')
    .replace(/~~(.+?)~~/g, '<s>$1</s>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
}
const plainText = (text: string) => text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/(^|[^*])\*(?!\s)(.+?)\*/g, '$1$2').replace(/~~(.+?)~~/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/\[([^\]]+)\]\([^)\s]+\)/g, '$1');

/** A Markdown pipe table as rows of cells, separator row dropped. */
export function tableRows(markdown: string): string[][] {
  return markdown.split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('|'))
    .map(line => line.replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(cell))
    .filter(row => !row.every(value => /^:?-{2,}:?$/.test(value)));
}

export function tableClipboard(markdown: string): { text: string; html: string } {
  const rows = tableRows(markdown);
  const text = rows.map(row => row.map(value => plainText(value).replace(/\t/g, ' ')).join('\t')).join('\n');
  // Explicit colours: WebKit otherwise stamps the note's light text colour
  // onto the copy, which pastes as white-on-white in a spreadsheet.
  const cellStyle = 'border:1px solid #d0d0d0;padding:4px 8px;text-align:left;vertical-align:top';
  const html = `<table style="border-collapse:collapse;color:#000000;background:#ffffff;font-family:Arial,sans-serif;font-size:11pt">${rows.map((row, index) => `<tr>${row.map(value => index === 0 ? `<th style="${cellStyle};font-weight:bold;background:#f3f3f3">${inlineHtml(value)}</th>` : `<td style="${cellStyle}">${inlineHtml(value)}</td>`).join('')}</tr>`).join('')}</table>`;
  return { text, html };
}

function writeClipboard(text: string, html: string) {
  const onCopy = (event: ClipboardEvent) => {
    event.preventDefault();
    event.clipboardData?.setData('text/plain', text);
    event.clipboardData?.setData('text/html', html);
  };
  document.addEventListener('copy', onCopy, { once: true, capture: true });
  if (!document.execCommand('copy')) document.removeEventListener('copy', onCopy, true);
}

async function blobBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

/** PNG is the one image type every Mac app pastes. */
async function asPng(blob: Blob): Promise<Blob> {
  if (blob.type === 'image/png') return blob;
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width; canvas.height = bitmap.height;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
  return new Promise((resolve, reject) => canvas.toBlob(png => png ? resolve(png) : reject(new Error('Could not convert the image')), 'image/png'));
}

const copyChip = document.querySelector<HTMLButtonElement>('.copy-chip')!;
let copyTarget: HTMLElement | null = null;
host.addEventListener('mousemove', event => {
  const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('affine-image, affine-database');
  if (target === copyTarget) return;
  copyTarget = target ?? null;
  if (!copyTarget) { copyChip.hidden = true; return; }
  const box = copyTarget.getBoundingClientRect();
  copyChip.style.top = `${Math.max(box.top + 8, 8)}px`;
  copyChip.style.left = `${box.right - 8}px`;
  copyChip.textContent = copyTarget.localName === 'affine-image' ? 'Copy image' : 'Copy table';
  copyChip.hidden = false;
});
host.addEventListener('scroll', () => { copyChip.hidden = true; copyTarget = null; });
copyChip.addEventListener('mousedown', event => event.preventDefault());
copyChip.addEventListener('click', () => void copyBlock().catch(reportError));

async function copyBlock() {
  const state = current;
  const id = copyTarget?.dataset.blockId;
  if (!state || !id) return;
  const model = state.doc.getBlock(id)?.model as (BlockModel & { sourceId?: string }) | undefined;
  if (!model) return;
  if (model.flavour === 'affine:image') {
    const blob = model.sourceId ? await state.doc.blobSync.get(model.sourceId) : null;
    if (!blob) return;
    post({ type: 'copyImage', data: await blobBase64(await asPng(blob)) });
  } else {
    // An unedited table copies from the note's own Markdown, which keeps
    // formatting the table block drops (inline code in cells, for one).
    const segment = state.segmentOf.get(id);
    const original = segment !== undefined && !state.dirty.has(segment) && state.original.get(segment)?.length === 1
      ? state.segments.find(entry => entry.id === segment)?.text
      : undefined;
    const { text, html } = tableClipboard(original ?? await serializeRun(state, [id]));
    writeClipboard(text, html);
  }
  copyChip.textContent = 'Copied';
}

const sample = '# Welcome to Brainz notes\n\nType `/` for blocks, drag the handle to move them. Links like [the plan](plan.md) open in Brainz.\n\n## This week\n\n- [ ] Try a checklist\n- [x] Done already\n\n> Notes save back to Markdown.\n\n```ts\nconst saved = true;\n```\n\n1. First\n2. Second\n';
if (import.meta.env.DEV || !window.ipc) {
  window.__brainzNote = {
    load: (markdown: string, readOnly = false) => load('preview.md', readOnly, splitMarkdown(markdown)),
    render: () => current ? render(current) : Promise.resolve(''),
    tableClipboard,
    receive: (message: Incoming) => window.brainzNote?.receive(message),
    get state() { return current; },
    editor,
  };
}
post({ type: 'ready' });
if (!window.ipc) void load('preview.md', false, splitMarkdown(sample));
