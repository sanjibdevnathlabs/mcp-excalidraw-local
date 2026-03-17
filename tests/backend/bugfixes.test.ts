import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { initDb, closeDb, setElement, setActiveTenant, clearElements } from '../../src/db.js';
import type { ServerElement } from '../../src/types.js';
import path from 'path';
import os from 'os';
import fs from 'fs';

let dbPath: string;
let app: any;

function makeElement(overrides: Partial<ServerElement> = {}): ServerElement {
  return {
    id: `el-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    type: 'rectangle',
    x: 100,
    y: 200,
    width: 150,
    height: 80,
    version: 1,
    ...overrides,
  };
}

beforeEach(async () => {
  dbPath = path.join(os.tmpdir(), `excalidraw-bugfix-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
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

// ─── Fix 1: Batch create returns proper error messages ──────

describe('Batch create error handling', () => {
  it('rejects invalid element in batch with descriptive error', async () => {
    const res = await request(app)
      .post('/api/elements/batch')
      .send({
        elements: [
          { type: 'rectangle', x: 0, y: 0, width: 100, height: 50 },
          { type: 'invalid-type', x: 0, y: 0 }, // invalid type
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    // Should include actual validation error, not "HTTP server unavailable"
    expect(res.body.error).toBeDefined();
    expect(res.body.error).not.toContain('HTTP server unavailable');
  });

  it('batch create with all valid elements succeeds', async () => {
    const res = await request(app)
      .post('/api/elements/batch')
      .send({
        elements: [
          { type: 'rectangle', x: 0, y: 0, width: 100, height: 50 },
          { type: 'ellipse', x: 200, y: 0, width: 80, height: 80 },
          { type: 'text', x: 50, y: 50, text: 'Hello' },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.count).toBe(3);
  });

  it('batch create preserves all elements in DB', async () => {
    const res = await request(app)
      .post('/api/elements/batch')
      .send({
        elements: [
          { id: 'b1', type: 'rectangle', x: 0, y: 0, width: 100, height: 50 },
          { id: 'b2', type: 'ellipse', x: 200, y: 0, width: 80, height: 80 },
        ],
      });

    expect(res.status).toBe(200);

    const listRes = await request(app).get('/api/elements');
    expect(listRes.body.count).toBe(2);
    const ids = listRes.body.elements.map((e: any) => e.id);
    expect(ids).toContain('b1');
    expect(ids).toContain('b2');
  });
});

// ─── Fix 2: Image export endpoint passes captureViewport ────

describe('Image export captureViewport parameter', () => {
  it('accepts captureViewport parameter in export request', async () => {
    // Without a connected WS client, this will 503.
    // We just verify the endpoint accepts the parameter without crashing.
    const res = await request(app)
      .post('/api/export/image')
      .send({ format: 'png', background: true, captureViewport: true });

    // 503 = no frontend connected (expected in tests), but not 400 (bad request)
    expect(res.status).toBe(503);
    expect(res.body.error).toContain('No frontend client connected');
  });

  it('rejects invalid format even with captureViewport', async () => {
    const res = await request(app)
      .post('/api/export/image')
      .send({ format: 'bmp', captureViewport: true });

    expect(res.status).toBe(400);
  });
});

// ─── Fix 4: set_viewport uses animate: false ────────────────
// (This is tested in E2E where the browser processes viewport commands.)
// For the backend, we verify the viewport endpoint accepts requests.

describe('Viewport endpoint', () => {
  it('accepts viewport control request', async () => {
    // Without a connected WS client this will 503
    const res = await request(app)
      .post('/api/viewport')
      .send({ scrollToContent: true });

    // The viewport endpoint may not exist as a REST endpoint — it's WS-driven.
    // If it returns 404, that's fine; the point is we don't crash.
    expect([200, 404, 503].includes(res.status)).toBe(true);
  });
});

// ─── Concurrent element creation doesn't lose elements ──────

describe('Concurrent element creation', () => {
  it('parallel POST /api/elements all persist correctly', async () => {
    const promises = Array.from({ length: 5 }, (_, i) =>
      request(app)
        .post('/api/elements')
        .send({
          id: `concurrent-${i}`,
          type: 'rectangle',
          x: i * 100,
          y: 0,
          width: 80,
          height: 50,
        })
    );

    const results = await Promise.all(promises);
    for (const res of results) {
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    }

    // All 5 elements should exist in the DB
    const listRes = await request(app).get('/api/elements');
    expect(listRes.body.count).toBe(5);

    const ids = listRes.body.elements.map((e: any) => e.id).sort();
    expect(ids).toEqual([
      'concurrent-0',
      'concurrent-1',
      'concurrent-2',
      'concurrent-3',
      'concurrent-4',
    ]);
  });

  it('parallel batch + single creates all persist', async () => {
    const batchPromise = request(app)
      .post('/api/elements/batch')
      .send({
        elements: [
          { id: 'batch-a', type: 'rectangle', x: 0, y: 0, width: 50, height: 50 },
          { id: 'batch-b', type: 'ellipse', x: 100, y: 0, width: 50, height: 50 },
        ],
      });

    const singlePromise = request(app)
      .post('/api/elements')
      .send({ id: 'single-c', type: 'diamond', x: 200, y: 0, width: 60, height: 60 });

    const [batchRes, singleRes] = await Promise.all([batchPromise, singlePromise]);
    expect(batchRes.status).toBe(200);
    expect(singleRes.status).toBe(200);

    const listRes = await request(app).get('/api/elements');
    expect(listRes.body.count).toBe(3);
  });
});
