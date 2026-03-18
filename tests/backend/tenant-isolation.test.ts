import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initDb, closeDb, setElement, getAllElements, setActiveTenant, ensureTenant, setActiveProject, getActiveProjectId, getCurrentSyncVersion, getChangesSince, clearElements } from '../../src/db.js';
import type { ServerElement } from '../../src/types.js';
import WebSocket from 'ws';
import request from 'supertest';
import path from 'path';
import os from 'os';
import fs from 'fs';

let dbPath: string;
let port: number;
let startCanvasServer: () => Promise<void>;
let stopCanvasServer: () => Promise<void>;
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

function connectClient(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function waitForMessageOfType(ws: WebSocket, type: string, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for message type: ${type}`)), timeoutMs);
    const handler = (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === type) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
  });
}

function drainInitialMessages(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    let count = 0;
    const handler = () => {
      count++;
      if (count >= 3) {
        ws.off('message', handler);
        resolve();
      }
    };
    ws.on('message', handler);
    setTimeout(() => {
      ws.off('message', handler);
      resolve();
    }, 2000);
  });
}

/** Connect and wait until initial messages are drained. */
async function connectAndDrain(): Promise<WebSocket> {
  const ws = await connectClient();
  await drainInitialMessages(ws);
  return ws;
}

/** Send hello and wait for hello_ack. */
async function sendHelloAndWait(ws: WebSocket, tenantId: string): Promise<any> {
  const ackPromise = waitForMessageOfType(ws, 'hello_ack', 8000);
  ws.send(JSON.stringify({ type: 'hello', tenantId }));
  return ackPromise;
}

function collectMessagesFor(ws: WebSocket, durationMs: number): Promise<any[]> {
  return new Promise((resolve) => {
    const msgs: any[] = [];
    const handler = (data: WebSocket.RawData) => msgs.push(JSON.parse(data.toString()));
    ws.on('message', handler);
    setTimeout(() => {
      ws.off('message', handler);
      resolve(msgs);
    }, durationMs);
  });
}

beforeAll(async () => {
  port = 3300 + Math.floor(Math.random() * 100);
  process.env.CANVAS_PORT = String(port);
  process.env.HOST = 'localhost';

  dbPath = path.join(os.tmpdir(), `excalidraw-isolation-test-${Date.now()}.db`);
  initDb(dbPath);

  const mod = await import('../../src/server.js');
  app = mod.default;
  startCanvasServer = mod.startCanvasServer;
  stopCanvasServer = mod.stopCanvasServer;
  await startCanvasServer();
});

afterAll(async () => {
  await stopCanvasServer();
  closeDb();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
});

beforeEach(() => {
  setActiveTenant('default');
});

// ─── Element Isolation per Tenant ───────────────────────────

describe('Element isolation per tenant', () => {
  it('elements in tenant A are not visible to tenant B', async () => {
    ensureTenant('tenant-a', 'Tenant A', '/path/a');
    ensureTenant('tenant-b', 'Tenant B', '/path/b');

    // Create element in tenant A
    setActiveTenant('tenant-a');
    const projA = getActiveProjectId();
    setElement('el-a', makeElement({ id: 'el-a' }), projA);

    // Create element in tenant B
    setActiveTenant('tenant-b');
    const projB = getActiveProjectId();
    setElement('el-b', makeElement({ id: 'el-b' }), projB);

    // Verify isolation via API
    const resA = await request(app)
      .get('/api/elements')
      .set('X-Tenant-Id', 'tenant-a');
    expect(resA.body.count).toBe(1);
    expect(resA.body.elements[0].id).toBe('el-a');

    const resB = await request(app)
      .get('/api/elements')
      .set('X-Tenant-Id', 'tenant-b');
    expect(resB.body.count).toBe(1);
    expect(resB.body.elements[0].id).toBe('el-b');
  });

  it('deleting elements in tenant A does not affect tenant B', async () => {
    ensureTenant('del-a', 'Del A', '/path/del-a');
    ensureTenant('del-b', 'Del B', '/path/del-b');

    setActiveTenant('del-a');
    const projA = getActiveProjectId();
    setElement('del-el-a', makeElement({ id: 'del-el-a' }), projA);

    setActiveTenant('del-b');
    const projB = getActiveProjectId();
    setElement('del-el-b', makeElement({ id: 'del-el-b' }), projB);

    // Delete from tenant A via API
    await request(app)
      .delete('/api/elements/del-el-a')
      .set('X-Tenant-Id', 'del-a');

    // Tenant A should be empty
    const resA = await request(app)
      .get('/api/elements')
      .set('X-Tenant-Id', 'del-a');
    expect(resA.body.count).toBe(0);

    // Tenant B should still have its element
    const resB = await request(app)
      .get('/api/elements')
      .set('X-Tenant-Id', 'del-b');
    expect(resB.body.count).toBe(1);
    expect(resB.body.elements[0].id).toBe('del-el-b');
  });

  it('clear in tenant A does not affect tenant B', async () => {
    ensureTenant('clr-a', 'Clr A', '/path/clr-a');
    ensureTenant('clr-b', 'Clr B', '/path/clr-b');

    setActiveTenant('clr-a');
    setElement('clr-el-a', makeElement({ id: 'clr-el-a' }), getActiveProjectId());

    setActiveTenant('clr-b');
    setElement('clr-el-b', makeElement({ id: 'clr-el-b' }), getActiveProjectId());

    // Clear tenant A
    await request(app)
      .delete('/api/elements/clear')
      .set('X-Tenant-Id', 'clr-a');

    const resA = await request(app)
      .get('/api/elements')
      .set('X-Tenant-Id', 'clr-a');
    expect(resA.body.count).toBe(0);

    const resB = await request(app)
      .get('/api/elements')
      .set('X-Tenant-Id', 'clr-b');
    expect(resB.body.count).toBe(1);
  });
});

// ─── Sync Version Isolation per Tenant ──────────────────────

describe('Sync version isolation', () => {
  it('sync versions are independent per tenant/project', async () => {
    ensureTenant('sv-a', 'SV A', '/path/sv-a');
    ensureTenant('sv-b', 'SV B', '/path/sv-b');

    // Create in tenant A
    setActiveTenant('sv-a');
    const projA = getActiveProjectId();
    setElement('sv-el-a', makeElement({ id: 'sv-el-a' }), projA);
    const vA = getCurrentSyncVersion(projA);

    // Create in tenant B
    setActiveTenant('sv-b');
    const projB = getActiveProjectId();
    setElement('sv-el-b', makeElement({ id: 'sv-el-b' }), projB);
    const vB = getCurrentSyncVersion(projB);

    // Both should have version 1 (independent counters)
    expect(vA).toBe(1);
    expect(vB).toBe(1);
  });

  it('delta sync v2 is scoped to the requesting tenant', async () => {
    ensureTenant('ds-a', 'DS A', '/path/ds-a');
    ensureTenant('ds-b', 'DS B', '/path/ds-b');

    // Create in tenant A via API
    await request(app)
      .post('/api/elements')
      .set('X-Tenant-Id', 'ds-a')
      .send({ id: 'ds-el-a', type: 'rectangle', x: 0, y: 0, width: 100, height: 50 });

    // Create in tenant B via API
    await request(app)
      .post('/api/elements')
      .set('X-Tenant-Id', 'ds-b')
      .send({ id: 'ds-el-b', type: 'rectangle', x: 0, y: 0, width: 100, height: 50 });

    // Sync for tenant A from version 0
    const resA = await request(app)
      .post('/api/elements/sync/v2')
      .set('X-Tenant-Id', 'ds-a')
      .send({ lastSyncVersion: 0, changes: [] });

    const idsA = resA.body.serverChanges.map((c: any) => c.id);
    expect(idsA).toContain('ds-el-a');
    expect(idsA).not.toContain('ds-el-b');

    // Sync for tenant B from version 0
    const resB = await request(app)
      .post('/api/elements/sync/v2')
      .set('X-Tenant-Id', 'ds-b')
      .send({ lastSyncVersion: 0, changes: [] });

    const idsB = resB.body.serverChanges.map((c: any) => c.id);
    expect(idsB).toContain('ds-el-b');
    expect(idsB).not.toContain('ds-el-a');
  });
});

// ─── WebSocket Tenant Isolation ─────────────────────────────

describe('WebSocket tenant-scoped broadcasts', () => {
  it('broadcast for tenant A does NOT reach client registered to tenant B', async () => {
    ensureTenant('ws-a', 'WS A', '/path/ws-a');
    ensureTenant('ws-b', 'WS B', '/path/ws-b');

    const wsA = await connectAndDrain();
    const wsB = await connectAndDrain();

    await sendHelloAndWait(wsA, 'ws-a');
    await sendHelloAndWait(wsB, 'ws-b');

    // Start collecting messages on client B
    const bMessages = collectMessagesFor(wsB, 2000);

    // Create element in tenant A scope
    await request(app)
      .post('/api/elements')
      .set('X-Tenant-Id', 'ws-a')
      .send({ id: 'ws-only-a', type: 'rectangle', x: 0, y: 0, width: 100, height: 50 });

    const received = await bMessages;

    // Client B should NOT receive the element_created for tenant A
    const created = received.filter(m => m.type === 'element_created' && m.element?.id === 'ws-only-a');
    expect(created).toHaveLength(0);

    wsA.close();
    wsB.close();
  });

  it('broadcast for tenant A reaches all clients registered to tenant A', async () => {
    ensureTenant('ws-multi', 'WS Multi', '/path/ws-multi');

    const ws1 = await connectAndDrain();
    const ws2 = await connectAndDrain();

    await sendHelloAndWait(ws1, 'ws-multi');
    await sendHelloAndWait(ws2, 'ws-multi');

    const p1 = waitForMessageOfType(ws1, 'element_created');
    const p2 = waitForMessageOfType(ws2, 'element_created');

    await request(app)
      .post('/api/elements')
      .set('X-Tenant-Id', 'ws-multi')
      .send({ id: 'ws-shared', type: 'rectangle', x: 0, y: 0, width: 100, height: 50 });

    const [m1, m2] = await Promise.all([p1, p2]);
    expect(m1.element.id).toBe('ws-shared');
    expect(m2.element.id).toBe('ws-shared');

    ws1.close();
    ws2.close();
  });
});

// ─── Hello Handshake Isolation ──────────────────────────────

describe('Hello handshake returns scoped elements', () => {
  it('hello with tenantId returns only that tenant elements', async () => {
    ensureTenant('hello-a', 'Hello A', '/path/hello-a');
    ensureTenant('hello-b', 'Hello B', '/path/hello-b');

    // Populate both tenants
    await request(app)
      .post('/api/elements')
      .set('X-Tenant-Id', 'hello-a')
      .send({ id: 'ha-el', type: 'rectangle', x: 0, y: 0, width: 100, height: 50 });

    await request(app)
      .post('/api/elements')
      .set('X-Tenant-Id', 'hello-b')
      .send({ id: 'hb-el', type: 'ellipse', x: 0, y: 0, width: 80, height: 80 });

    const ws = await connectAndDrain();
    const ack = await sendHelloAndWait(ws, 'hello-a');

    expect(ack.tenantId).toBe('hello-a');
    expect(ack.elements).toBeDefined();

    const elementIds = ack.elements.map((e: any) => e.id);
    expect(elementIds).toContain('ha-el');
    expect(elementIds).not.toContain('hb-el');

    ws.close();
  });
});

// ─── Tenant Switch via API ──────────────────────────────────

describe('Tenant switch via API', () => {
  it('PUT /api/tenant/active switches context and broadcasts', async () => {
    ensureTenant('switch-to', 'Switch To', '/path/switch-to');

    const ws = await connectAndDrain();
    const switchPromise = waitForMessageOfType(ws, 'tenant_switched', 8000);

    await request(app)
      .put('/api/tenant/active')
      .send({ tenantId: 'switch-to' });

    const msg = await switchPromise;
    expect(msg.tenant).toBeDefined();
    expect(msg.tenant.id).toBe('switch-to');

    ws.close();
  });

  it('GET /api/elements after tenant switch returns new tenant elements', async () => {
    ensureTenant('ctx-old', 'Old', '/path/old');
    ensureTenant('ctx-new', 'New', '/path/new');

    await request(app)
      .post('/api/elements')
      .set('X-Tenant-Id', 'ctx-new')
      .send({ id: 'new-el', type: 'rectangle', x: 0, y: 0, width: 100, height: 50 });

    // Switch to new tenant
    await request(app)
      .put('/api/tenant/active')
      .send({ tenantId: 'ctx-new' });

    // Elements should be from the new tenant
    const res = await request(app).get('/api/elements');
    const ids = res.body.elements.map((e: any) => e.id);
    expect(ids).toContain('new-el');
  });
});
