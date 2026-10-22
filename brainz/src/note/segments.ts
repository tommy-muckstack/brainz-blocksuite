// Turns the editor's current blocks back into the note's Markdown while
// keeping every untouched segment byte-for-byte. Pure, so it can be tested
// without a DOM; the editor supplies a serializer for the blocks it changed.

export interface Segment { id: number; kind: string; text: string }

/** A top-level block in document order, with the segment it was imported from (null when new). */
export interface TopBlock { id: string; segment: number | null }

/** Serializes consecutive top-level blocks to Markdown (trailing newlines allowed). */
export type SerializeRun = (blockIds: string[]) => Promise<string>;

export const isContent = (segment: Segment) => segment.kind !== 'gap' && segment.kind !== 'metadata';

interface Unit { text: string; first: number | null; last: number | null; intact: boolean }

const trailingWhitespace = (text: string) => text.slice(text.trimEnd().length);

/**
 * Rebuilds the file. `original` maps each content segment id to the ids of the
 * top-level blocks it produced at load; `dirty` holds segments whose blocks were
 * edited, added to or removed from since.
 */
export async function assemble(segments: Segment[], blocks: TopBlock[], original: Map<number, string[]>, dirty: Set<number>, serialize: SerializeRun): Promise<string> {
  const indexOf = new Map(segments.map((segment, index) => [segment.id, index]));
  const firstContent = segments.findIndex(isContent);
  if (firstContent < 0 && blocks.length === 0) return segments.map(segment => segment.text).join('');
  let lastContent = -1;
  for (let index = segments.length - 1; index >= 0; index--) if (isContent(segments[index])) { lastContent = index; break; }
  const leading = segments.slice(0, firstContent < 0 ? segments.length : firstContent).map(segment => segment.text).join('');
  const trailing = lastContent < 0 ? '' : segments.slice(lastContent + 1).map(segment => segment.text).join('');

  const intactAt = (position: number): number => {
    const segment = blocks[position].segment;
    if (segment === null || dirty.has(segment)) return 0;
    const ids = original.get(segment) ?? [];
    if (ids.length === 0) return 0;
    for (let offset = 0; offset < ids.length; offset++) {
      const block = blocks[position + offset];
      if (!block || block.id !== ids[offset] || block.segment !== segment) return 0;
    }
    return ids.length;
  };

  const units: Unit[] = [];
  let position = 0;
  while (position < blocks.length) {
    const length = intactAt(position);
    if (length > 0) {
      const segment = blocks[position].segment!;
      const index = indexOf.get(segment)!;
      units.push({ text: segments[index].text, first: index, last: index, intact: true });
      position += length;
      continue;
    }
    const run: TopBlock[] = [];
    while (position < blocks.length && (run.length === 0 || intactAt(position) === 0)) run.push(blocks[position++]);
    const indices = run.flatMap(block => block.segment === null ? [] : [indexOf.get(block.segment)!]);
    const first = indices.length ? Math.min(...indices) : null;
    const last = indices.length ? Math.max(...indices) : null;
    let text = (await serialize(run.map(block => block.id))).replace(/\n+$/, '');
    if (last !== null) text += trailingWhitespace(segments[last].text);
    if (text.trim()) units.push({ text, first, last, intact: false });
  }

  let output = leading;
  units.forEach((unit, index) => {
    if (index > 0) output += separator(segments, units[index - 1], unit);
    output += unit.text;
  });
  if (units.length > 0 && !trailing && !units[units.length - 1].intact && !output.endsWith('\n')) output += '\n';
  return output + (units.length > 0 || firstContent >= 0 ? trailing : '');
}

function separator(segments: Segment[], before: Unit, after: Unit): string {
  if (before.last !== null && after.first !== null && before.last < after.first) {
    const between = segments.slice(before.last + 1, after.first);
    // Neighbours in the original keep the exact gap that sat between them.
    if (between.every(segment => !isContent(segment))) return between.map(segment => segment.text).join('');
    const gap = between.find(segment => !isContent(segment));
    if (gap) return gap.text;
  }
  return '\n\n';
}
