import expandIcon from './icons/expand.svg?raw';
import collapseIcon from './icons/collapse.svg?raw';

const paths: Record<string, string> = {
  canvas: 'M12 16V21M12 16L18 21M12 16L6 21M21 3V11.2C21 12.8802 21 13.7202 20.673 14.362C20.3854 14.9265 19.9265 15.3854 19.362 15.673C18.7202 16 17.8802 16 16.2 16H7.8C6.11984 16 5.27976 16 4.63803 15.673C4.07354 15.3854 3.6146 14.9265 3.32698 14.362C3 13.7202 3 12.8802 3 11.2V3M8 9V12M12 7V12M16 11V12M22 3H2',
  capture: 'M8 3H4a1 1 0 0 0-1 1v4M16 3h4a1 1 0 0 1 1 1v4M3 16v4a1 1 0 0 0 1 1h4M21 16v4a1 1 0 0 1-1 1h-4M8 8h8v8H8Z',
  pointer: 'M5 3L19 12L12 13L9 20Z',
  hand: 'M8 12V6a2 2 0 0 1 4 0v5V4a2 2 0 0 1 4 0v7V7a2 2 0 0 1 4 0v7c0 5-3 7-7 7-3 0-5-2-7-5l-3-4a2 2 0 0 1 3-2l2 2',
  box: 'M6 4h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z',
  note: 'M14 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v9l-7 7ZM14 21v-5a2 2 0 0 1 2-2h5',
  connector: 'M4 18V8a2 2 0 0 1 2-2h14M16 2l4 4-4 4M2 18h4v4H2Z',
  text: 'M4 5V3h16v2M12 3v18M8 21h8',
  pen: 'M4 20l4-1L20 7a2 2 0 0 0-3-3L5 16l-1 4ZM14 7l3 3',
  ellipse: 'M21 12a9 7 0 1 1-18 0a9 7 0 1 1 18 0',
  diamond: 'M12 3l9 9-9 9-9-9Z',
  triangle: 'M12 3l10 18H2Z',
  eraser: 'M3 14l9-10a2 2 0 0 1 3 0l6 6a2 2 0 0 1 0 3l-7 8H9l-6-5a2 2 0 0 1 0-2ZM8 9l10 9M14 21h8',
  frame: 'M7 3v18M17 3v18M3 7h18M3 17h18',
  mindmap: 'M4 10h6v4H4ZM15 3h6v4h-6ZM15 17h6v4h-6ZM10 12h3V5h2M13 12v7h2',
  lasso: 'M7 17C1 15 2 5 9 4s13 3 12 8-6 7-12 5Zm0 0c3 1 4 5 0 5-3 0-4-3-2-4',
  laser: 'M4 20l9-9M14 5V2M19 10h3M18 6l3-3M7 4l3 3M17 14l3 3',
  lock: 'M7 10V7a5 5 0 0 1 10 0v3M6 10h12a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2ZM12 14v3',
  search: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0a8 8 0 1 1 16 0',
  check: 'M5 12l4 4L19 6',
  link: 'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6ZM14 2v6h6M8 13h8M8 17h5',
  undo: 'M3 9h12a6 6 0 0 1 0 12M3 9l5-5M3 9l5 5',
  redo: 'M21 9H9a6 6 0 0 0 0 12M21 9l-5-5M21 9l-5 5',
  fit: 'M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5M8 8h8v8H8Z',
  plus: 'M12 5v14M5 12h14', minus: 'M5 12h14',
  arrow: 'M7 17L17 7M7 7h10v10', close: 'M6 6l12 12M18 6L6 18',
};
export const icon = (name: string) => name === 'fit' ? expandIcon : name === 'collapse' ? collapseIcon : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name]}"/></svg>`;
export const tool = (name: string, label: string, shortcut: string) => `<button class="tool" data-tool="${name}" aria-label="${label}" aria-pressed="false">${icon(name)}<span class="tooltip">${label}<kbd>${shortcut}</kbd></span></button>`;
export function mountShell(app: HTMLElement) {
app.innerHTML = `
<header class="topbar"><div class="board-name">${icon('canvas')}<input id="title" aria-label="Board name" value="Untitled canvas" maxlength="120"><span class="save-state" id="save-state" role="status"><i></i>Opening…</span></div><div class="header-actions"><div class="header-history" aria-label="Canvas history"><button id="undo" aria-label="Undo" title="Undo (⌘Z)">${icon('undo')}</button><button id="redo" aria-label="Redo" title="Redo (⇧⌘Z)">${icon('redo')}</button></div><button id="add-file" class="text-button">${icon('file')}Add file</button><button id="copy-view" class="text-button share">${icon('link')}Copy link</button></div></header>
<main id="canvas" aria-label="Infinite whiteboard"></main>
<div class="empty-state" id="empty"><div class="empty-symbol">${icon('canvas')}</div><h1>A little room to think.</h1><p>Map an idea. Connect the dots.<br>Bring your notes into the picture.</p><button id="first-note" class="primary">${icon('plus')}Add your first note</button><span>or drop a file anywhere</span></div>
<nav class="tools" aria-label="Drawing tools"><button id="tools-toggle" type="button" aria-label="Expand drawing tools" aria-expanded="false" aria-controls="tools-content">${icon('pointer')}<span class="tools-chevron" aria-hidden="true">⌄</span></button><div id="tools-content" class="tools-content" inert>${tool('pointer','Select','V')}${tool('hand','Pan','H')}<div class="rule"></div>${tool('note','Sticky note','N')}${tool('box','Box','R')}${tool('connector','Connector','C')}${tool('text','Text','T')}${tool('pen','Draw','P')}${tool('eraser','Eraser','E')}${tool('frame','Frame','F')}${tool('mindmap','Mind map','M')}${tool('lasso','Lasso','L')}${tool('laser','Laser','K')}<div class="rule"></div><button id="add-link" class="tool" aria-label="Add link" title="Add a Brainz, My Man, or web link">${icon('link')}</button><div class="rule"></div><button id="capture" class="tool" aria-label="Capture area" aria-pressed="false" title="Drag an area to copy as an image">${icon('capture')}<span class="tooltip">Capture area</span></button><button id="lock-tool" class="tool" aria-label="Keep tool active" aria-pressed="false" title="Keep tool active (Q)">${icon('lock')}</button><button id="commands" class="tool" aria-label="Canvas commands" title="Canvas commands (⌘K)">${icon('search')}</button></div></nav>
<div class="bottom-left"><span class="hint">Space + drag to pan<span>·</span>Pinch to zoom</span></div>
<div class="zoom-controls"><button id="zoom-out" aria-label="Zoom out">${icon('minus')}</button><button id="zoom-reset" aria-label="Reset zoom"><span id="zoom">100%</span></button><button id="zoom-in" aria-label="Zoom in">${icon('plus')}</button><span></span><button id="fit" aria-label="Fit to content" title="Fit to content (⇧1)">${icon('fit')}</button></div>
<div id="toast" role="status" hidden></div>
<dialog id="link-dialog" aria-label="Add a link"><form id="link-form"><div class="dialog-title"><h2>Add a link</h2><button type="button" id="cancel-link" aria-label="Close">${icon('close')}</button></div><p>Connect something from Brainz, My Man, or the web.</p><label>Link<input id="link-url" type="text" placeholder="brainz://… or https://…" required autocomplete="off"></label><label>Label<input id="link-title" type="text" placeholder="Give it a name" maxlength="160"></label><div id="link-error" role="alert"></div><button class="primary" type="submit">Add to canvas</button></form></dialog>`;
}
