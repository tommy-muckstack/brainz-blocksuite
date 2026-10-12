import { describe, expect, it } from 'vitest';
import { base64ToBytes, boardLink, bytesToBase64, supportedLink } from '../src/model';

describe('saved canvas data', () => {
  it('round trips binary Yjs updates, including values outside ASCII and chunk boundaries', () => {
    const bytes = Uint8Array.from({ length: 25_000 }, (_, index) => index % 256);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    expect(base64ToBytes(bytesToBase64(new Uint8Array()))).toEqual(new Uint8Array());
  });

  it('rejects corrupted base64 instead of silently loading a blank board', () => {
    expect(() => base64ToBytes('not valid base64!')).toThrow();
  });
});

describe('canvas links', () => {
  it('preserves folder names, Unicode, and object identifiers', () => {
    const path = '/brain/Projects/Design & planning/équipe.brainzboard';
    const link = new URL(boardLink({ path }, [-123.456, 80.129, 1.125], 'sticky #1'));
    expect(link.protocol).toBe('brainz:');
    expect(link.hostname).toBe('whiteboard');
    expect(link.searchParams.get('path')).toBe(path);
    expect(link.searchParams.get('object')).toBe('sticky #1');
    expect(link.searchParams.get('x')).toBe('-123.46');
    expect(link.searchParams.get('y')).toBe('80.13');
    expect(link.searchParams.get('zoom')).toBe('1.125');
  });

  it('limits zoom and omits an object when linking to the whole view', () => {
    const low = new URL(boardLink({ path: '/board' }, [0, 0, 0]));
    const high = new URL(boardLink({ path: '/board' }, [0, 0, 100]));
    expect(low.searchParams.get('zoom')).toBe('0.050');
    expect(high.searchParams.get('zoom')).toBe('10.000');
    expect(low.searchParams.has('object')).toBe(false);
  });

  it.each(['brainz://open?path=test.md', 'myman://capture/123', 'file:///brain/note.md', 'https://example.com', 'http://localhost:1234', 'mailto:test@example.com'])('accepts supported links: %s', value => {
    expect(supportedLink(value)?.href).toBe(new URL(value).href);
  });

  it.each(['javascript:alert(1)', 'data:text/html,test', 'vbscript:msgbox(1)', '/relative/note.md', 'not a url'])('rejects unsupported links: %s', value => {
    expect(supportedLink(value)).toBeNull();
  });
});
