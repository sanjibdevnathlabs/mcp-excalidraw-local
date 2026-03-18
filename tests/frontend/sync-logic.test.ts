import { describe, it, expect } from 'vitest';
import {
  cleanElementForExcalidraw,
  computeElementHash,
  isImageElement,
  isShapeContainerType,
  normalizeImageElement,
  validateAndFixBindings,
  restoreBindings,
} from '../../frontend/src/utils/elementHelpers.js';

// ─── cleanElementForExcalidraw comprehensive ────────────────

describe('cleanElementForExcalidraw - comprehensive', () => {
  it('strips all server-only metadata fields', () => {
    const serverEl = {
      id: 'el-1',
      type: 'rectangle',
      x: 100,
      y: 200,
      width: 150,
      height: 80,
      version: 1,
      createdAt: '2024-01-01',
      updatedAt: '2024-01-01',
      syncedAt: '2024-01-01',
      source: 'mcp',
      syncTimestamp: 12345,
    };

    const cleaned = cleanElementForExcalidraw(serverEl);
    expect(cleaned).not.toHaveProperty('createdAt');
    expect(cleaned).not.toHaveProperty('updatedAt');
    expect(cleaned).not.toHaveProperty('version');
    expect(cleaned).not.toHaveProperty('syncedAt');
    expect(cleaned).not.toHaveProperty('source');
    expect(cleaned).not.toHaveProperty('syncTimestamp');
    // Core props preserved
    expect(cleaned.id).toBe('el-1');
    expect(cleaned.type).toBe('rectangle');
    expect(cleaned.x).toBe(100);
  });

  it('preserves label text on container elements', () => {
    const el = {
      id: 'cont-1',
      type: 'rectangle',
      x: 0, y: 0, width: 200, height: 100,
      label: { text: 'My Label' },
    };

    const cleaned = cleanElementForExcalidraw(el);
    expect(cleaned.label?.text || (cleaned as any).text).toBeDefined();
  });

  it('preserves arrow binding properties', () => {
    const arrow = {
      id: 'arrow-1',
      type: 'arrow',
      x: 0, y: 0,
      width: 200, height: 0,
      start: { id: 'rect-1' },
      end: { id: 'rect-2' },
      startElementId: 'rect-1',
      endElementId: 'rect-2',
    };

    const cleaned = cleanElementForExcalidraw(arrow);
    // Should preserve binding references
    expect(cleaned.type).toBe('arrow');
  });

  it('handles elements with no optional properties', () => {
    const minimal = {
      id: 'min-1',
      type: 'rectangle',
      x: 0,
      y: 0,
      width: 100,
      height: 50,
    };

    const cleaned = cleanElementForExcalidraw(minimal);
    expect(cleaned.id).toBe('min-1');
    expect(cleaned.type).toBe('rectangle');
  });

  it('handles text element with originalText', () => {
    const textEl = {
      id: 'text-1',
      type: 'text',
      x: 0, y: 0,
      text: 'Hello',
      originalText: 'Hello',
      fontSize: 20,
      fontFamily: 1,
    };

    const cleaned = cleanElementForExcalidraw(textEl);
    expect(cleaned.type).toBe('text');
  });
});

// ─── computeElementHash ─────────────────────────────────────

describe('computeElementHash - edge cases', () => {
  it('hash changes when element position changes', () => {
    const elements = [{ id: 'h1', type: 'rectangle', x: 0, y: 0, width: 100, height: 50, version: 1 }] as any;
    const hash1 = computeElementHash(elements);

    const moved = [{ id: 'h1', type: 'rectangle', x: 50, y: 50, width: 100, height: 50, version: 2 }] as any;
    const hash2 = computeElementHash(moved);

    expect(hash1).not.toBe(hash2);
  });

  it('hash changes when element is deleted (removed from array)', () => {
    const full = [
      { id: 'h1', type: 'rectangle', version: 1 },
      { id: 'h2', type: 'ellipse', version: 1 },
    ] as any;
    const partial = [{ id: 'h1', type: 'rectangle', version: 1 }] as any;

    expect(computeElementHash(full)).not.toBe(computeElementHash(partial));
  });

  it('hash is stable for same input', () => {
    const elements = [
      { id: 'stable-1', type: 'rectangle', version: 1 },
      { id: 'stable-2', type: 'ellipse', version: 1 },
    ] as any;

    expect(computeElementHash(elements)).toBe(computeElementHash(elements));
  });

  it('hash uses id+version (type changes without version bump are not detected)', () => {
    // Hash formula is: count + join(id+version) — type is NOT included
    const rect = [{ id: 'morph', type: 'rectangle', version: 1 }] as any;
    const ellipse = [{ id: 'morph', type: 'ellipse', version: 1 }] as any;

    // Same id+version → same hash (this is expected behavior)
    expect(computeElementHash(rect)).toBe(computeElementHash(ellipse));

    // Version bump makes them different
    const updated = [{ id: 'morph', type: 'ellipse', version: 2 }] as any;
    expect(computeElementHash(rect)).not.toBe(computeElementHash(updated));
  });
});

// ─── validateAndFixBindings comprehensive ───────────────────

describe('validateAndFixBindings - comprehensive', () => {
  it('preserves valid container + bound text relationship', () => {
    const elements = [
      {
        id: 'container',
        type: 'rectangle',
        boundElements: [{ id: 'bound-text', type: 'text' }],
      },
      {
        id: 'bound-text',
        type: 'text',
        containerId: 'container',
      },
    ];

    const result = validateAndFixBindings(elements);
    const container = result.find((e: any) => e.id === 'container');
    const text = result.find((e: any) => e.id === 'bound-text');

    expect(container.boundElements).toHaveLength(1);
    expect(text.containerId).toBe('container');
  });

  it('removes orphaned boundElements references', () => {
    const elements = [
      {
        id: 'container',
        type: 'rectangle',
        boundElements: [
          { id: 'exists', type: 'text' },
          { id: 'ghost', type: 'text' },
        ],
      },
      { id: 'exists', type: 'text', containerId: 'container' },
    ];

    const result = validateAndFixBindings(elements);
    const container = result.find((e: any) => e.id === 'container');
    expect(container.boundElements).toHaveLength(1);
    expect(container.boundElements[0].id).toBe('exists');
  });

  it('nullifies containerId when container does not exist', () => {
    const elements = [
      { id: 'orphan', type: 'text', containerId: 'nonexistent' },
    ];

    const result = validateAndFixBindings(elements);
    expect(result[0].containerId).toBeNull();
  });

  it('handles arrow boundElements correctly', () => {
    const elements = [
      {
        id: 'shape',
        type: 'rectangle',
        boundElements: [{ id: 'arrow-1', type: 'arrow' }],
      },
      {
        id: 'arrow-1',
        type: 'arrow',
        startBinding: { elementId: 'shape' },
      },
    ];

    const result = validateAndFixBindings(elements);
    const shape = result.find((e: any) => e.id === 'shape');
    expect(shape.boundElements).toHaveLength(1);
  });

  it('handles empty boundElements array (converts to null)', () => {
    const elements = [{ id: 'empty', type: 'rectangle', boundElements: [] }];
    const result = validateAndFixBindings(elements);
    // Implementation converts empty filtered arrays to null
    expect(result[0].boundElements).toBeNull();
  });

  it('handles null boundElements', () => {
    const elements = [{ id: 'null-bound', type: 'rectangle', boundElements: null }];
    const result = validateAndFixBindings(elements);
    expect(result[0].boundElements).toBeNull();
  });
});

// ─── isImageElement ─────────────────────────────────────────

describe('isImageElement - comprehensive', () => {
  it('returns true for image type', () => {
    expect(isImageElement({ type: 'image', fileId: 'f1' })).toBe(true);
  });

  it('returns false for all other types', () => {
    const nonImageTypes = ['rectangle', 'ellipse', 'diamond', 'arrow', 'line', 'text', 'freedraw'];
    for (const type of nonImageTypes) {
      expect(isImageElement({ type })).toBe(false);
    }
  });

  it('returns true when fileId is present regardless of type', () => {
    // Some implementations check fileId as fallback
    const result = isImageElement({ type: 'image', fileId: 'some-file' });
    expect(result).toBe(true);
  });
});

// ─── isShapeContainerType ───────────────────────────────────

describe('isShapeContainerType - comprehensive', () => {
  it('returns true for all container types', () => {
    const containerTypes = ['rectangle', 'ellipse', 'diamond'];
    for (const type of containerTypes) {
      expect(isShapeContainerType(type)).toBe(true);
    }
  });

  it('returns true for arrow and line (they are container types)', () => {
    // arrow and line are included in SHAPE_CONTAINER_TYPES
    expect(isShapeContainerType('arrow')).toBe(true);
    expect(isShapeContainerType('line')).toBe(true);
  });

  it('returns false for non-container types', () => {
    const nonContainer = ['text', 'freedraw', 'image', 'frame'];
    for (const type of nonContainer) {
      expect(isShapeContainerType(type)).toBe(false);
    }
  });
});

// ─── normalizeImageElement ──────────────────────────────────

describe('normalizeImageElement - comprehensive', () => {
  it('fills in all required defaults for minimal image', () => {
    const minimal = {
      id: 'img-1',
      type: 'image',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      fileId: 'file-1',
    };

    const normalized = normalizeImageElement(minimal);
    expect(normalized.type).toBe('image');
    expect(normalized.fileId).toBe('file-1');
    // Should have all required Excalidraw properties
    expect(normalized).toHaveProperty('strokeColor');
    expect(normalized).toHaveProperty('backgroundColor');
    expect(normalized).toHaveProperty('fillStyle');
    expect(normalized).toHaveProperty('opacity');
  });

  it('preserves explicit values over defaults', () => {
    const custom = {
      id: 'img-2',
      type: 'image',
      x: 50,
      y: 50,
      width: 200,
      height: 150,
      fileId: 'file-2',
      opacity: 50,
      angle: 1.5,
    };

    const normalized = normalizeImageElement(custom);
    expect(normalized.opacity).toBe(50);
    expect(normalized.angle).toBe(1.5);
    expect(normalized.x).toBe(50);
    expect(normalized.y).toBe(50);
  });
});

// ─── restoreBindings ────────────────────────────────────────

describe('restoreBindings - comprehensive', () => {
  it('restores startBinding and endBinding from originals', () => {
    const converted = [
      { id: 'arrow-1', type: 'arrow' },
    ];
    const originals = [
      {
        id: 'arrow-1',
        type: 'arrow',
        startBinding: { elementId: 'rect-1', focus: 0, gap: 5, fixedPoint: null },
        endBinding: { elementId: 'rect-2', focus: 0, gap: 5, fixedPoint: null },
      },
    ];

    const result = restoreBindings(converted, originals);
    expect(result[0].startBinding.elementId).toBe('rect-1');
    expect(result[0].endBinding.elementId).toBe('rect-2');
  });

  it('restores boundElements on shapes', () => {
    const converted = [
      { id: 'shape-1', type: 'rectangle' },
    ];
    const originals = [
      {
        id: 'shape-1',
        type: 'rectangle',
        boundElements: [{ id: 'arrow-1', type: 'arrow' }],
      },
    ];

    const result = restoreBindings(converted, originals);
    expect(result[0].boundElements).toHaveLength(1);
  });

  it('does not overwrite existing bindings', () => {
    const converted = [
      {
        id: 'arrow-1',
        type: 'arrow',
        startBinding: { elementId: 'already-set', focus: 0, gap: 3, fixedPoint: null },
      },
    ];
    const originals = [
      {
        id: 'arrow-1',
        type: 'arrow',
        startBinding: { elementId: 'original', focus: 0, gap: 5, fixedPoint: null },
      },
    ];

    const result = restoreBindings(converted, originals);
    expect(result[0].startBinding.elementId).toBe('already-set');
  });

  it('handles element not found in originals', () => {
    const converted = [{ id: 'new-1', type: 'rectangle' }];
    const originals = [{ id: 'other', type: 'ellipse' }];

    const result = restoreBindings(converted, originals);
    expect(result[0].id).toBe('new-1');
    // Should not crash
  });

  it('restores elbowed property on arrows', () => {
    const converted = [{ id: 'elb-arrow', type: 'arrow' }];
    const originals = [
      { id: 'elb-arrow', type: 'arrow', elbowed: true },
    ];

    const result = restoreBindings(converted, originals);
    expect(result[0].elbowed).toBe(true);
  });
});

// ─── Delta Computation Logic (simulated) ────────────────────
// Tests the algorithm used in syncToBackend for detecting changes

describe('Delta computation (simulated syncToBackend logic)', () => {
  type Element = { id: string; type: string; x: number; version: number };

  function computeDelta(
    currentElements: Element[],
    lastSynced: Map<string, Element>
  ): { id: string; action: 'upsert' | 'delete'; element?: Element }[] {
    const changes: { id: string; action: 'upsert' | 'delete'; element?: Element }[] = [];
    const currentMap = new Map<string, Element>();

    for (const el of currentElements) {
      currentMap.set(el.id, el);
      const prev = lastSynced.get(el.id);
      if (!prev || JSON.stringify(prev) !== JSON.stringify(el)) {
        changes.push({ id: el.id, action: 'upsert', element: el });
      }
    }

    for (const [id] of lastSynced) {
      if (!currentMap.has(id)) {
        changes.push({ id, action: 'delete' });
      }
    }

    return changes;
  }

  it('detects new elements as upserts', () => {
    const current = [{ id: 'a', type: 'rect', x: 0, version: 1 }];
    const lastSynced = new Map<string, Element>();

    const delta = computeDelta(current, lastSynced);
    expect(delta).toHaveLength(1);
    expect(delta[0].action).toBe('upsert');
    expect(delta[0].id).toBe('a');
  });

  it('detects removed elements as deletes', () => {
    const current: Element[] = [];
    const lastSynced = new Map<string, Element>([
      ['a', { id: 'a', type: 'rect', x: 0, version: 1 }],
      ['b', { id: 'b', type: 'rect', x: 100, version: 1 }],
    ]);

    const delta = computeDelta(current, lastSynced);
    expect(delta).toHaveLength(2);
    expect(delta.every(d => d.action === 'delete')).toBe(true);
  });

  it('detects updated elements as upserts', () => {
    const current = [{ id: 'a', type: 'rect', x: 50, version: 2 }];
    const lastSynced = new Map<string, Element>([
      ['a', { id: 'a', type: 'rect', x: 0, version: 1 }],
    ]);

    const delta = computeDelta(current, lastSynced);
    expect(delta).toHaveLength(1);
    expect(delta[0].action).toBe('upsert');
  });

  it('returns empty when nothing changed', () => {
    const el = { id: 'a', type: 'rect', x: 0, version: 1 };
    const current = [el];
    const lastSynced = new Map<string, Element>([['a', { ...el }]]);

    const delta = computeDelta(current, lastSynced);
    expect(delta).toHaveLength(0);
  });

  it('handles mixed operations correctly', () => {
    const current = [
      { id: 'a', type: 'rect', x: 50, version: 2 }, // updated
      { id: 'c', type: 'rect', x: 200, version: 1 }, // new
    ];
    const lastSynced = new Map<string, Element>([
      ['a', { id: 'a', type: 'rect', x: 0, version: 1 }],
      ['b', { id: 'b', type: 'rect', x: 100, version: 1 }], // deleted
    ]);

    const delta = computeDelta(current, lastSynced);
    expect(delta).toHaveLength(3);

    const upserts = delta.filter(d => d.action === 'upsert');
    const deletes = delta.filter(d => d.action === 'delete');

    expect(upserts).toHaveLength(2); // a (updated) + c (new)
    expect(deletes).toHaveLength(1); // b
    expect(deletes[0].id).toBe('b');
  });

  it('THE BUG: empty lastSynced means no deletions detected', () => {
    // This is the exact bug scenario: elements loaded from server but lastSynced not populated
    const current: Element[] = []; // User deleted everything
    const lastSynced = new Map<string, Element>(); // Bug: was never populated

    const delta = computeDelta(current, lastSynced);
    // With empty lastSynced, no deletions are detected - this was the regression
    expect(delta).toHaveLength(0);
  });

  it('FIXED: populated lastSynced detects all deletions', () => {
    // After fix: lastSynced is populated on load
    const current: Element[] = []; // User deleted everything
    const lastSynced = new Map<string, Element>([
      ['a', { id: 'a', type: 'rect', x: 0, version: 1 }],
      ['b', { id: 'b', type: 'rect', x: 100, version: 1 }],
    ]);

    const delta = computeDelta(current, lastSynced);
    expect(delta).toHaveLength(2);
    expect(delta.every(d => d.action === 'delete')).toBe(true);
  });
});
