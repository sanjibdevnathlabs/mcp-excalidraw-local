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

/**
 * Connect a WS client and immediately start buffering all messages.
 * Returns the ws handle + a collected messages array.
 */
function connectAndCollect(): Promise<{ ws: WebSocket; messages: any[] }> {
  return new Promise((resolve, reject) => {
    const messages: any[] = [];
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
    ws.on('open', () => {
      // Give the server a moment to push initial messages
      setTimeout(() => resolve({ ws, messages }), 300);
    });
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

beforeAll(async () => {
  port = 3200 + Math.floor(Math.random() * 100);
  process.env.CANVAS_PORT = String(port);
  process.env.HOST = 'localhost';

  dbPath = path.join(os.tmpdir(), `excalidraw-ws-test-${Date.now()}.db`);
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

describe('WebSocket connection', () => {
  it('connects and receives tenant_switched, initial_elements, sync_status', async () => {
    const { ws, messages } = await connectAndCollect();

    const types = messages.map(m => m.type);
    expect(types).toContain('tenant_switched');
    expect(types).toContain('initial_elements');
    expect(types).toContain('sync_status');

    const initMsg = messages.find(m => m.type === 'initial_elements');
    expect(Array.isArray(initMsg.elements)).toBe(true);

    const syncMsg = messages.find(m => m.type === 'sync_status');
    expect(syncMsg).toHaveProperty('elementCount');

    ws.close();
  });

  it('receives initial_elements with existing data', async () => {
    setElement('init-el', {
      id: 'init-el', type: 'rectangle', x: 10, y: 20, width: 100, height: 50, version: 1,
    } as ServerElement);

    const { ws, messages } = await connectAndCollect();

    const initMsg = messages.find(m => m.type === 'initial_elements');
    expect(initMsg).toBeDefined();
    expect(initMsg.elements.length).toBe(1);
    expect(initMsg.elements[0].id).toBe('init-el');

    ws.close();
  });
});

describe('WebSocket broadcasts', () => {
  it('broadcasts element_created on POST /api/elements', async () => {
    const ws = await connectClient();
    await drainInitialMessages(ws);

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

  it('broadcasts element_deleted on DELETE /api/elements/:id', async () => {
    setElement('del-ws', {
      id: 'del-ws', type: 'ellipse', x: 0, y: 0, width: 30, height: 30, version: 1,
    } as ServerElement);

    const ws = await connectClient();
    await drainInitialMessages(ws);

    const deletedPromise = waitForMessageOfType(ws, 'element_deleted');

    await fetch(`http://localhost:${port}/api/elements/del-ws`, { method: 'DELETE' });

    const msg = await deletedPromise;
    expect(msg.elementId).toBe('del-ws');

    ws.close();
  });

  it('broadcasts element_updated on PUT /api/elements/:id', async () => {
    setElement('upd-ws', {
      id: 'upd-ws', type: 'rectangle', x: 0, y: 0, width: 50, height: 50, version: 1,
    } as ServerElement);

    const ws = await connectClient();
    await drainInitialMessages(ws);

    const updatedPromise = waitForMessageOfType(ws, 'element_updated');

    await fetch(`http://localhost:${port}/api/elements/upd-ws`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ x: 999 }),
    });

    const msg = await updatedPromise;
    expect(msg.element.x).toBe(999);

    ws.close();
  });

  it('broadcasts canvas_cleared on DELETE /api/elements/clear', async () => {
    setElement('clr1', {
      id: 'clr1', type: 'rectangle', x: 0, y: 0, width: 10, height: 10, version: 1,
    } as ServerElement);

    const ws = await connectClient();
    await drainInitialMessages(ws);

    const clearedPromise = waitForMessageOfType(ws, 'canvas_cleared');

    await fetch(`http://localhost:${port}/api/elements/clear`, { method: 'DELETE' });

    const msg = await clearedPromise;
    expect(msg.type).toBe('canvas_cleared');
    expect(msg).toHaveProperty('timestamp');

    ws.close();
  });

  it('broadcasts elements_batch_created on POST /api/elements/batch', async () => {
    const ws = await connectClient();
    await drainInitialMessages(ws);

    const batchPromise = waitForMessageOfType(ws, 'elements_batch_created');

    await fetch(`http://localhost:${port}/api/elements/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        elements: [
          { type: 'rectangle', x: 0, y: 0, width: 50, height: 50 },
          { type: 'ellipse', x: 100, y: 100, width: 40, height: 40 },
        ],
      }),
    });

    const msg = await batchPromise;
    expect(msg.elements.length).toBe(2);

    ws.close();
  });

  it('broadcasts to multiple connected clients', async () => {
    const ws1 = await connectClient();
    const ws2 = await connectClient();
    await drainInitialMessages(ws1);
    await drainInitialMessages(ws2);

    const promise1 = waitForMessageOfType(ws1, 'element_created');
    const promise2 = waitForMessageOfType(ws2, 'element_created');

    await fetch(`http://localhost:${port}/api/elements`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'diamond', x: 0, y: 0, width: 60, height: 60 }),
    });

    const [msg1, msg2] = await Promise.all([promise1, promise2]);
    expect(msg1.element.type).toBe('diamond');
    expect(msg2.element.type).toBe('diamond');

    ws1.close();
    ws2.close();
  });
});
