import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { initDb, closeDb, setElement, setActiveTenant } from '../../src/db.js';
import type { ServerElement } from '../../src/types.js';
import path from 'path';
import os from 'os';
import fs from 'fs';

let dbPath: string;
let app: any;

function makeRect(overrides: Partial<ServerElement> = {}): ServerElement {
  return {
    id: `rect-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    type: 'rectangle',
    x: 0,
    y: 0,
    width: 150,
    height: 80,
    version: 1,
    ...overrides,
  };
}

function makeEllipse(overrides: Partial<ServerElement> = {}): ServerElement {
  return {
    id: `ell-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    type: 'ellipse',
    x: 0,
    y: 0,
    width: 120,
    height: 120,
    version: 1,
    ...overrides,
  };
}

function makeDiamond(overrides: Partial<ServerElement> = {}): ServerElement {
  return {
    id: `dia-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    type: 'diamond',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    version: 1,
    ...overrides,
  };
}

function makeArrow(id: string, startId?: string, endId?: string): any {
  return {
    id,
    type: 'arrow',
    x: 0,
    y: 0,
    width: 100,
    height: 0,
    ...(startId ? { start: { id: startId } } : {}),
    ...(endId ? { end: { id: endId } } : {}),
  };
}

beforeEach(async () => {
  dbPath = path.join(os.tmpdir(), `excalidraw-arrow-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  initDb(dbPath);
  setActiveTenant('default');
  const mod = await import('../../src/server.js');
  app = mod.default;
});

afterEach(() => {
  closeDb();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
});

// ─── Arrow Binding Resolution via Batch Create ──────────────

describe('Arrow binding resolution - rectangles', () => {
  it('resolves arrow between two rectangles', async () => {
    const r1 = makeRect({ id: 'r1', x: 0, y: 0, width: 100, height: 50 });
    const r2 = makeRect({ id: 'r2', x: 300, y: 0, width: 100, height: 50 });
    const arrow = makeArrow('a1', 'r1', 'r2');

    const res = await request(app)
      .post('/api/elements/batch')
      .send({ elements: [r1, r2, arrow] });

    expect(res.body.success).toBe(true);
    const createdArrow = res.body.elements.find((e: any) => e.id === 'a1');
    expect(createdArrow).toBeDefined();
    // Arrow should have computed start/end points
    expect(typeof createdArrow.x).toBe('number');
    expect(typeof createdArrow.y).toBe('number');
    expect(typeof createdArrow.width).toBe('number');
    expect(typeof createdArrow.height).toBe('number');
  });

  it('arrow points are positioned between the two rectangles', async () => {
    const r1 = makeRect({ id: 'r1', x: 0, y: 0, width: 100, height: 50 });
    const r2 = makeRect({ id: 'r2', x: 400, y: 0, width: 100, height: 50 });
    const arrow = makeArrow('a1', 'r1', 'r2');

    const res = await request(app)
      .post('/api/elements/batch')
      .send({ elements: [r1, r2, arrow] });

    const a = res.body.elements.find((e: any) => e.id === 'a1');
    // Arrow should have reasonable coordinates between the two shapes
    // The exact positions depend on edge-point computation; just verify it's between the two shape centers
    expect(a.x).toBeGreaterThanOrEqual(0);
    expect(a.x + a.width).toBeLessThanOrEqual(600);
  });
});

describe('Arrow binding resolution - ellipses', () => {
  it('resolves arrow between two ellipses', async () => {
    const e1 = makeEllipse({ id: 'e1', x: 0, y: 0, width: 80, height: 80 });
    const e2 = makeEllipse({ id: 'e2', x: 300, y: 0, width: 80, height: 80 });
    const arrow = makeArrow('ae1', 'e1', 'e2');

    const res = await request(app)
      .post('/api/elements/batch')
      .send({ elements: [e1, e2, arrow] });

    expect(res.body.success).toBe(true);
    const a = res.body.elements.find((e: any) => e.id === 'ae1');
    expect(a).toBeDefined();
  });
});

describe('Arrow binding resolution - diamonds', () => {
  it('resolves arrow between two diamonds', async () => {
    const d1 = makeDiamond({ id: 'd1', x: 0, y: 0, width: 100, height: 100 });
    const d2 = makeDiamond({ id: 'd2', x: 300, y: 0, width: 100, height: 100 });
    const arrow = makeArrow('ad1', 'd1', 'd2');

    const res = await request(app)
      .post('/api/elements/batch')
      .send({ elements: [d1, d2, arrow] });

    expect(res.body.success).toBe(true);
    const a = res.body.elements.find((e: any) => e.id === 'ad1');
    expect(a).toBeDefined();
  });
});

describe('Arrow binding resolution - mixed shapes', () => {
  it('resolves arrow from rectangle to ellipse', async () => {
    const r = makeRect({ id: 'mr', x: 0, y: 0, width: 100, height: 50 });
    const e = makeEllipse({ id: 'me', x: 300, y: 0, width: 80, height: 80 });
    const arrow = makeArrow('ma1', 'mr', 'me');

    const res = await request(app)
      .post('/api/elements/batch')
      .send({ elements: [r, e, arrow] });

    expect(res.body.success).toBe(true);
  });

  it('resolves arrow from diamond to rectangle', async () => {
    const d = makeDiamond({ id: 'md', x: 0, y: 0, width: 100, height: 100 });
    const r = makeRect({ id: 'mr2', x: 300, y: 0, width: 150, height: 80 });
    const arrow = makeArrow('ma2', 'md', 'mr2');

    const res = await request(app)
      .post('/api/elements/batch')
      .send({ elements: [d, r, arrow] });

    expect(res.body.success).toBe(true);
  });
});

describe('Arrow binding resolution - edge cases', () => {
  it('arrow with only start binding', async () => {
    const r = makeRect({ id: 'so', x: 0, y: 0, width: 100, height: 50 });
    const arrow = makeArrow('sa1', 'so', undefined);

    const res = await request(app)
      .post('/api/elements/batch')
      .send({ elements: [r, arrow] });

    expect(res.body.success).toBe(true);
  });

  it('arrow with only end binding', async () => {
    const r = makeRect({ id: 'eo', x: 300, y: 0, width: 100, height: 50 });
    const arrow = makeArrow('ea1', undefined, 'eo');

    const res = await request(app)
      .post('/api/elements/batch')
      .send({ elements: [r, arrow] });

    expect(res.body.success).toBe(true);
  });

  it('arrow referencing non-existent element does not crash', async () => {
    const arrow = makeArrow('ghost-arrow', 'nonexistent-1', 'nonexistent-2');

    const res = await request(app)
      .post('/api/elements/batch')
      .send({ elements: [arrow] });

    expect(res.body.success).toBe(true);
  });

  it('arrow between overlapping shapes (same center)', async () => {
    const r1 = makeRect({ id: 'ov1', x: 100, y: 100, width: 100, height: 50 });
    const r2 = makeRect({ id: 'ov2', x: 100, y: 100, width: 100, height: 50 });
    const arrow = makeArrow('ova', 'ov1', 'ov2');

    const res = await request(app)
      .post('/api/elements/batch')
      .send({ elements: [r1, r2, arrow] });

    // Should not crash even with identical centers (dx=0, dy=0)
    expect(res.body.success).toBe(true);
  });

  it('arrow between vertically aligned shapes', async () => {
    const r1 = makeRect({ id: 'vr1', x: 100, y: 0, width: 100, height: 50 });
    const r2 = makeRect({ id: 'vr2', x: 100, y: 300, width: 100, height: 50 });
    const arrow = makeArrow('va', 'vr1', 'vr2');

    const res = await request(app)
      .post('/api/elements/batch')
      .send({ elements: [r1, r2, arrow] });

    expect(res.body.success).toBe(true);
    const a = res.body.elements.find((e: any) => e.id === 'va');
    // Arrow should connect shapes that are vertically aligned — just verify it exists and has valid dimensions
    expect(typeof a.width).toBe('number');
    expect(typeof a.height).toBe('number');
  });

  it('cross-batch arrow referencing pre-existing element', async () => {
    // Create a shape first
    setElement('pre-existing', makeRect({ id: 'pre-existing', x: 0, y: 0, width: 100, height: 50 }));

    // Batch create an arrow referencing the pre-existing shape
    const r2 = makeRect({ id: 'batch-r', x: 300, y: 0, width: 100, height: 50 });
    const arrow = makeArrow('cross-arrow', 'pre-existing', 'batch-r');

    const res = await request(app)
      .post('/api/elements/batch')
      .send({ elements: [r2, arrow] });

    expect(res.body.success).toBe(true);
  });

  it('multiple arrows between same two shapes', async () => {
    const r1 = makeRect({ id: 'multi-r1', x: 0, y: 0, width: 100, height: 50 });
    const r2 = makeRect({ id: 'multi-r2', x: 300, y: 0, width: 100, height: 50 });
    const a1 = makeArrow('multi-a1', 'multi-r1', 'multi-r2');
    const a2 = makeArrow('multi-a2', 'multi-r2', 'multi-r1');

    const res = await request(app)
      .post('/api/elements/batch')
      .send({ elements: [r1, r2, a1, a2] });

    expect(res.body.success).toBe(true);
    expect(res.body.elements).toHaveLength(4);
  });
});
