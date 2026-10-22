import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { splitMarkdown } from '../src/note/split';

const corpus = process.env.BRAINZ_EDITOR_CORPUS ?? join(dirname(fileURLToPath(import.meta.url)), '../../../crates/brainz_editor/tests/corpus');
const files = (() => { try { return readdirSync(corpus).filter(name => name.endsWith('.md')).sort(); } catch { return []; } })();

type NoteHarness = { load(markdown: string, readOnly?: boolean): Promise<void>; render(): Promise<string> };
const harness = (page: Page) => page.waitForFunction(() => Boolean((window as unknown as { __brainzNote?: unknown }).__brainzNote));

async function open(page: Page) {
  await page.goto('/note.html');
  await harness(page);
  await expect(page.locator('affine-paragraph').first()).toBeVisible();
}

/** Puts the caret after the last character of the given text. */
async function clickEnd(page: Page, text: string) {
  const target = page.getByText(text, { exact: true });
  const box = (await target.boundingBox())!;
  await target.click({ position: { x: box.width - 1, y: box.height / 2 } });
  // BlockSuite syncs its selection from the click asynchronously; keys sent
  // before that reach the browser's own contenteditable handling.
  await page.waitForTimeout(200);
}

async function roundTrip(page: Page, markdown: string) {
  return page.evaluate(async source => {
    const note = (window as unknown as { __brainzNote: NoteHarness }).__brainzNote;
    await note.load(source);
    return note.render();
  }, markdown);
}

test('untouched notes come back byte-for-byte', async ({ page }) => {
  test.skip(files.length === 0, 'corpus lives in the Brainz repo');
  await open(page);
  const mismatched: string[] = [];
  for (const name of files) {
    const source = readFileSync(join(corpus, name), 'utf8');
    if (await roundTrip(page, source) !== source) mismatched.push(name);
  }
  expect(mismatched).toEqual([]);
});

test('typing into one paragraph rewrites only that paragraph', async ({ page }) => {
  await open(page);
  const source = '---\ntags: [x]\n---\n\n# Plan\n\nFirst   line  with *odd*   spacing.\n\nSecond paragraph.\n\n* star list\n* kept as is\n';
  expect(await roundTrip(page, source)).toBe(source);
  await clickEnd(page, 'Second paragraph.');
  await page.keyboard.type(' More words.');
  const output = await page.evaluate(() => (window as unknown as { __brainzNote: NoteHarness }).__brainzNote.render());
  expect(output).toBe(source.replace('Second paragraph.', 'Second paragraph. More words.'));
});

test('navigation keys delivered as text never reach the note', async ({ page }) => {
  await open(page);
  const source = '# Plan\n\nSecond paragraph.\n';
  expect(await roundTrip(page, source)).toBe(source);
  await clickEnd(page, 'Second paragraph.');
  for (const text of ['\u0001', '\u0004', '\uF700', '\uF729']) await page.keyboard.insertText(text);
  await page.keyboard.type(' Still typing.');
  const output = await page.evaluate(() => (window as unknown as { __brainzNote: NoteHarness }).__brainzNote.render());
  expect(output).toBe(source.replace('Second paragraph.', 'Second paragraph. Still typing.'));
});

test('dollar amounts stay text, before and after an edit', async ({ page }) => {
  await open(page);
  const source = '# Plan\n\nPaid $1,524.68 today: $1,434.99 subtotal.\n\nSecond paragraph.\n';
  expect(await roundTrip(page, source)).toBe(source);
  await expect(page.getByText('Paid $1,524.68 today: $1,434.99 subtotal.', { exact: true })).toBeVisible();
  await clickEnd(page, 'Paid $1,524.68 today: $1,434.99 subtotal.');
  await page.keyboard.type(' Done.');
  const output = await page.evaluate(() => (window as unknown as { __brainzNote: NoteHarness }).__brainzNote.render());
  expect(output).toBe(source.replace('subtotal.', 'subtotal. Done.'));
});

test('tables show without a database title', async ({ page }) => {
  await open(page);
  const source = '| Name | Value |\n| ---- | ----- |\n| a    | 1     |\n';
  expect(await roundTrip(page, source)).toBe(source);
  await expect(page.locator('affine-database')).toBeVisible();
  await expect(page.locator('affine-database-title')).toBeHidden();
});

test('checklists, headings and quotes render as blocks', async ({ page }) => {
  await open(page);
  await roundTrip(page, '# Heading\n\n- [ ] open task\n- [x] done task\n\n> quoted\n');
  await expect(page.locator('affine-list')).toHaveCount(2);
  await expect(page.locator('affine-paragraph').first()).toContainText('Heading');
  await expect(page.locator('doc-title')).toBeHidden();
});

test('opening a note never schedules a write', async ({ page }) => {
  test.skip(files.length === 0, 'corpus lives in the Brainz repo');
  await open(page);
  const touched: string[] = [];
  for (const name of ['21-email.md', '18-code.md', '20-mermaid.md', '24-table.md', '06-yaml.md', '13-tasks.md', '29-image.md'].filter(name => files.includes(name))) {
    await roundTrip(page, readFileSync(join(corpus, name), 'utf8'));
    await page.waitForTimeout(1200);
    if (await page.evaluate(() => (window as unknown as { __brainzNote: { state?: { touched: boolean } } }).__brainzNote.state?.touched)) touched.push(name);
  }
  expect(touched).toEqual([]);
});

type Sent = { type: string; markdown?: string; revision?: number; href?: string };
async function openWithIpc(page: Page, markdown: string) {
  await page.addInitScript(() => {
    const sent: unknown[] = [];
    (window as unknown as { __sent: unknown[] }).__sent = sent;
    (window as unknown as { ipc: { postMessage(message: string): void } }).ipc = { postMessage: message => { sent.push(JSON.parse(message)); } };
  });
  await page.goto('/note.html');
  await page.waitForFunction(() => (window as unknown as { __sent: { type: string }[] }).__sent.some(message => message.type === 'ready'));
  await page.evaluate(segments => (window as unknown as { brainzNote: { receive(message: unknown): void } }).brainzNote.receive({ type: 'load', path: '/brain/note.md', readOnly: false, segments }), splitMarkdown(markdown));
  await expect(page.locator('affine-paragraph').first()).toBeVisible();
  // Key handling is bound once the load finishes settling.
  await page.waitForFunction(() => Boolean((window as unknown as { __brainzNote: { state?: unknown } }).__brainzNote.state));
  await page.waitForTimeout(500);
}
const sent = (page: Page) => page.evaluate(() => (window as unknown as { __sent: Sent[] }).__sent);
const lastSave = async (page: Page) => (await sent(page)).filter(message => message.type === 'save').at(-1);

test('splitting a paragraph saves one new block between untouched neighbours', async ({ page }) => {
  const source = 'Alpha  keeps   spacing\n\nBeta\n\n* Gamma\n';
  await openWithIpc(page, source);
  await clickEnd(page, 'Beta');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Inserted');
  await expect.poll(async () => (await lastSave(page))?.markdown).toBeTruthy();
  await page.waitForTimeout(600);
  expect((await lastSave(page))?.markdown).toBe('Alpha  keeps   spacing\n\nBeta\n\nInserted\n\n* Gamma\n');
  expect((await lastSave(page))?.revision).toBeGreaterThanOrEqual(1);
});

test('ticking a checklist item writes [x] for that line only', async ({ page }) => {
  const source = 'Tasks:\n\n- [ ] first\n- [ ] second\n';
  await openWithIpc(page, source);
  await page.locator('affine-list').first().locator('.affine-list-block__todo-prefix').click();
  await expect.poll(async () => (await lastSave(page))?.markdown).toBe('Tasks:\n\n- [x] first\n- [ ] second\n');
});

test('the Markdown button and links go to Brainz', async ({ page }) => {
  await openWithIpc(page, 'See [the plan](plans/plan.md) today.\n');
  await page.getByRole('button', { name: /Markdown/ }).click();
  await page.locator('affine-link a, a[href="plans/plan.md"]').first().click();
  await expect.poll(async () => (await sent(page)).map(message => message.type)).toEqual(expect.arrayContaining(['source', 'open']));
  expect((await sent(page)).find(message => message.type === 'open')?.href).toBe('plans/plan.md');
  expect(page.url()).toContain('/note.html');
});

const pixel = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/pixel.png'));

async function serveBrainImages(page: Page) {
  const requested: string[] = [];
  await page.route('**/brain-file?*', route => {
    const path = new URL(route.request().url()).searchParams.get('path') ?? '';
    requested.push(path);
    return path.endsWith('missing.png')
      ? route.fulfill({ status: 404, body: '' })
      : route.fulfill({ status: 200, contentType: 'image/png', body: pixel });
  });
  return requested;
}

test('images in the brain show as images and come back unchanged', async ({ page }) => {
  const requested = await serveBrainImages(page);
  await open(page);
  const source = '# Trip\n\n![The view|320](attachments/view.png)\n\n![](<photos/my shot.png>)\n\nInline ![tiny](a.png) stays text.\n\n![gone](missing.png)\n\n![web](https://example.com/a.png)\n';
  expect(await roundTrip(page, source)).toBe(source);
  await expect(page.locator('affine-image')).toHaveCount(2);
  expect(requested).toEqual(expect.arrayContaining(['attachments/view.png', 'photos/my shot.png', 'missing.png']));
  // Missing, inline and web images stay as Markdown text.
  await expect(page.locator('affine-code')).toHaveCount(3);
});

test('a new image is saved beside the note and written as Markdown', async ({ page }) => {
  await open(page);
  const source = '# Trip\n\nBefore.\n';
  expect(await roundTrip(page, source)).toBe(source);
  const output = await page.evaluate(async bytes => {
    const note = (window as unknown as { __brainzNote: NoteHarness & { state: { doc: any; noteId: string } } }).__brainzNote;
    const { doc, noteId } = note.state;
    const blob = new Blob([new Uint8Array(bytes)], { type: 'image/png' });
    await doc.blobSync.set('pasted', blob);
    doc.addBlock('affine:image', { sourceId: 'pasted', width: 200 }, noteId);
    return note.render();
  }, [...pixel]);
  expect(output).toBe(`${source}\n![|200](attachments/image-1.png)\n`);
});

test('opening a note with images never schedules a write', async ({ page }) => {
  await serveBrainImages(page);
  await open(page);
  await roundTrip(page, '# Trip\n\n![The view|320](attachments/view.png)\n\nAfter.\n');
  await expect(page.locator('affine-image')).toHaveCount(1);
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => (window as unknown as { __brainzNote: { state?: { touched: boolean } } }).__brainzNote.state?.touched)).toBe(false);
});

test('a table copies as rows and columns for spreadsheets', async ({ page }) => {
  await open(page);
  const source = '| Name | Amount |\n| ---- | ------ |\n| **Rent** | $1,200 |\n| Food | `$300` |\n';
  expect(await roundTrip(page, source)).toBe(source);
  await page.evaluate(() => {
    const captured = window as unknown as { copied?: { text: string; html: string } };
    document.addEventListener('copy', event => {
      captured.copied = { text: event.clipboardData?.getData('text/plain') ?? '', html: event.clipboardData?.getData('text/html') ?? '' };
    });
  });
  await page.locator('affine-database').hover();
  const chip = page.locator('.copy-chip');
  await expect(chip).toHaveText('Copy table');
  await chip.click();
  await expect(chip).toHaveText('Copied');
  const copied = await page.evaluate(() => (window as unknown as { copied?: { text: string; html: string } }).copied);
  expect(copied?.text).toBe('Name\tAmount\nRent\t$1,200\nFood\t$300');
  expect(copied?.html).toBe('<table><tr><th>Name</th><th>Amount</th></tr><tr><td><b>Rent</b></td><td>$1,200</td></tr><tr><td>Food</td><td><code>$300</code></td></tr></table>');
});

test('an image offers Copy image', async ({ page }) => {
  await serveBrainImages(page);
  const posted: string[] = [];
  page.on('console', async message => {
    for (const argument of message.args()) {
      const value = await argument.jsonValue().catch(() => null) as { type?: string } | null;
      if (value?.type) posted.push(value.type);
    }
  });
  await open(page);
  await roundTrip(page, '# Trip\n\n![The view](attachments/view.png)\n');
  await page.locator('affine-image').hover();
  const chip = page.locator('.copy-chip');
  await expect(chip).toHaveText('Copy image');
  await chip.click();
  await expect(chip).toHaveText('Copied');
  await expect.poll(() => posted).toContain('copyImage');
});
