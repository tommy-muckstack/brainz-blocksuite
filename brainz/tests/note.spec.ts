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
