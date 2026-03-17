import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { initDb, closeDb, setElement, getAllElements, setSetting, getSetting, getCurrentSyncVersion, setActiveTenant } from '../../src/db.js';
import type { ServerElement } from '../../src/types.js';
import path from 'path';
import os from 'os';
import fs from 'fs';

let dbPath: string;

// Dynamic import to ensure DB is initialized before module-level code in server.ts runs
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
  dbPath = path.join(os.tmpdir(), `excalidraw-api-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  initDb(dbPath);
  // Reset module-level active tenant/project to 'default' (may be stale from previous test)
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

// ─── Health ──────────────────────────────────────────────────

describe('GET /health', () => {
  it('returns healthy status', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('healthy');
    expect(res.body).toHaveProperty('elements_count');
    expect(res.body).toHaveProperty('timestamp');
  });
});

// ─── Elements CRUD ───────────────────────────────────────────

describe('GET /api/elements', () => {
  it('returns empty list initially', async () => {
    const res = await request(app).get('/api/elements');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.elements).toEqual([]);
    expect(res.body.count).toBe(0);
  });

  it('returns elements after creation', async () => {
    setElement('e1', makeElement({ id: 'e1' }));
    setElement('e2', makeElement({ id: 'e2' }));

    const res = await request(app).get('/api/elements');
    expect(res.body.count).toBe(2);
  });
});

describe('POST /api/elements', () => {
  it('creates an element and returns it', async () => {
    const res = await request(app)
      .post('/api/elements')
      .send({ type: 'rectangle', x: 10, y: 20, width: 100, height: 50 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.element.type).toBe('rectangle');
    expect(res.body.element.x).toBe(10);
    expect(res.body.element).toHaveProperty('id');
  });

  it('accepts a custom id', async () => {
    const res = await request(app)
      .post('/api/elements')
      .send({ id: 'custom-id', type: 'ellipse', x: 0, y: 0, width: 50, height: 50 });

    expect(res.body.element.id).toBe('custom-id');
  });

  it('rejects invalid element type', async () => {
    const res = await request(app)
      .post('/api/elements')
      .send({ type: 'invalid-type', x: 0, y: 0 });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('rejects missing required fields', async () => {
    const res = await request(app)
      .post('/api/elements')
      .send({ type: 'rectangle' });

    expect(res.status).toBe(400);
  });
});

describe('GET /api/elements/:id', () => {
  it('returns element by id', async () => {
    setElement('find-me', makeElement({ id: 'find-me', type: 'diamond' }));

    const res = await request(app).get('/api/elements/find-me');
    expect(res.status).toBe(200);
    expect(res.body.element.id).toBe('find-me');
    expect(res.body.element.type).toBe('diamond');
  });

  it('returns 404 for missing element', async () => {
    const res = await request(app).get('/api/elements/nonexistent');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });
});

describe('PUT /api/elements/:id', () => {
  it('updates an existing element', async () => {
    setElement('up1', makeElement({ id: 'up1', x: 0 }));

    const res = await request(app)
      .put('/api/elements/up1')
      .send({ x: 500, y: 600 });

    expect(res.status).toBe(200);
    expect(res.body.element.x).toBe(500);
    expect(res.body.element.y).toBe(600);
  });

  it('returns 404 for non-existent element', async () => {
    const res = await request(app)
      .put('/api/elements/missing')
      .send({ x: 1 });

    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/elements/:id', () => {
  it('deletes an existing element', async () => {
    setElement('del1', makeElement({ id: 'del1' }));

    const res = await request(app).delete('/api/elements/del1');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const getRes = await request(app).get('/api/elements/del1');
    expect(getRes.status).toBe(404);
  });

  it('returns 404 for non-existent element', async () => {
    const res = await request(app).delete('/api/elements/missing');
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/elements/clear', () => {
  it('clears all elements', async () => {
    setElement('a', makeElement({ id: 'a' }));
    setElement('b', makeElement({ id: 'b' }));

    const res = await request(app).delete('/api/elements/clear');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);

    const listRes = await request(app).get('/api/elements');
    expect(listRes.body.count).toBe(0);
  });

  it('returns 0 count when already empty', async () => {
    const res = await request(app).delete('/api/elements/clear');
    expect(res.body.count).toBe(0);
  });
});

// ─── Batch Create ────────────────────────────────────────────

describe('POST /api/elements/batch', () => {
  it('creates multiple elements at once', async () => {
    const res = await request(app)
      .post('/api/elements/batch')
      .send({
        elements: [
          { type: 'rectangle', x: 0, y: 0, width: 100, height: 50 },
          { type: 'ellipse', x: 200, y: 200, width: 80, height: 80 },
          { type: 'text', x: 50, y: 50, text: 'Hello' },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(3);
    expect(res.body.elements.length).toBe(3);
  });

  it('rejects non-array input', async () => {
    const res = await request(app)
      .post('/api/elements/batch')
      .send({ elements: 'not-an-array' });

    expect(res.status).toBe(400);
  });

  it('resolves arrow bindings between batch elements', async () => {
    const res = await request(app)
      .post('/api/elements/batch')
      .send({
        elements: [
          { id: 'box1', type: 'rectangle', x: 0, y: 0, width: 100, height: 50 },
          { id: 'box2', type: 'rectangle', x: 300, y: 0, width: 100, height: 50 },
          { id: 'arr1', type: 'arrow', x: 0, y: 0, start: { id: 'box1' }, end: { id: 'box2' } },
        ],
      });

    expect(res.status).toBe(200);
    const arrow = res.body.elements.find((e: any) => e.id === 'arr1');
    expect(arrow).toBeDefined();
    expect(arrow.points).toBeDefined();
    expect(arrow.startBinding).toBeDefined();
    expect(arrow.endBinding).toBeDefined();
  });
});

// ─── Search ──────────────────────────────────────────────────

describe('GET /api/elements/search', () => {
  it('filters by type query param', async () => {
    setElement('r1', makeElement({ id: 'r1', type: 'rectangle' }));
    setElement('e1', makeElement({ id: 'e1', type: 'ellipse' }));

    const res = await request(app).get('/api/elements/search?type=rectangle');
    expect(res.body.count).toBe(1);
    expect(res.body.elements[0].type).toBe('rectangle');
  });

  it('full-text search via q param', async () => {
    setElement('t1', makeElement({ id: 't1', type: 'text', label: { text: 'Hello World' } }));
    setElement('t2', makeElement({ id: 't2', type: 'text', label: { text: 'Goodbye' } }));

    const res = await request(app).get('/api/elements/search?q=Hello');
    expect(res.body.count).toBe(1);
    expect(res.body.elements[0].id).toBe('t1');
  });
});

// ─── Sync ────────────────────────────────────────────────────

describe('POST /api/elements/sync', () => {
  it('replaces all elements from frontend', async () => {
    setElement('old', makeElement({ id: 'old' }));

    const res = await request(app)
      .post('/api/elements/sync')
      .send({
        elements: [
          { id: 'new1', type: 'rectangle', x: 0, y: 0, width: 10, height: 10 },
          { id: 'new2', type: 'ellipse', x: 50, y: 50, width: 20, height: 20 },
        ],
        timestamp: new Date().toISOString(),
      });

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);

    const listRes = await request(app).get('/api/elements');
    expect(listRes.body.count).toBe(2);
    expect(listRes.body.elements.map((e: any) => e.id).sort()).toEqual(['new1', 'new2']);
  });

  it('rejects non-array elements', async () => {
    const res = await request(app)
      .post('/api/elements/sync')
      .send({ elements: 'nope', timestamp: new Date().toISOString() });

    expect(res.status).toBe(400);
  });
});

// ─── Snapshots ───────────────────────────────────────────────

describe('Snapshots API', () => {
  it('POST creates and GET lists snapshots', async () => {
    setElement('se1', makeElement({ id: 'se1' }));

    const createRes = await request(app)
      .post('/api/snapshots')
      .send({ name: 'my-snap' });

    expect(createRes.status).toBe(200);
    expect(createRes.body.name).toBe('my-snap');
    expect(createRes.body.elementCount).toBe(1);

    const listRes = await request(app).get('/api/snapshots');
    expect(listRes.body.count).toBe(1);
  });

  it('GET /api/snapshots/:name returns a specific snapshot', async () => {
    setElement('s1', makeElement({ id: 's1' }));
    await request(app).post('/api/snapshots').send({ name: 'get-snap' });

    const res = await request(app).get('/api/snapshots/get-snap');
    expect(res.status).toBe(200);
    expect(res.body.snapshot.name).toBe('get-snap');
  });

  it('GET /api/snapshots/:name returns 404 for missing', async () => {
    const res = await request(app).get('/api/snapshots/nonexistent');
    expect(res.status).toBe(404);
  });

  it('POST rejects missing name', async () => {
    const res = await request(app).post('/api/snapshots').send({});
    expect(res.status).toBe(400);
  });
});

// ─── Tenants API ─────────────────────────────────────────────

describe('Tenants API', () => {
  it('GET /api/tenants returns tenant list', async () => {
    const res = await request(app).get('/api/tenants');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.tenants)).toBe(true);
    expect(res.body.tenants.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/tenant/active returns current tenant', async () => {
    const res = await request(app).get('/api/tenant/active');
    expect(res.status).toBe(200);
    expect(res.body.tenant.id).toBe('default');
  });

  it('PUT /api/tenant/active switches tenant', async () => {
    const { ensureTenant } = await import('../../src/db.js');
    ensureTenant('switch-test', 'Switch Test', '/test');

    const res = await request(app)
      .put('/api/tenant/active')
      .send({ tenantId: 'switch-test' });

    expect(res.status).toBe(200);
    expect(res.body.tenant.id).toBe('switch-test');
  });

  it('PUT /api/tenant/active rejects missing tenantId', async () => {
    const res = await request(app).put('/api/tenant/active').send({});
    expect(res.status).toBe(400);
  });
});

// ─── Settings API ────────────────────────────────────────────

describe('Settings API', () => {
  it('GET returns null for missing key', async () => {
    const res = await request(app).get('/api/settings/missing_key');
    expect(res.status).toBe(200);
    expect(res.body.value).toBeNull();
  });

  it('PUT + GET round-trips a value', async () => {
    await request(app)
      .put('/api/settings/my_key')
      .send({ value: 'my_value' });

    const res = await request(app).get('/api/settings/my_key');
    expect(res.body.value).toBe('my_value');
  });

  it('PUT rejects missing value', async () => {
    const res = await request(app)
      .put('/api/settings/no_val')
      .send({});
    expect(res.status).toBe(400);
  });
});

// ─── Sync Status ─────────────────────────────────────────────

describe('GET /api/sync/status', () => {
  it('returns sync status', async () => {
    const res = await request(app).get('/api/sync/status');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body).toHaveProperty('elementCount');
    expect(res.body).toHaveProperty('memoryUsage');
    expect(res.body).toHaveProperty('websocketClients');
  });
});

// ─── Tenant-scoped via X-Tenant-Id header ────────────────────

describe('Tenant-scoped requests via X-Tenant-Id', () => {
  it('elements are isolated per tenant', async () => {
    const { ensureTenant } = await import('../../src/db.js');
    ensureTenant('tenant-a', 'A', '/a');
    ensureTenant('tenant-b', 'B', '/b');

    await request(app)
      .post('/api/elements')
      .set('X-Tenant-Id', 'tenant-a')
      .send({ type: 'rectangle', x: 0, y: 0, width: 10, height: 10 });

    await request(app)
      .post('/api/elements')
      .set('X-Tenant-Id', 'tenant-b')
      .send({ type: 'ellipse', x: 0, y: 0, width: 10, height: 10 });

    const resA = await request(app)
      .get('/api/elements')
      .set('X-Tenant-Id', 'tenant-a');
    expect(resA.body.count).toBe(1);
    expect(resA.body.elements[0].type).toBe('rectangle');

    const resB = await request(app)
      .get('/api/elements')
      .set('X-Tenant-Id', 'tenant-b');
    expect(resB.body.count).toBe(1);
    expect(resB.body.elements[0].type).toBe('ellipse');
  });
});

// ─── Sync Version ───────────────────────────────────────────

describe('GET /api/sync/version', () => {
  it('returns syncVersion 0 initially', async () => {
    const res = await request(app).get('/api/sync/version');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.syncVersion).toBe(0);
  });

  it('syncVersion increases after element creation', async () => {
    await request(app)
      .post('/api/elements')
      .send({ type: 'rectangle', x: 0, y: 0, width: 50, height: 50 });

    const res = await request(app).get('/api/sync/version');
    expect(res.status).toBe(200);
    expect(res.body.syncVersion).toBeGreaterThan(0);
  });
});

// ─── Delta Sync v2 ──────────────────────────────────────────

describe('POST /api/elements/sync/v2', () => {
  it('returns currentSyncVersion and empty serverChanges', async () => {
    const res = await request(app)
      .post('/api/elements/sync/v2')
      .send({ lastSyncVersion: 0, changes: [] });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body).toHaveProperty('currentSyncVersion');
    expect(typeof res.body.currentSyncVersion).toBe('number');
    expect(Array.isArray(res.body.serverChanges)).toBe(true);
    expect(res.body.serverChanges.length).toBe(0);
  });

  it('applies upsert changes', async () => {
    const res = await request(app)
      .post('/api/elements/sync/v2')
      .send({
        lastSyncVersion: 0,
        changes: [
          {
            id: 'sv2-1',
            action: 'upsert',
            element: { id: 'sv2-1', type: 'rectangle', x: 0, y: 0, width: 50, height: 50 },
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.appliedCount).toBe(1);

    const getRes = await request(app).get('/api/elements/sv2-1');
    expect(getRes.status).toBe(200);
    expect(getRes.body.element.id).toBe('sv2-1');
  });

  it('applies delete changes', async () => {
    setElement('sv2-del', makeElement({ id: 'sv2-del' }));

    const res = await request(app)
      .post('/api/elements/sync/v2')
      .send({
        lastSyncVersion: 0,
        changes: [{ id: 'sv2-del', action: 'delete' }],
      });

    expect(res.status).toBe(200);
    expect(res.body.appliedCount).toBe(1);

    const getRes = await request(app).get('/api/elements/sv2-del');
    expect(getRes.status).toBe(404);
  });

  it('returns server changes since lastSyncVersion', async () => {
    setElement('sv1', makeElement({ id: 'sv1' }));
    setElement('sv2', makeElement({ id: 'sv2' }));

    const res = await request(app)
      .post('/api/elements/sync/v2')
      .send({ lastSyncVersion: 0, changes: [] });

    expect(res.status).toBe(200);
    expect(res.body.serverChanges.length).toBeGreaterThanOrEqual(2);
    const ids = res.body.serverChanges.map((c: any) => c.id);
    expect(ids).toContain('sv1');
    expect(ids).toContain('sv2');
  });

  it('rejects non-number lastSyncVersion', async () => {
    const res = await request(app)
      .post('/api/elements/sync/v2')
      .send({ lastSyncVersion: 'bad', changes: [] });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});

// ─── canvasStatus in mutation responses ─────────────────────

describe('canvasStatus in mutation responses', () => {
  it('POST /api/elements includes syncedToCanvas and canvasStatus', async () => {
    const res = await request(app)
      .post('/api/elements')
      .send({ type: 'rectangle', x: 0, y: 0, width: 100, height: 50 });

    expect(res.status).toBe(200);
    expect(typeof res.body.syncedToCanvas).toBe('boolean');
    expect(res.body.syncedToCanvas).toBe(false);
    expect(res.body.canvasStatus).toBeDefined();
    expect(res.body.canvasStatus).toHaveProperty('connectedBrowsers');
    expect(res.body.canvasStatus).toHaveProperty('ackedBy');
    expect(res.body.canvasStatus).toHaveProperty('reason');
    expect(res.body.canvasStatus).toHaveProperty('scope');
  });

  it('PUT /api/elements/:id includes canvasStatus', async () => {
    setElement('cs-put', makeElement({ id: 'cs-put', x: 0 }));

    const res = await request(app)
      .put('/api/elements/cs-put')
      .send({ x: 100 });

    expect(res.status).toBe(200);
    expect(typeof res.body.syncedToCanvas).toBe('boolean');
    expect(res.body.canvasStatus).toBeDefined();
    expect(res.body.canvasStatus).toHaveProperty('connectedBrowsers');
    expect(res.body.canvasStatus).toHaveProperty('ackedBy');
    expect(res.body.canvasStatus).toHaveProperty('reason');
    expect(res.body.canvasStatus).toHaveProperty('scope');
  });

  it('POST /api/elements/batch includes canvasStatus', async () => {
    const res = await request(app)
      .post('/api/elements/batch')
      .send({
        elements: [
          { type: 'rectangle', x: 0, y: 0, width: 50, height: 50 },
          { type: 'ellipse', x: 100, y: 100, width: 40, height: 40 },
        ],
      });

    expect(res.status).toBe(200);
    expect(typeof res.body.syncedToCanvas).toBe('boolean');
    expect(res.body.canvasStatus).toBeDefined();
    expect(res.body.canvasStatus).toHaveProperty('connectedBrowsers');
    expect(res.body.canvasStatus).toHaveProperty('ackedBy');
    expect(res.body.canvasStatus).toHaveProperty('reason');
    expect(res.body.canvasStatus).toHaveProperty('scope');
  });
});
