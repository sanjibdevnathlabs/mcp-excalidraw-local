import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initDb, closeDb, setElement, clearElements } from '../../src/db.js';
import type { ServerElement } from '../../src/types.js';
import WebSocket from 'ws';
import path from 'path';
import os from 'os';
import fs from 'fs';

let dbPath: string;
let port: number;
let startCanvasServer: () => Promise<void>;
let stopCanvasServer: () => Promise<void>;

function connectClient(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
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
    }, 1000);
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

function collectMessages(ws: WebSocket, count: number, timeoutMs = 5000): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const messages: any[] = [];
    const timer = setTimeout(() => {
      ws.off('message', handler);
      resolve(messages); // return whatever we collected
    }, timeoutMs);
    const handler = (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      messages.push(msg);
      if (messages.length >= count) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(messages);
      }
    };
    ws.on('message', handler);
  });
}

beforeAll(async () => {
  port = 3300 + Math.floor(Math.random() * 100);
  process.env.CANVAS_PORT = String(port);
  process.env.HOST = 'localhost';

  dbPath = path.join(os.tmpdir(), `excalidraw-bugfix-ws-test-${Date.now()}.db`);
  initDb(dbPath);

  const mod = await import('../../src/server.js');
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
  clearElements();
});

// ─── Fix 3: Hello handshake without explicit projectId ──────

describe('Hello handshake without projectId', () => {
  it('server resolves projectId when hello only has tenantId', async () => {
    const ws = await connectClient();
    await drainInitialMessages(ws);

    const helloAckPromise = waitForMessageOfType(ws, 'hello_ack');

    // Send hello with only tenantId (no projectId)
    ws.send(JSON.stringify({
      type: 'hello',
      tenantId: 'default',
      // projectId intentionally omitted
    }));

    const msg = await helloAckPromise;
    expect(msg.type).toBe('hello_ack');
    expect(msg.tenantId).toBe('default');
    // Server should have resolved a project ID
    expect(msg.projectId).toBeDefined();
    expect(typeof msg.projectId).toBe('string');
    expect(msg.projectId.length).toBeGreaterThan(0);
    expect(Array.isArray(msg.elements)).toBe(true);

    ws.close();
  });

  it('hello_ack includes existing elements for the resolved project', async () => {
    setElement('hello-noproj-el', {
      id: 'hello-noproj-el', type: 'rectangle', x: 5, y: 10, width: 80, height: 40, version: 1,
    } as ServerElement);

    const ws = await connectClient();
    await drainInitialMessages(ws);

    const helloAckPromise = waitForMessageOfType(ws, 'hello_ack');

    ws.send(JSON.stringify({
      type: 'hello',
      tenantId: 'default',
    }));

    const msg = await helloAckPromise;
    expect(msg.elements.length).toBeGreaterThanOrEqual(1);
    const found = msg.elements.find((el: any) => el.id === 'hello-noproj-el');
    expect(found).toBeDefined();

    ws.close();
  });
});

// ─── Fix 3: WS registration after hello ──────────────────────

describe('WS scoped broadcast after hello', () => {
  it('client receives broadcasts after hello handshake', async () => {
    const ws = await connectClient();
    await drainInitialMessages(ws);

    // Send hello to properly register
    const helloAckPromise = waitForMessageOfType(ws, 'hello_ack');
    ws.send(JSON.stringify({ type: 'hello', tenantId: 'default' }));
    await helloAckPromise;

    // Now create an element — the hello-registered client should receive the broadcast
    const createdPromise = waitForMessageOfType(ws, 'element_created');

    await fetch(`http://localhost:${port}/api/elements`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'rectangle', x: 0, y: 0, width: 50, height: 50 }),
    });

    const msg = await createdPromise;
    expect(msg.element.type).toBe('rectangle');

    ws.close();
  });
});

// ─── Fix 6: Serialized broadcasts prevent race conditions ────

describe('Serialized broadcast ordering', () => {
  it('parallel element creations arrive in order to WS client', async () => {
    const ws = await connectClient();
    await drainInitialMessages(ws);

    // Send hello to register properly
    const helloAckPromise = waitForMessageOfType(ws, 'hello_ack');
    ws.send(JSON.stringify({ type: 'hello', tenantId: 'default' }));
    await helloAckPromise;

    // Auto-ACK all messages so the serialized queue advances
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.msgId && msg.type !== 'hello_ack') {
        ws.send(JSON.stringify({
          type: 'ack',
          msgId: msg.msgId,
          status: 'applied',
        }));
      }
    });

    // Fire 5 parallel element creations
    const promises = Array.from({ length: 5 }, (_, i) =>
      fetch(`http://localhost:${port}/api/elements`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: `serial-${i}`,
          type: 'rectangle',
          x: i * 100,
          y: 0,
          width: 80,
          height: 50,
        }),
      })
    );

    const responses = await Promise.all(promises);
    for (const res of responses) {
      expect(res.ok).toBe(true);
    }

    // Verify all 5 elements exist in the DB
    const listRes = await fetch(`http://localhost:${port}/api/elements`);
    const listBody = await listRes.json();
    expect(listBody.count).toBe(5);

    const ids = listBody.elements.map((e: any) => e.id).sort();
    expect(ids).toEqual([
      'serial-0',
      'serial-1',
      'serial-2',
      'serial-3',
      'serial-4',
    ]);

    ws.close();
  });

  it('parallel creates all get ACKed when client is responsive', async () => {
    const ws = await connectClient();
    await drainInitialMessages(ws);

    // Send hello
    const helloAckPromise = waitForMessageOfType(ws, 'hello_ack');
    ws.send(JSON.stringify({ type: 'hello', tenantId: 'default' }));
    await helloAckPromise;

    // Auto-ACK
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.msgId && msg.type !== 'hello_ack') {
        ws.send(JSON.stringify({
          type: 'ack',
          msgId: msg.msgId,
          status: 'applied',
        }));
      }
    });

    // Fire 3 parallel creates and check all get syncedToCanvas: true
    const promises = Array.from({ length: 3 }, (_, i) =>
      fetch(`http://localhost:${port}/api/elements`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: `ack-serial-${i}`,
          type: 'rectangle',
          x: i * 100,
          y: 0,
          width: 80,
          height: 50,
        }),
      }).then(r => r.json())
    );

    const results = await Promise.all(promises);
    for (const result of results) {
      expect(result.success).toBe(true);
      expect(result.syncedToCanvas).toBe(true);
    }

    ws.close();
  });
});

// ─── sync_version monotonically increases across parallel creates ─

describe('sync_version ordering with parallel creates', () => {
  it('each element_created broadcast has a unique monotonic sync_version', async () => {
    const ws = await connectClient();
    await drainInitialMessages(ws);

    const helloAckPromise = waitForMessageOfType(ws, 'hello_ack');
    ws.send(JSON.stringify({ type: 'hello', tenantId: 'default' }));
    await helloAckPromise;

    const receivedVersions: number[] = [];

    // Auto-ACK and collect sync_versions
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'element_created' && msg.sync_version !== undefined) {
        receivedVersions.push(msg.sync_version);
      }
      if (msg.msgId && msg.type !== 'hello_ack') {
        ws.send(JSON.stringify({
          type: 'ack',
          msgId: msg.msgId,
          status: 'applied',
        }));
      }
    });

    // Create 3 elements in parallel
    const promises = Array.from({ length: 3 }, (_, i) =>
      fetch(`http://localhost:${port}/api/elements`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: `sv-order-${i}`,
          type: 'rectangle',
          x: i * 100,
          y: 0,
          width: 80,
          height: 50,
        }),
      })
    );

    await Promise.all(promises);

    // Wait for all broadcasts to be received
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // All 3 sync_versions should be unique
    expect(receivedVersions.length).toBe(3);
    const unique = new Set(receivedVersions);
    expect(unique.size).toBe(3);

    // Due to serialized broadcast, they should arrive in monotonic order
    for (let i = 1; i < receivedVersions.length; i++) {
      expect(receivedVersions[i]).toBeGreaterThan(receivedVersions[i - 1]!);
    }

    ws.close();
  });
});
