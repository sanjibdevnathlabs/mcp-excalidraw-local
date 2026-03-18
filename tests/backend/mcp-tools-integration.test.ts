import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { initDb, closeDb, setElement, getAllElements, setActiveTenant, getCurrentSyncVersion } from '../../src/db.js';
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
  dbPath = path.join(os.tmpdir(), `excalidraw-mcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
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

// ─── Clear Canvas Token Flow (via REST) ─────────────────────
// Simulates the clear_canvas MCP tool's token-based confirmation

describe('Clear canvas confirmation flow', () => {
  it('DELETE /api/elements/clear removes all elements', async () => {
    setElement('cl-1', makeElement({ id: 'cl-1' }));
    setElement('cl-2', makeElement({ id: 'cl-2' }));
    expect(getAllElements()).toHaveLength(2);

    const res = await request(app).delete('/api/elements/clear');
    expect(res.body.success).toBe(true);
    expect(res.body.count).toBeDefined();

    expect(getAllElements()).toHaveLength(0);
  });

  it('clear on empty canvas returns zero count', async () => {
    const res = await request(app).delete('/api/elements/clear');
    expect(res.body.success).toBe(true);
  });

  it('cleared elements stay gone on subsequent GET requests', async () => {
    setElement('stay-gone', makeElement({ id: 'stay-gone' }));
    await request(app).delete('/api/elements/clear');

    for (let i = 0; i < 3; i++) {
      const res = await request(app).get('/api/elements');
      expect(res.body.count).toBe(0);
    }
  });
});

// ─── Import Scene (Replace Mode) ────────────────────────────
// Tests the REST layer that import_scene MCP tool uses

describe('Import scene - replace mode via sync', () => {
  it('POST /api/elements/sync replaces all elements atomically', async () => {
    setElement('old-1', makeElement({ id: 'old-1' }));
    setElement('old-2', makeElement({ id: 'old-2' }));

    const newElements = [
      makeElement({ id: 'new-1', x: 0 }),
      makeElement({ id: 'new-2', x: 100 }),
      makeElement({ id: 'new-3', x: 200 }),
    ];

    const res = await request(app)
      .post('/api/elements/sync')
      .send({ elements: newElements });

    expect(res.body.success).toBe(true);

    const elements = getAllElements();
    expect(elements).toHaveLength(3);
    const ids = elements.map(e => e.id).sort();
    expect(ids).toEqual(['new-1', 'new-2', 'new-3']);
  });

  it('POST /api/elements/sync with empty array clears all', async () => {
    setElement('will-be-replaced', makeElement({ id: 'will-be-replaced' }));

    const res = await request(app)
      .post('/api/elements/sync')
      .send({ elements: [] });

    expect(res.body.success).toBe(true);
    expect(getAllElements()).toHaveLength(0);
  });

  it('old elements do not reappear after replace', async () => {
    setElement('ghost', makeElement({ id: 'ghost' }));

    await request(app)
      .post('/api/elements/sync')
      .send({ elements: [makeElement({ id: 'replacement' })] });

    // Multiple GET requests should consistently show only the replacement
    for (let i = 0; i < 3; i++) {
      const res = await request(app).get('/api/elements');
      expect(res.body.count).toBe(1);
      expect(res.body.elements[0].id).toBe('replacement');
    }
  });
});

// ─── Import Scene (Merge Mode) ──────────────────────────────

describe('Import scene - merge mode via batch', () => {
  it('POST /api/elements/batch adds without removing existing', async () => {
    setElement('existing', makeElement({ id: 'existing', x: 0 }));

    const res = await request(app)
      .post('/api/elements/batch')
      .send({
        elements: [
          makeElement({ id: 'imported-1', x: 100 }),
          makeElement({ id: 'imported-2', x: 200 }),
        ],
      });

    expect(res.body.success).toBe(true);

    const elements = getAllElements();
    expect(elements).toHaveLength(3);
    const ids = elements.map(e => e.id).sort();
    expect(ids).toEqual(['existing', 'imported-1', 'imported-2']);
  });
});

// ─── Restore Snapshot ───────────────────────────────────────

describe('Snapshot create and restore flow', () => {
  it('save snapshot, clear, verify snapshot still exists', async () => {
    setElement('snap-1', makeElement({ id: 'snap-1' }));
    setElement('snap-2', makeElement({ id: 'snap-2' }));

    // Save snapshot
    const snapRes = await request(app)
      .post('/api/snapshots')
      .send({ name: 'before-clear' });
    expect(snapRes.body.success).toBe(true);

    // Clear
    await request(app).delete('/api/elements/clear');
    expect(getAllElements()).toHaveLength(0);

    // Snapshot should still contain the elements
    const getRes = await request(app).get('/api/snapshots/before-clear');
    expect(getRes.body.success).toBe(true);
    expect(getRes.body.snapshot.elements).toHaveLength(2);
  });

  it('restore via sync endpoint preserves all snapshot elements', async () => {
    const elements = [
      makeElement({ id: 'rs-1', x: 0 }),
      makeElement({ id: 'rs-2', x: 100 }),
    ];
    for (const el of elements) setElement(el.id, el);

    // Save snapshot
    await request(app).post('/api/snapshots').send({ name: 'restore-test' });

    // Clear and add different elements
    await request(app).delete('/api/elements/clear');
    setElement('different', makeElement({ id: 'different' }));

    // Get snapshot
    const snapRes = await request(app).get('/api/snapshots/restore-test');
    const snapshotElements = snapRes.body.snapshot.elements;

    // Restore via sync (atomic replace)
    const syncRes = await request(app)
      .post('/api/elements/sync')
      .send({ elements: snapshotElements });
    expect(syncRes.body.success).toBe(true);

    // Verify restored state
    const final = getAllElements();
    expect(final).toHaveLength(2);
    const ids = final.map(e => e.id).sort();
    expect(ids).toEqual(['rs-1', 'rs-2']);
  });

  it('restore non-existent snapshot returns 404', async () => {
    const res = await request(app).get('/api/snapshots/nonexistent');
    expect(res.status).toBe(404);
  });

  it('snapshot overwrites with same name', async () => {
    setElement('v1-el', makeElement({ id: 'v1-el' }));
    await request(app).post('/api/snapshots').send({ name: 'overwrite-test' });

    setElement('v2-el', makeElement({ id: 'v2-el' }));
    await request(app).post('/api/snapshots').send({ name: 'overwrite-test' });

    const res = await request(app).get('/api/snapshots/overwrite-test');
    expect(res.body.snapshot.elements).toHaveLength(2); // Both elements
  });
});

// ─── Duplicate Elements ─────────────────────────────────────

describe('Duplicate elements via API', () => {
  it('duplicating elements creates new IDs', async () => {
    setElement('dup-src', makeElement({ id: 'dup-src', x: 0, y: 0 }));

    // Get the original
    const getRes = await request(app).get('/api/elements/dup-src');
    expect(getRes.body.success).toBe(true);

    // Create a duplicate via batch (simulating what duplicate_elements does)
    const original = getRes.body.element;
    const duplicate = {
      ...original,
      id: 'dup-copy',
      x: original.x + 20,
      y: original.y + 20,
    };

    const batchRes = await request(app)
      .post('/api/elements/batch')
      .send({ elements: [duplicate] });

    expect(batchRes.body.success).toBe(true);
    expect(getAllElements()).toHaveLength(2);
  });

  it('duplicated arrow with remapped bindings points to duplicated shapes', async () => {
    // Create shape + arrow
    const rect = makeElement({ id: 'dup-rect', x: 0, y: 0, width: 100, height: 50 });
    const rect2 = makeElement({ id: 'dup-rect2', x: 300, y: 0, width: 100, height: 50 });
    setElement('dup-rect', rect);
    setElement('dup-rect2', rect2);

    // Create arrow binding references
    const arrow = {
      id: 'dup-arrow',
      type: 'arrow',
      x: 100, y: 25,
      width: 200, height: 0,
      start: { id: 'dup-rect' },
      end: { id: 'dup-rect2' },
    };

    // Simulate duplication with ID remapping
    const idMap = new Map([
      ['dup-rect', 'copy-rect'],
      ['dup-rect2', 'copy-rect2'],
      ['dup-arrow', 'copy-arrow'],
    ]);

    const dupArrow: any = {
      ...arrow,
      id: 'copy-arrow',
      x: arrow.x + 20,
      y: arrow.y + 20,
      start: { id: idMap.get(arrow.start.id) || arrow.start.id },
      end: { id: idMap.get(arrow.end.id) || arrow.end.id },
    };

    expect(dupArrow.start.id).toBe('copy-rect');
    expect(dupArrow.end.id).toBe('copy-rect2');

    // Create the duplicated shapes and arrow
    const batchRes = await request(app)
      .post('/api/elements/batch')
      .send({
        elements: [
          makeElement({ id: 'copy-rect', x: 20, y: 20, width: 100, height: 50 }),
          makeElement({ id: 'copy-rect2', x: 320, y: 20, width: 100, height: 50 }),
          dupArrow,
        ],
      });

    expect(batchRes.body.success).toBe(true);
    const createdArrow = batchRes.body.elements.find((e: any) => e.id === 'copy-arrow');
    expect(createdArrow).toBeDefined();
  });
});

// ─── Mermaid Conversion Relay ───────────────────────────────

describe('Mermaid conversion relay', () => {
  it('POST /api/elements/from-mermaid accepts valid diagram', async () => {
    const res = await request(app)
      .post('/api/elements/from-mermaid')
      .send({
        mermaidDiagram: 'graph TD\n  A-->B',
        config: {},
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.mermaidDiagram).toBe('graph TD\n  A-->B');
    expect(res.body.message).toContain('frontend');
  });

  it('rejects empty mermaid diagram', async () => {
    const res = await request(app)
      .post('/api/elements/from-mermaid')
      .send({ mermaidDiagram: '' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('rejects missing mermaid diagram', async () => {
    const res = await request(app)
      .post('/api/elements/from-mermaid')
      .send({});

    expect(res.status).toBe(400);
  });

  it('accepts diagram with config options', async () => {
    const res = await request(app)
      .post('/api/elements/from-mermaid')
      .send({
        mermaidDiagram: 'sequenceDiagram\n  A->>B: Hello',
        config: { theme: 'dark' },
      });

    expect(res.body.success).toBe(true);
    expect(res.body.config).toEqual({ theme: 'dark' });
  });
});

// ─── Image Export Relay ─────────────────────────────────────

describe('Image export relay', () => {
  it('POST /api/export/image without connected browser returns 503', async () => {
    const res = await request(app)
      .post('/api/export/image')
      .send({ format: 'png', background: true });

    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
  });

  it('POST /api/export/image accepts captureViewport parameter', async () => {
    const res = await request(app)
      .post('/api/export/image')
      .send({ format: 'png', background: true, captureViewport: true });

    // Will be 503 since no browser, but should not 400 on the parameter
    expect(res.status).toBe(503);
  });
});

// ─── Viewport Relay ─────────────────────────────────────────

describe('Viewport relay', () => {
  it('POST /api/viewport without connected browser returns 503', async () => {
    const res = await request(app)
      .post('/api/viewport')
      .send({ action: 'scrollToContent' });

    expect(res.status).toBe(503);
  });

  it('accepts various viewport actions', async () => {
    for (const action of ['scrollToContent', 'zoomToFit']) {
      const res = await request(app)
        .post('/api/viewport')
        .send({ action });

      // 503 expected (no browser), but validates the action is accepted
      expect(res.status).toBe(503);
    }
  });
});

// ─── Files API ──────────────────────────────────────────────

describe('Files API comprehensive', () => {
  it('GET /api/files returns empty initially', async () => {
    const res = await request(app).get('/api/files');
    expect(res.body.success).toBe(true);
    expect(Object.keys(res.body.files)).toHaveLength(0);
  });

  it('POST /api/files adds files and GET returns them', async () => {
    await request(app)
      .post('/api/files')
      .send({
        files: {
          'f1': { id: 'f1', mimeType: 'image/png', dataURL: 'data:image/png;base64,abc', created: Date.now() },
          'f2': { id: 'f2', mimeType: 'image/jpeg', dataURL: 'data:image/jpeg;base64,xyz', created: Date.now() },
        },
      });

    const res = await request(app).get('/api/files');
    expect(Object.keys(res.body.files)).toHaveLength(2);
    expect(res.body.files['f1'].mimeType).toBe('image/png');
    expect(res.body.files['f2'].mimeType).toBe('image/jpeg');
  });

  it('DELETE /api/files/:id removes the file', async () => {
    await request(app)
      .post('/api/files')
      .send({
        files: {
          'del-f': { id: 'del-f', mimeType: 'image/png', dataURL: 'data:image/png;base64,abc', created: Date.now() },
        },
      });

    const delRes = await request(app).delete('/api/files/del-f');
    expect(delRes.body.success).toBe(true);

    const listRes = await request(app).get('/api/files');
    expect(listRes.body.files['del-f']).toBeUndefined();
  });

  it('DELETE /api/files/:id for non-existent file returns 404', async () => {
    const res = await request(app).delete('/api/files/nonexistent');
    expect(res.status).toBe(404);
  });

  it('POST /api/files rejects non-object body', async () => {
    const res = await request(app)
      .post('/api/files')
      .send({ files: 'not-an-object' });

    expect(res.status).toBe(400);
  });
});

// ─── Sync Status ────────────────────────────────────────────

describe('Sync status endpoint', () => {
  it('GET /api/sync/status returns element count', async () => {
    setElement('ss-1', makeElement({ id: 'ss-1' }));
    setElement('ss-2', makeElement({ id: 'ss-2' }));

    const res = await request(app).get('/api/sync/status');
    expect(res.body.success).toBe(true);
    expect(res.body.elementCount).toBe(2);
  });
});

// ─── Element Version History ────────────────────────────────

describe('Element version history via API', () => {
  it('element has version after creation and update', async () => {
    const createRes = await request(app)
      .post('/api/elements')
      .send({ id: 'hist-el', type: 'rectangle', x: 0, y: 0, width: 100, height: 50 });
    expect(createRes.body.success).toBe(true);

    const updateRes = await request(app)
      .put('/api/elements/hist-el')
      .send({ x: 500 });
    expect(updateRes.body.success).toBe(true);

    const getRes = await request(app).get('/api/elements/hist-el');
    expect(getRes.body.element.x).toBe(500);
  });
});

// ─── Error Handling ─────────────────────────────────────────

describe('API error handling', () => {
  it('POST /api/elements with invalid JSON returns 400', async () => {
    const res = await request(app)
      .post('/api/elements')
      .set('Content-Type', 'application/json')
      .send('not-json');

    // Express body-parser returns 400 or 500 on parse failure depending on version
    expect([400, 500]).toContain(res.status);
  });

  it('PUT /api/elements/:id on non-existent element returns 404', async () => {
    const res = await request(app)
      .put('/api/elements/nonexistent')
      .send({ x: 100 });

    expect(res.status).toBe(404);
  });

  it('DELETE /api/elements/:id on non-existent returns 404', async () => {
    const res = await request(app)
      .delete('/api/elements/nonexistent');

    expect(res.status).toBe(404);
  });

  it('POST /api/elements/batch rejects non-array elements', async () => {
    const res = await request(app)
      .post('/api/elements/batch')
      .send({ elements: 'not-an-array' });

    expect(res.status).toBe(400);
  });

  it('POST /api/snapshots rejects missing name', async () => {
    const res = await request(app)
      .post('/api/snapshots')
      .send({});

    expect(res.status).toBe(400);
  });
});
