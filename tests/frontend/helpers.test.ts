import { describe, it, expect } from 'vitest';
import {
  cleanElementForExcalidraw,
  validateAndFixBindings,
  computeElementHash,
} from '../../frontend/src/utils/elementHelpers.js';
import type { ServerElement } from '../../frontend/src/utils/elementHelpers.js';

// ─── cleanElementForExcalidraw ───────────────────────────────

describe('cleanElementForExcalidraw', () => {
  it('strips server metadata fields', () => {
    const element: ServerElement = {
      id: 'el1',
      type: 'rectangle',
      x: 10,
      y: 20,
      width: 100,
      height: 50,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-02T00:00:00Z',
      version: 3,
      syncedAt: '2024-01-02T01:00:00Z',
      source: 'mcp',
      syncTimestamp: '2024-01-02T01:00:00Z',
    };

    const cleaned = cleanElementForExcalidraw(element);

    expect(cleaned).not.toHaveProperty('createdAt');
    expect(cleaned).not.toHaveProperty('updatedAt');
    expect(cleaned).not.toHaveProperty('version');
    expect(cleaned).not.toHaveProperty('syncedAt');
    expect(cleaned).not.toHaveProperty('source');
    expect(cleaned).not.toHaveProperty('syncTimestamp');
  });

  it('preserves core element properties', () => {
    const element: ServerElement = {
      id: 'el2',
      type: 'ellipse',
      x: 50,
      y: 100,
      width: 80,
      height: 80,
      backgroundColor: '#ff0000',
      strokeColor: '#000000',
      strokeWidth: 2,
      opacity: 0.8,
      version: 1,
    };

    const cleaned = cleanElementForExcalidraw(element);

    expect(cleaned.id).toBe('el2');
    expect(cleaned.type).toBe('ellipse');
    expect(cleaned.x).toBe(50);
    expect(cleaned.y).toBe(100);
    expect((cleaned as any).backgroundColor).toBe('#ff0000');
    expect((cleaned as any).strokeColor).toBe('#000000');
    expect((cleaned as any).opacity).toBe(0.8);
  });

  it('preserves label and text fields', () => {
    const element: ServerElement = {
      id: 'txt1',
      type: 'text',
      x: 0,
      y: 0,
      text: 'Hello',
      fontSize: 20,
      label: { text: 'Label' },
      version: 1,
    };

    const cleaned = cleanElementForExcalidraw(element);
    expect((cleaned as any).text).toBe('Hello');
    expect((cleaned as any).label).toEqual({ text: 'Label' });
    expect((cleaned as any).fontSize).toBe(20);
  });

  it('preserves arrow binding references', () => {
    const element: ServerElement = {
      id: 'arrow1',
      type: 'arrow',
      x: 0,
      y: 0,
      start: { id: 'box1' },
      end: { id: 'box2' },
      version: 1,
    };

    const cleaned = cleanElementForExcalidraw(element);
    expect((cleaned as any).start).toEqual({ id: 'box1' });
    expect((cleaned as any).end).toEqual({ id: 'box2' });
  });
});

// ─── validateAndFixBindings ──────────────────────────────────

describe('validateAndFixBindings', () => {
  it('keeps valid boundElements references', () => {
    const elements = [
      { id: 'rect1', type: 'rectangle', x: 0, y: 0, boundElements: [{ id: 'arrow1', type: 'arrow' }] },
      { id: 'arrow1', type: 'arrow', x: 0, y: 0 },
    ] as any[];

    const result = validateAndFixBindings(elements);
    expect(result[0]!.boundElements).toEqual([{ id: 'arrow1', type: 'arrow' }]);
  });

  it('removes boundElements referencing non-existent elements', () => {
    const elements = [
      { id: 'rect1', type: 'rectangle', x: 0, y: 0, boundElements: [{ id: 'missing', type: 'arrow' }] },
    ] as any[];

    const result = validateAndFixBindings(elements);
    expect(result[0]!.boundElements).toBeNull();
  });

  it('removes invalid binding objects', () => {
    const elements = [
      { id: 'rect1', type: 'rectangle', x: 0, y: 0, boundElements: [null, undefined, 'invalid', { id: 'a' }] },
    ] as any[];

    const result = validateAndFixBindings(elements);
    expect(result[0]!.boundElements).toBeNull();
  });

  it('removes invalid binding types', () => {
    const elements = [
      { id: 'rect1', type: 'rectangle', x: 0, y: 0, boundElements: [{ id: 'other', type: 'invalid' }] },
      { id: 'other', type: 'rectangle', x: 0, y: 0 },
    ] as any[];

    const result = validateAndFixBindings(elements);
    expect(result[0]!.boundElements).toBeNull();
  });

  it('sets non-array boundElements to null', () => {
    const elements = [
      { id: 'rect1', type: 'rectangle', x: 0, y: 0, boundElements: 'not-an-array' },
    ] as any[];

    const result = validateAndFixBindings(elements);
    expect(result[0]!.boundElements).toBeNull();
  });

  it('nullifies containerId when container does not exist', () => {
    const elements = [
      { id: 'text1', type: 'text', x: 0, y: 0, containerId: 'missing-container' },
    ] as any[];

    const result = validateAndFixBindings(elements);
    expect(result[0]!.containerId).toBeNull();
  });

  it('keeps valid containerId', () => {
    const elements = [
      { id: 'container', type: 'rectangle', x: 0, y: 0 },
      { id: 'text1', type: 'text', x: 0, y: 0, containerId: 'container' },
    ] as any[];

    const result = validateAndFixBindings(elements);
    expect(result[1]!.containerId).toBe('container');
  });

  it('handles empty array input', () => {
    expect(validateAndFixBindings([])).toEqual([]);
  });

  it('handles elements with no bindings', () => {
    const elements = [
      { id: 'simple', type: 'rectangle', x: 0, y: 0 },
    ] as any[];

    const result = validateAndFixBindings(elements);
    expect(result[0]!.id).toBe('simple');
  });
});

// ─── computeElementHash ──────────────────────────────────────

describe('computeElementHash', () => {
  it('produces consistent hash for same elements', () => {
    const elements = [
      { id: 'a', version: 1 },
      { id: 'b', version: 2 },
    ];

    const hash1 = computeElementHash(elements);
    const hash2 = computeElementHash(elements);
    expect(hash1).toBe(hash2);
  });

  it('produces different hash when element version changes', () => {
    const v1 = [{ id: 'a', version: 1 }];
    const v2 = [{ id: 'a', version: 2 }];

    expect(computeElementHash(v1)).not.toBe(computeElementHash(v2));
  });

  it('produces different hash when element is added', () => {
    const one = [{ id: 'a', version: 1 }];
    const two = [{ id: 'a', version: 1 }, { id: 'b', version: 1 }];

    expect(computeElementHash(one)).not.toBe(computeElementHash(two));
  });

  it('handles empty array', () => {
    expect(computeElementHash([])).toBe('0');
  });

  it('includes element count in hash', () => {
    const hash = computeElementHash([{ id: 'x', version: 1 }]);
    expect(hash.startsWith('1')).toBe(true);
  });
});
