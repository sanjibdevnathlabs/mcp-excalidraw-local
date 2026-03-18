import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { initDb, closeDb, setElement, getAllElements, deleteElement, clearElements, getCurrentSyncVersion, getChangesSince, setActiveTenant } from '../../src/db.js';
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
  dbPath = path.join(os.tmpdir(), `excalidraw-sync-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
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

// ─── Delta Sync v2: Deletion Flows ──────────────────────────

describe('Delta sync v2 - deletion flows', () => {
  it('deletes elements when client sends action:delete', async () => {
    setElement('a', makeElement({ id: 'a' }));
    setElement('b', makeElement({ id: 'b' }));
    setElement('c', makeElement({ id: 'c' }));

    const v0 = getCurrentSyncVersion();

    const res = await request(app)
      .post('/api/elements/sync/v2')
      .send({
        lastSyncVersion: v0,
        changes: [
          { id: 'a', action: 'delete' },
          { id: 'b', action: 'delete' },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.appliedCount).toBe(2);

    const remaining = getAllElements();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe('c');
  });

  it('deletes all elements when client sends delete for every element', async () => {
    setElement('x', makeElement({ id: 'x' }));
    setElement('y', makeElement({ id: 'y' }));
    setElement('z', makeElement({ id: 'z' }));

    const v0 = getCurrentSyncVersion();

    const res = await request(app)
      .post('/api/elements/sync/v2')
      .send({
        lastSyncVersion: v0,
        changes: [
          { id: 'x', action: 'delete' },
          { id: 'y', action: 'delete' },
          { id: 'z', action: 'delete' },
        ],
      });

    expect(res.body.appliedCount).toBe(3);
    expect(getAllElements()).toHaveLength(0);
  });

  it('delete for non-existent element does not crash', async () => {
    const res = await request(app)
      .post('/api/elements/sync/v2')
      .send({
        lastSyncVersion: 0,
        changes: [{ id: 'ghost', action: 'delete' }],
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('deleted elements do not reappear on subsequent GET /api/elements', async () => {
    setElement('persist-1', makeElement({ id: 'persist-1' }));
    setElement('persist-2', makeElement({ id: 'persist-2' }));

    const v0 = getCurrentSyncVersion();

    await request(app)
      .post('/api/elements/sync/v2')
      .send({
        lastSyncVersion: v0,
        changes: [{ id: 'persist-1', action: 'delete' }],
      });

    const res = await request(app).get('/api/elements');
    expect(res.body.count).toBe(1);
    expect(res.body.elements[0].id).toBe('persist-2');
  });

  it('deleted elements do not reappear after multiple reload cycles', async () => {
    setElement('reload-1', makeElement({ id: 'reload-1' }));
    setElement('reload-2', makeElement({ id: 'reload-2' }));

    const v0 = getCurrentSyncVersion();

    // Simulate: frontend syncs deletions
    await request(app)
      .post('/api/elements/sync/v2')
      .send({
        lastSyncVersion: v0,
        changes: [
          { id: 'reload-1', action: 'delete' },
          { id: 'reload-2', action: 'delete' },
        ],
      });

    // Simulate: multiple page reloads fetching elements
    for (let i = 0; i < 3; i++) {
      const res = await request(app).get('/api/elements');
      expect(res.body.count).toBe(0);
      expect(res.body.elements).toEqual([]);
    }
  });
});

// ─── Delta Sync v2: Mixed Operations ────────────────────────

describe('Delta sync v2 - mixed operations', () => {
  it('handles mixed upserts and deletes in single sync', async () => {
    setElement('a', makeElement({ id: 'a', x: 0 }));
    setElement('b', makeElement({ id: 'b', x: 100 }));

    const v0 = getCurrentSyncVersion();

    const res = await request(app)
      .post('/api/elements/sync/v2')
      .send({
        lastSyncVersion: v0,
        changes: [
          { id: 'a', action: 'delete' },
          { id: 'c', action: 'upsert', element: makeElement({ id: 'c', x: 200 }) },
          { id: 'b', action: 'upsert', element: makeElement({ id: 'b', x: 150 }) },
        ],
      });

    expect(res.body.appliedCount).toBe(3);

    const remaining = getAllElements();
    expect(remaining).toHaveLength(2);
    const ids = remaining.map(e => e.id).sort();
    expect(ids).toEqual(['b', 'c']);

    const b = remaining.find(e => e.id === 'b')!;
    expect(b.x).toBe(150);
  });

  it('upsert after delete re-creates the element', async () => {
    setElement('revive', makeElement({ id: 'revive', x: 0 }));

    const v0 = getCurrentSyncVersion();

    // Delete it
    await request(app)
      .post('/api/elements/sync/v2')
      .send({
        lastSyncVersion: v0,
        changes: [{ id: 'revive', action: 'delete' }],
      });

    expect(getAllElements()).toHaveLength(0);

    // Re-create it
    const v1 = getCurrentSyncVersion();
    await request(app)
      .post('/api/elements/sync/v2')
      .send({
        lastSyncVersion: v1,
        changes: [{ id: 'revive', action: 'upsert', element: makeElement({ id: 'revive', x: 999 }) }],
      });

    const elements = getAllElements();
    expect(elements).toHaveLength(1);
    expect(elements[0].id).toBe('revive');
    expect(elements[0].x).toBe(999);
  });
});

// ─── Delta Sync v2: Bidirectional ───────────────────────────

describe('Delta sync v2 - bidirectional sync', () => {
  it('returns server-side changes not sent by client', async () => {
    // Server has elements from MCP
    setElement('mcp-1', makeElement({ id: 'mcp-1' }));
    setElement('mcp-2', makeElement({ id: 'mcp-2' }));

    // Client syncs from version 0 with its own new element
    const res = await request(app)
      .post('/api/elements/sync/v2')
      .send({
        lastSyncVersion: 0,
        changes: [
          { id: 'fe-1', action: 'upsert', element: makeElement({ id: 'fe-1' }) },
        ],
      });

    expect(res.body.success).toBe(true);
    // Server should return mcp-1 and mcp-2 as changes the client hasn't seen
    const serverChangeIds = res.body.serverChanges.map((c: any) => c.id).sort();
    expect(serverChangeIds).toEqual(['mcp-1', 'mcp-2']);
    // fe-1 should NOT be in serverChanges (client already knows about it)
    expect(serverChangeIds).not.toContain('fe-1');
  });

  it('server-side deletes appear as delete actions in serverChanges', async () => {
    setElement('srv-del', makeElement({ id: 'srv-del' }));
    const v0 = getCurrentSyncVersion();

    // Server-side delete (simulating MCP delete_element)
    deleteElement('srv-del');
    const v1 = getCurrentSyncVersion();

    // Client syncs from before the delete
    const res = await request(app)
      .post('/api/elements/sync/v2')
      .send({ lastSyncVersion: v0, changes: [] });

    const deleteChange = res.body.serverChanges.find((c: any) => c.id === 'srv-del');
    expect(deleteChange).toBeDefined();
    expect(deleteChange.action).toBe('delete');
  });

  it('excludes client-sent IDs from serverChanges', async () => {
    setElement('shared', makeElement({ id: 'shared', x: 0 }));

    const res = await request(app)
      .post('/api/elements/sync/v2')
      .send({
        lastSyncVersion: 0,
        changes: [
          { id: 'shared', action: 'upsert', element: makeElement({ id: 'shared', x: 50 }) },
        ],
      });

    // 'shared' should NOT appear in serverChanges since the client sent it
    const serverIds = res.body.serverChanges.map((c: any) => c.id);
    expect(serverIds).not.toContain('shared');
  });
});

// ─── Delta Sync v2: Multiple Rounds ─────────────────────────

describe('Delta sync v2 - multiple rounds', () => {
  it('tracks sync version across multiple sync rounds', async () => {
    // Round 1: create elements
    const r1 = await request(app)
      .post('/api/elements/sync/v2')
      .send({
        lastSyncVersion: 0,
        changes: [
          { id: 'r1-a', action: 'upsert', element: makeElement({ id: 'r1-a' }) },
          { id: 'r1-b', action: 'upsert', element: makeElement({ id: 'r1-b' }) },
        ],
      });

    expect(r1.body.currentSyncVersion).toBeGreaterThan(0);
    const v1 = r1.body.currentSyncVersion;

    // Round 2: update one, delete one, create one
    const r2 = await request(app)
      .post('/api/elements/sync/v2')
      .send({
        lastSyncVersion: v1,
        changes: [
          { id: 'r1-a', action: 'upsert', element: makeElement({ id: 'r1-a', x: 999 }) },
          { id: 'r1-b', action: 'delete' },
          { id: 'r2-c', action: 'upsert', element: makeElement({ id: 'r2-c' }) },
        ],
      });

    expect(r2.body.currentSyncVersion).toBeGreaterThan(v1);
    expect(r2.body.appliedCount).toBe(3);
    // No new server-side changes should be returned
    expect(r2.body.serverChanges).toHaveLength(0);

    // Verify final state
    const elements = getAllElements();
    expect(elements).toHaveLength(2);
    const ids = elements.map(e => e.id).sort();
    expect(ids).toEqual(['r1-a', 'r2-c']);
    expect(elements.find(e => e.id === 'r1-a')!.x).toBe(999);
  });

  it('empty sync returns current version without changes', async () => {
    setElement('existing', makeElement({ id: 'existing' }));
    const v0 = getCurrentSyncVersion();

    const res = await request(app)
      .post('/api/elements/sync/v2')
      .send({ lastSyncVersion: v0, changes: [] });

    expect(res.body.success).toBe(true);
    expect(res.body.appliedCount).toBe(0);
    expect(res.body.serverChanges).toHaveLength(0);
    expect(res.body.currentSyncVersion).toBe(v0);
  });
});

// ─── Sync Version Monotonicity ──────────────────────────────

describe('Sync version monotonicity', () => {
  it('sync version always increases after mutations', async () => {
    const versions: number[] = [];

    // Create
    setElement('mono-a', makeElement({ id: 'mono-a' }));
    versions.push(getCurrentSyncVersion());

    // Update via sync
    await request(app)
      .post('/api/elements/sync/v2')
      .send({
        lastSyncVersion: 0,
        changes: [{ id: 'mono-a', action: 'upsert', element: makeElement({ id: 'mono-a', x: 50 }) }],
      });
    versions.push(getCurrentSyncVersion());

    // Delete via sync
    await request(app)
      .post('/api/elements/sync/v2')
      .send({
        lastSyncVersion: versions[versions.length - 1],
        changes: [{ id: 'mono-a', action: 'delete' }],
      });
    versions.push(getCurrentSyncVersion());

    // Create via API
    await request(app)
      .post('/api/elements')
      .send({ type: 'rectangle', x: 0, y: 0, width: 100, height: 50 });
    versions.push(getCurrentSyncVersion());

    // Every version should be strictly greater than the previous
    for (let i = 1; i < versions.length; i++) {
      expect(versions[i]).toBeGreaterThan(versions[i - 1]!);
    }
  });

  it('getChangesSince correctly filters by version', async () => {
    setElement('cs-a', makeElement({ id: 'cs-a' }));
    const v1 = getCurrentSyncVersion();

    setElement('cs-b', makeElement({ id: 'cs-b' }));
    const v2 = getCurrentSyncVersion();

    setElement('cs-c', makeElement({ id: 'cs-c' }));
    const v3 = getCurrentSyncVersion();

    // Changes since v1 should include cs-b and cs-c but not cs-a
    const changes = getChangesSince(v1);
    const ids = changes.map(c => c.id).sort();
    expect(ids).toEqual(['cs-b', 'cs-c']);

    // Changes since v2 should only include cs-c
    const changes2 = getChangesSince(v2);
    expect(changes2).toHaveLength(1);
    expect(changes2[0].id).toBe('cs-c');

    // Changes since v3 should be empty
    expect(getChangesSince(v3)).toHaveLength(0);
  });
});

// ─── Concurrent Sync Requests ───────────────────────────────

describe('Concurrent sync requests', () => {
  it('parallel sync requests all complete without data loss', async () => {
    const promises = Array.from({ length: 5 }, (_, i) =>
      request(app)
        .post('/api/elements/sync/v2')
        .send({
          lastSyncVersion: 0,
          changes: [
            { id: `par-${i}`, action: 'upsert', element: makeElement({ id: `par-${i}`, x: i * 100 }) },
          ],
        })
    );

    const results = await Promise.all(promises);
    for (const r of results) {
      expect(r.body.success).toBe(true);
      expect(r.body.appliedCount).toBe(1);
    }

    const elements = getAllElements();
    expect(elements).toHaveLength(5);
  });

  it('parallel deletes all take effect', async () => {
    for (let i = 0; i < 5; i++) {
      setElement(`pd-${i}`, makeElement({ id: `pd-${i}` }));
    }
    const v0 = getCurrentSyncVersion();

    const promises = Array.from({ length: 5 }, (_, i) =>
      request(app)
        .post('/api/elements/sync/v2')
        .send({
          lastSyncVersion: v0,
          changes: [{ id: `pd-${i}`, action: 'delete' }],
        })
    );

    await Promise.all(promises);
    expect(getAllElements()).toHaveLength(0);
  });
});

// ─── Sync After Clear ───────────────────────────────────────

describe('Sync after clear', () => {
  it('elements created after clear persist correctly', async () => {
    setElement('pre-clear', makeElement({ id: 'pre-clear' }));

    await request(app).delete('/api/elements/clear');
    expect(getAllElements()).toHaveLength(0);

    const v0 = getCurrentSyncVersion();

    const res = await request(app)
      .post('/api/elements/sync/v2')
      .send({
        lastSyncVersion: v0,
        changes: [
          { id: 'post-clear', action: 'upsert', element: makeElement({ id: 'post-clear' }) },
        ],
      });

    expect(res.body.appliedCount).toBe(1);
    expect(getAllElements()).toHaveLength(1);
    expect(getAllElements()[0].id).toBe('post-clear');
  });

  it('sync from version 0 after clear returns clear as delete changes', async () => {
    setElement('was-here', makeElement({ id: 'was-here' }));
    clearElements();

    // Sync from 0 should see the element as a delete
    const changes = getChangesSince(0);
    const deleteChange = changes.find(c => c.id === 'was-here');
    expect(deleteChange).toBeDefined();
    expect(deleteChange!.action).toBe('delete');
  });
});

// ─── Overwrite Sync (Legacy) ────────────────────────────────

describe('POST /api/elements/sync (legacy overwrite)', () => {
  it('replaces all elements and deleted ones stay gone on GET', async () => {
    setElement('old-1', makeElement({ id: 'old-1' }));
    setElement('old-2', makeElement({ id: 'old-2' }));

    const res = await request(app)
      .post('/api/elements/sync')
      .send({
        elements: [makeElement({ id: 'new-1' })],
      });

    expect(res.body.success).toBe(true);

    const elements = getAllElements();
    expect(elements).toHaveLength(1);
    expect(elements[0].id).toBe('new-1');

    // Old elements should not be returned
    const listRes = await request(app).get('/api/elements');
    expect(listRes.body.count).toBe(1);
    expect(listRes.body.elements[0].id).toBe('new-1');
  });

  it('overwrite with empty array clears all elements', async () => {
    setElement('gone', makeElement({ id: 'gone' }));

    await request(app)
      .post('/api/elements/sync')
      .send({ elements: [] });

    expect(getAllElements()).toHaveLength(0);

    const res = await request(app).get('/api/elements');
    expect(res.body.count).toBe(0);
  });
});

// ─── GET /api/sync/version consistency ──────────────────────

describe('GET /api/sync/version', () => {
  it('matches internal getCurrentSyncVersion', async () => {
    setElement('sv-check', makeElement({ id: 'sv-check' }));
    const internal = getCurrentSyncVersion();

    const res = await request(app).get('/api/sync/version');
    expect(res.body.syncVersion).toBe(internal);
  });

  it('increases after sync/v2 applies changes', async () => {
    const r1 = await request(app).get('/api/sync/version');
    const v1 = r1.body.syncVersion;

    await request(app)
      .post('/api/elements/sync/v2')
      .send({
        lastSyncVersion: 0,
        changes: [{ id: 'bump', action: 'upsert', element: makeElement({ id: 'bump' }) }],
      });

    const r2 = await request(app).get('/api/sync/version');
    expect(r2.body.syncVersion).toBeGreaterThan(v1);
  });
});
