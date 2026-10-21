import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assemble, isContent, type Segment, type TopBlock } from '../src/note/segments';
import { splitMarkdown } from '../src/note/split';

const corpus = process.env.BRAINZ_EDITOR_CORPUS ?? join(__dirname, '../../../crates/brainz_editor/tests/corpus');

/** One fake block per content segment, the way a single-block import would come out. */
function model(segments: Segment[]) {
  const blocks: TopBlock[] = segments.filter(isContent).map(segment => ({ id: `b${segment.id}`, segment: segment.id }));
  const original = new Map(blocks.map(block => [block.segment!, [block.id]]));
  const texts = new Map(segments.filter(isContent).map(segment => [`b${segment.id}`, segment.text]));
  // The fake "Markdown adapter" writes each block's current text, normalising
  // the way a real serializer would (one trailing newline, blank-line joins).
  const serialize = async (ids: string[]) => ids.map(id => texts.get(id)!.trimEnd()).join('\n\n') + '\n';
  return { blocks, original, texts, serialize };
}

const files = (() => { try { return readdirSync(corpus).filter(name => name.endsWith('.md')).sort(); } catch { return []; } })();

describe('note segments', () => {
  // The corpus lives in the Brainz repo that embeds this one as a submodule.
  it.skipIf(files.length === 0).each(files)('round-trips %s untouched', async name => {
    const source = readFileSync(join(corpus, name), 'utf8');
    const segments = splitMarkdown(source);
    expect(segments.map(segment => segment.text).join('')).toBe(source);
    const { blocks, original, serialize } = model(segments);
    expect(await assemble(segments, blocks, original, new Set(), serialize)).toBe(source);
  });

  it('rewrites only the edited paragraph', async () => {
    const source = '---\ntitle: x\n---\n\n# Title\n\nFirst  *para*.\n\n* weird   list\n* kept\n\nLast one.\n';
    const segments = splitMarkdown(source);
    const { blocks, original, texts, serialize } = model(segments);
    const target = segments.find(segment => segment.text.startsWith('First'))!;
    texts.set(`b${target.id}`, 'First paragraph, edited.');
    const output = await assemble(segments, blocks, original, new Set([target.id]), serialize);
    expect(output).toBe(source.replace('First  *para*.', 'First paragraph, edited.'));
  });

  it('inserts a new block with one blank line on each side', async () => {
    const source = 'Alpha\n\n\n\nBeta\n';
    const segments = splitMarkdown(source);
    const { blocks, original, texts, serialize } = model(segments);
    blocks.splice(1, 0, { id: 'new', segment: null });
    texts.set('new', '- [ ] new task');
    expect(await assemble(segments, blocks, original, new Set(), serialize)).toBe('Alpha\n\n- [ ] new task\n\nBeta\n');
  });

  it('drops a deleted block and one of its gaps', async () => {
    const source = 'Alpha\n\nBeta\n\nGamma\n';
    const segments = splitMarkdown(source);
    const { blocks, original, serialize } = model(segments);
    const beta = segments.find(segment => segment.text === 'Beta')!;
    const kept = blocks.filter(block => block.segment !== beta.id);
    expect(await assemble(segments, kept, original, new Set([beta.id]), serialize)).toBe('Alpha\n\nGamma\n');
  });

  it('serializes a multi-block segment together once one of its blocks changes', async () => {
    const source = 'Intro\n\n- one\n- two\n- three\n\nOutro';
    const segments = splitMarkdown(source);
    const list = segments.find(segment => segment.kind === 'list')!;
    const blocks: TopBlock[] = [
      { id: 'intro', segment: 0 }, { id: 'l1', segment: list.id }, { id: 'l2', segment: list.id }, { id: 'l3', segment: list.id }, { id: 'outro', segment: segments[segments.length - 1].id },
    ];
    const original = new Map<number, string[]>([[0, ['intro']], [list.id, ['l1', 'l2', 'l3']], [segments[segments.length - 1].id, ['outro']]]);
    const items: Record<string, string> = { intro: 'Intro', l1: '- one', l2: '- TWO', l3: '- three', outro: 'Outro' };
    let calls = 0;
    const serialize = async (ids: string[]) => { calls++; return ids.map(id => items[id]).join('\n') + '\n'; };
    const output = await assemble(segments, blocks, original, new Set([list.id]), serialize);
    expect(output).toBe('Intro\n\n- one\n- TWO\n- three\n\nOutro');
    expect(calls).toBe(1);
    // Untouched, the same layout stays byte-identical without serializing.
    expect(await assemble(segments, blocks, original, new Set(), serialize)).toBe(source);
    expect(calls).toBe(1);
  });

  it('writes typing into an empty file with a final newline', async () => {
    const segments = splitMarkdown('');
    const output = await assemble(segments, [{ id: 'new', segment: null }], new Map(), new Set(), async () => 'Hello\n');
    expect(output).toBe('Hello\n');
  });

  it('keeps frontmatter when every block is deleted', async () => {
    const source = '---\na: 1\n---\n\nOnly\n';
    const segments = splitMarkdown(source);
    expect(segments[0].kind).toBe('metadata');
    const only = segments.find(segment => segment.text === 'Only')!;
    expect(await assemble(segments, [], new Map([[only.id, ['b']]]), new Set([only.id]), async () => '')).toBe('---\na: 1\n---\n\n\n');
  });
});
