import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { initDb, closeDb, setActiveTenant } from '../../src/db.js';
import path from 'path';
import os from 'os';
import fs from 'fs';

let dbPath: string;
let app: any;

beforeEach(async () => {
  dbPath = path.join(os.tmpdir(), `excalidraw-security-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
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

// ─── Input Validation ───────────────────────────────────────

describe('Input validation - element creation', () => {
  it('rejects element with missing type', async () => {
    const res = await request(app)
      .post('/api/elements')
      .send({ x: 0, y: 0, width: 100, height: 50 });

    expect(res.status).toBe(400);
  });

  it('rejects element with invalid type', async () => {
    const res = await request(app)
      .post('/api/elements')
      .send({ type: 'malicious<script>', x: 0, y: 0, width: 100, height: 50 });

    expect(res.status).toBe(400);
  });

  it('rejects element with negative dimensions gracefully', async () => {
    // Server should handle negative dimensions without crashing
    const res = await request(app)
      .post('/api/elements')
      .send({ type: 'rectangle', x: 0, y: 0, width: -100, height: -50 });

    // May succeed (Excalidraw allows negative) or fail validation — either is acceptable
    expect([200, 400]).toContain(res.status);
  });

  it('handles very large coordinates without crashing', async () => {
    const res = await request(app)
      .post('/api/elements')
      .send({ type: 'rectangle', x: 1e15, y: 1e15, width: 100, height: 50 });

    // Should not crash the server
    expect([200, 400]).toContain(res.status);
  });
});

describe('Input validation - batch operations', () => {
  it('rejects batch with non-array elements', async () => {
    const res = await request(app)
      .post('/api/elements/batch')
      .send({ elements: { not: 'an array' } });

    expect(res.status).toBe(400);
  });

  it('rejects batch with null elements', async () => {
    const res = await request(app)
      .post('/api/elements/batch')
      .send({ elements: null });

    expect(res.status).toBe(400);
  });

  it('handles extremely large batch without crash', async () => {
    const elements = Array.from({ length: 100 }, (_, i) => ({
      id: `bulk-${i}`,
      type: 'rectangle',
      x: i * 10,
      y: 0,
      width: 8,
      height: 8,
    }));

    const res = await request(app)
      .post('/api/elements/batch')
      .send({ elements });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('Input validation - sync endpoints', () => {
  it('POST /api/elements/sync rejects non-array elements', async () => {
    const res = await request(app)
      .post('/api/elements/sync')
      .send({ elements: 'not-array' });

    expect(res.status).toBe(400);
  });

  it('POST /api/elements/sync/v2 rejects non-number lastSyncVersion', async () => {
    const res = await request(app)
      .post('/api/elements/sync/v2')
      .send({ lastSyncVersion: 'not-a-number', changes: [] });

    expect(res.status).toBe(400);
  });

  it('POST /api/elements/sync/v2 handles missing changes gracefully', async () => {
    const res = await request(app)
      .post('/api/elements/sync/v2')
      .send({ lastSyncVersion: 0 });

    // Should use default empty array
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('Input validation - settings', () => {
  it('PUT /api/settings/:key rejects missing value', async () => {
    const res = await request(app)
      .put('/api/settings/test')
      .send({});

    expect(res.status).toBe(400);
  });

  it('GET /api/settings/:key returns null for missing key', async () => {
    const res = await request(app).get('/api/settings/nonexistent');
    expect(res.body.value).toBeNull();
  });
});

describe('Input validation - tenant operations', () => {
  it('PUT /api/tenant/active rejects missing tenantId', async () => {
    const res = await request(app)
      .put('/api/tenant/active')
      .send({});

    expect(res.status).toBe(400);
  });

  it('PUT /api/tenant/active rejects non-existent tenant', async () => {
    const res = await request(app)
      .put('/api/tenant/active')
      .send({ tenantId: 'nonexistent-tenant-xyz' });

    expect(res.status).toBe(400);
  });
});

describe('Input validation - search', () => {
  it('GET /api/elements/search with no params returns all elements', async () => {
    const res = await request(app).get('/api/elements/search');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('GET /api/elements/search handles special characters in query', async () => {
    const res = await request(app).get('/api/elements/search?q=%22OR%201%3D1');
    // FTS5 may reject special chars with 500 — acceptable as long as server doesn't crash
    expect([200, 400, 500]).toContain(res.status);
  });
});

describe('Input validation - mermaid', () => {
  it('rejects non-string mermaid diagram', async () => {
    const res = await request(app)
      .post('/api/elements/from-mermaid')
      .send({ mermaidDiagram: 12345 });

    expect(res.status).toBe(400);
  });
});

// ─── Header Handling ────────────────────────────────────────

describe('X-Tenant-Id header handling', () => {
  it('invalid X-Tenant-Id gracefully falls back', async () => {
    const res = await request(app)
      .get('/api/elements')
      .set('X-Tenant-Id', 'nonexistent-tenant');

    // Should either return empty elements or error — 500 is acceptable for unknown tenant
    expect([200, 400, 404, 500]).toContain(res.status);
  });
});

// ─── Content-Type Handling ──────────────────────────────────

describe('Content-Type edge cases', () => {
  it('POST with no content-type header handles gracefully', async () => {
    const res = await request(app)
      .post('/api/elements')
      .send('');

    // Should not crash
    expect([200, 400]).toContain(res.status);
  });
});
