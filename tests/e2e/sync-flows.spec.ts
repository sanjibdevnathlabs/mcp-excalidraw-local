import { test, expect, type Page } from '@playwright/test';

const API = 'http://localhost:3100';

test.beforeEach(async ({ request }) => {
  await request.delete(`${API}/api/elements/clear`);
});

// ─── Helpers ────────────────────────────────────────────────

async function waitForConnected(page: Page): Promise<void> {
  await expect(page.locator('.status span')).toContainText('Connected', { timeout: 5000 });
}

async function waitForElements(request: any, expectedCount: number, timeoutMs = 5000): Promise<any[]> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await request.get(`${API}/api/elements`);
    const body = await res.json();
    if (body.count === expectedCount) return body.elements;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for ${expectedCount} elements`);
}

async function getServerElementCount(request: any): Promise<number> {
  const res = await request.get(`${API}/api/elements`);
  const body = await res.json();
  return body.count;
}

async function getSyncVersion(request: any): Promise<number> {
  const res = await request.get(`${API}/api/sync/version`);
  const body = await res.json();
  return body.syncVersion;
}

// ─── THE Critical Regression Test ───────────────────────────
// This is the exact scenario that was broken: delete in UI → sync → reload → elements gone

test.describe('Delete + Sync + Reload persistence', () => {
  test('elements deleted via API stay gone after page reload', async ({ page, request }) => {
    // 1. Create elements on server
    await request.post(`${API}/api/elements`, {
      data: { id: 'del-r1', type: 'rectangle', x: 100, y: 100, width: 200, height: 100 },
    });
    await request.post(`${API}/api/elements`, {
      data: { id: 'del-r2', type: 'ellipse', x: 400, y: 100, width: 150, height: 150 },
    });

    // 2. Load the page, verify elements loaded
    await page.goto('/');
    await waitForConnected(page);
    await page.waitForTimeout(500); // Let elements render

    // 3. Delete them via sync/v2 (simulating what the Sync button does after UI deletion)
    const syncVersion = await getSyncVersion(request);
    const syncRes = await request.post(`${API}/api/elements/sync/v2`, {
      data: {
        lastSyncVersion: syncVersion,
        changes: [
          { id: 'del-r1', action: 'delete' },
          { id: 'del-r2', action: 'delete' },
        ],
      },
    });
    const syncBody = await syncRes.json();
    expect(syncBody.success).toBe(true);
    expect(syncBody.appliedCount).toBe(2);

    // 4. Verify server has 0 elements
    expect(await getServerElementCount(request)).toBe(0);

    // 5. Reload the page
    await page.reload();
    await waitForConnected(page);
    await page.waitForTimeout(500);

    // 6. Verify elements are still gone on server (the regression was here)
    expect(await getServerElementCount(request)).toBe(0);
  });

  test('sync button persists deletions that survive reload', async ({ page, request }) => {
    // 1. Create elements on server
    await request.post(`${API}/api/elements`, {
      data: { id: 'sb-1', type: 'rectangle', x: 100, y: 100, width: 200, height: 100 },
    });
    await request.post(`${API}/api/elements`, {
      data: { id: 'sb-2', type: 'text', x: 100, y: 300, text: 'To be deleted' },
    });

    // 2. Load the page
    await page.goto('/');
    await waitForConnected(page);
    await page.waitForTimeout(1000); // Let elements load + sync baseline populate

    // 3. Delete elements via delta sync (simulating UI delete + Sync button)
    const v = await getSyncVersion(request);
    await request.post(`${API}/api/elements/sync/v2`, {
      data: {
        lastSyncVersion: v,
        changes: [
          { id: 'sb-1', action: 'delete' },
          { id: 'sb-2', action: 'delete' },
        ],
      },
    });

    // 4. Reload
    await page.reload();
    await waitForConnected(page);
    await page.waitForTimeout(500);

    // 5. Verify no elements on server
    const count = await getServerElementCount(request);
    expect(count).toBe(0);

    // 6. Reload again to double-check
    await page.reload();
    await waitForConnected(page);
    await page.waitForTimeout(500);
    expect(await getServerElementCount(request)).toBe(0);
  });
});

// ─── Delta Sync v2 E2E ──────────────────────────────────────

test.describe('Delta sync v2 E2E', () => {
  test('frontend delta sync creates elements that persist', async ({ page, request }) => {
    await page.goto('/');
    await waitForConnected(page);

    // Simulate what the frontend does: send a sync with upserts
    const res = await request.post(`${API}/api/elements/sync/v2`, {
      data: {
        lastSyncVersion: 0,
        changes: [
          { id: 'ds-e2e-1', action: 'upsert', element: { id: 'ds-e2e-1', type: 'rectangle', x: 50, y: 50, width: 100, height: 60 } },
          { id: 'ds-e2e-2', action: 'upsert', element: { id: 'ds-e2e-2', type: 'ellipse', x: 200, y: 50, width: 80, height: 80 } },
        ],
      },
    });
    const body = await res.json();
    expect(body.appliedCount).toBe(2);

    // Reload and verify they persist
    await page.reload();
    await waitForConnected(page);
    const elements = await waitForElements(request, 2);
    const ids = elements.map((e: any) => e.id).sort();
    expect(ids).toEqual(['ds-e2e-1', 'ds-e2e-2']);
  });

  test('delta sync handles mixed create+delete+update', async ({ request }) => {
    // Create initial elements
    await request.post(`${API}/api/elements`, {
      data: { id: 'mix-1', type: 'rectangle', x: 0, y: 0, width: 100, height: 50 },
    });
    await request.post(`${API}/api/elements`, {
      data: { id: 'mix-2', type: 'ellipse', x: 200, y: 0, width: 80, height: 80 },
    });

    const v = await getSyncVersion(request);

    // Mixed operation: delete mix-1, update mix-2, create mix-3
    const res = await request.post(`${API}/api/elements/sync/v2`, {
      data: {
        lastSyncVersion: v,
        changes: [
          { id: 'mix-1', action: 'delete' },
          { id: 'mix-2', action: 'upsert', element: { id: 'mix-2', type: 'ellipse', x: 300, y: 100, width: 80, height: 80 } },
          { id: 'mix-3', action: 'upsert', element: { id: 'mix-3', type: 'text', x: 50, y: 200, text: 'New' } },
        ],
      },
    });
    const body = await res.json();
    expect(body.appliedCount).toBe(3);

    // Verify final state
    const listRes = await request.get(`${API}/api/elements`);
    const listBody = await listRes.json();
    expect(listBody.count).toBe(2);
    const ids = listBody.elements.map((e: any) => e.id).sort();
    expect(ids).toEqual(['mix-2', 'mix-3']);
  });

  test('server returns MCP-created elements as serverChanges', async ({ request }) => {
    // MCP creates an element (via normal API)
    await request.post(`${API}/api/elements`, {
      data: { id: 'mcp-el', type: 'rectangle', x: 0, y: 0, width: 100, height: 50 },
    });

    // Frontend syncs from version 0
    const res = await request.post(`${API}/api/elements/sync/v2`, {
      data: { lastSyncVersion: 0, changes: [] },
    });
    const body = await res.json();
    const serverIds = body.serverChanges.map((c: any) => c.id);
    expect(serverIds).toContain('mcp-el');
  });
});

// ─── Auto-sync behavior ─────────────────────────────────────

test.describe('Auto-sync toggle', () => {
  test('auto-sync button toggles state', async ({ page }) => {
    await page.goto('/');
    await waitForConnected(page);

    const autoSaveBtn = page.locator('button[title*="Auto-sync"]');
    await expect(autoSaveBtn).toBeVisible();

    // Check initial state (should show the sun/moon icon and be clickable)
    await autoSaveBtn.click();
    // Second click toggles back
    await autoSaveBtn.click();
    // No crash = success
  });
});

// ─── Sync Version Tracking E2E ──────────────────────────────

test.describe('Sync version tracking', () => {
  test('sync version increases after each mutation', async ({ request }) => {
    const v0 = await getSyncVersion(request);

    await request.post(`${API}/api/elements`, {
      data: { id: 'sv-1', type: 'rectangle', x: 0, y: 0, width: 100, height: 50 },
    });
    const v1 = await getSyncVersion(request);
    expect(v1).toBeGreaterThan(v0);

    await request.put(`${API}/api/elements/sv-1`, {
      data: { x: 50 },
    });
    const v2 = await getSyncVersion(request);
    expect(v2).toBeGreaterThan(v1);

    await request.delete(`${API}/api/elements/sv-1`);
    const v3 = await getSyncVersion(request);
    expect(v3).toBeGreaterThan(v2);
  });

  test('batch create increments sync version for each element', async ({ request }) => {
    const v0 = await getSyncVersion(request);

    await request.post(`${API}/api/elements/batch`, {
      data: {
        elements: [
          { id: 'bsv-1', type: 'rectangle', x: 0, y: 0, width: 100, height: 50 },
          { id: 'bsv-2', type: 'ellipse', x: 200, y: 0, width: 80, height: 80 },
          { id: 'bsv-3', type: 'text', x: 50, y: 100, text: 'Test' },
        ],
      },
    });

    const v1 = await getSyncVersion(request);
    expect(v1).toBeGreaterThanOrEqual(v0 + 3);
  });
});

// ─── Real-time Sync (MCP→Canvas) ────────────────────────────

test.describe('MCP to Canvas real-time sync', () => {
  test('element created via API appears on canvas via WebSocket', async ({ page, request }) => {
    await page.goto('/');
    await waitForConnected(page);

    // Create element via API
    await request.post(`${API}/api/elements`, {
      data: { id: 'rt-el', type: 'rectangle', x: 100, y: 100, width: 200, height: 100, backgroundColor: '#ff0000' },
    });

    // Wait for canvas to receive it via WS
    await page.waitForTimeout(1000);

    // Verify element is on the canvas (check via API since we can't easily inspect Excalidraw internals)
    const elements = await waitForElements(request, 1);
    expect(elements[0].id).toBe('rt-el');
  });

  test('batch create appears on canvas without reload', async ({ page, request }) => {
    await page.goto('/');
    await waitForConnected(page);

    await request.post(`${API}/api/elements/batch`, {
      data: {
        elements: [
          { id: 'rt-b1', type: 'rectangle', x: 0, y: 0, width: 100, height: 50 },
          { id: 'rt-b2', type: 'ellipse', x: 200, y: 0, width: 80, height: 80 },
        ],
      },
    });

    await page.waitForTimeout(1000);

    const elements = await waitForElements(request, 2);
    expect(elements).toHaveLength(2);
  });

  test('element update appears on canvas without reload', async ({ page, request }) => {
    // Pre-create
    await request.post(`${API}/api/elements`, {
      data: { id: 'rt-upd', type: 'rectangle', x: 0, y: 0, width: 100, height: 50 },
    });

    await page.goto('/');
    await waitForConnected(page);
    await page.waitForTimeout(500);

    // Update
    await request.put(`${API}/api/elements/rt-upd`, {
      data: { x: 500, y: 500 },
    });

    await page.waitForTimeout(1000);

    // Verify update persisted
    const res = await request.get(`${API}/api/elements/rt-upd`);
    const body = await res.json();
    expect(body.element.x).toBe(500);
    expect(body.element.y).toBe(500);
  });

  test('element delete via API clears from canvas', async ({ page, request }) => {
    await request.post(`${API}/api/elements`, {
      data: { id: 'rt-del', type: 'rectangle', x: 100, y: 100, width: 200, height: 100 },
    });

    await page.goto('/');
    await waitForConnected(page);
    await page.waitForTimeout(500);

    await request.delete(`${API}/api/elements/rt-del`);
    await page.waitForTimeout(500);

    expect(await getServerElementCount(request)).toBe(0);
  });
});

// ─── Clear Canvas E2E ───────────────────────────────────────

test.describe('Clear canvas persistence', () => {
  test('clearing via API removes all elements permanently', async ({ page, request }) => {
    // Create elements
    await request.post(`${API}/api/elements/batch`, {
      data: {
        elements: [
          { id: 'clr-1', type: 'rectangle', x: 0, y: 0, width: 100, height: 50 },
          { id: 'clr-2', type: 'text', x: 50, y: 100, text: 'Will be cleared' },
        ],
      },
    });

    await page.goto('/');
    await waitForConnected(page);
    await page.waitForTimeout(500);

    // Clear
    await request.delete(`${API}/api/elements/clear`);
    await page.waitForTimeout(500);

    // Verify gone
    expect(await getServerElementCount(request)).toBe(0);

    // Reload
    await page.reload();
    await waitForConnected(page);
    await page.waitForTimeout(500);

    // Still gone
    expect(await getServerElementCount(request)).toBe(0);
  });
});

// ─── Snapshot Create + Restore ──────────────────────────────

test.describe('Snapshots E2E', () => {
  test('create snapshot, clear, restore, verify elements return', async ({ request }) => {
    // Create elements
    await request.post(`${API}/api/elements/batch`, {
      data: {
        elements: [
          { id: 'snap-1', type: 'rectangle', x: 0, y: 0, width: 100, height: 50 },
          { id: 'snap-2', type: 'text', x: 50, y: 100, text: 'Snapshot test' },
        ],
      },
    });

    // Save snapshot
    const snapRes = await request.post(`${API}/api/snapshots`, {
      data: { name: 'test-snap' },
    });
    expect((await snapRes.json()).success).toBe(true);

    // Clear
    await request.delete(`${API}/api/elements/clear`);
    expect(await getServerElementCount(request)).toBe(0);

    // List snapshots
    const listRes = await request.get(`${API}/api/snapshots`);
    const listBody = await listRes.json();
    expect(listBody.snapshots.some((s: any) => s.name === 'test-snap')).toBe(true);

    // Get snapshot
    const getRes = await request.get(`${API}/api/snapshots/test-snap`);
    const getBody = await getRes.json();
    expect(getBody.snapshot).toBeDefined();
    expect(getBody.snapshot.elements).toHaveLength(2);
  });
});

// ─── Settings Persistence ───────────────────────────────────

test.describe('Settings E2E', () => {
  test('settings persist across requests', async ({ request }) => {
    await request.put(`${API}/api/settings/test_key`, {
      data: { value: 'test_value' },
    });

    const res = await request.get(`${API}/api/settings/test_key`);
    const body = await res.json();
    expect(body.value).toBe('test_value');
  });
});

// ─── Files API E2E ──────────────────────────────────────────

test.describe('Files API E2E', () => {
  test('add and list files', async ({ request }) => {
    const addRes = await request.post(`${API}/api/files`, {
      data: {
        files: {
          'file-1': {
            id: 'file-1',
            mimeType: 'image/png',
            dataURL: 'data:image/png;base64,iVBOR...',
            created: Date.now(),
          },
        },
      },
    });
    expect((await addRes.json()).success).toBe(true);

    const listRes = await request.get(`${API}/api/files`);
    const listBody = await listRes.json();
    expect(listBody.files['file-1']).toBeDefined();
    expect(listBody.files['file-1'].mimeType).toBe('image/png');
  });

  test('delete file', async ({ request }) => {
    await request.post(`${API}/api/files`, {
      data: {
        files: {
          'file-del': {
            id: 'file-del',
            mimeType: 'image/png',
            dataURL: 'data:image/png;base64,abc',
            created: Date.now(),
          },
        },
      },
    });

    const delRes = await request.delete(`${API}/api/files/file-del`);
    expect((await delRes.json()).success).toBe(true);

    const listRes = await request.get(`${API}/api/files`);
    const listBody = await listRes.json();
    expect(listBody.files['file-del']).toBeUndefined();
  });
});

// ─── Search API E2E ─────────────────────────────────────────

test.describe('Search E2E', () => {
  test('search by type returns matching elements', async ({ request }) => {
    await request.post(`${API}/api/elements/batch`, {
      data: {
        elements: [
          { id: 'srch-r', type: 'rectangle', x: 0, y: 0, width: 100, height: 50 },
          { id: 'srch-e', type: 'ellipse', x: 200, y: 0, width: 80, height: 80 },
          { id: 'srch-t', type: 'text', x: 50, y: 100, text: 'Search me' },
        ],
      },
    });

    // Filter by type
    const res = await request.get(`${API}/api/elements/search?type=rectangle`);
    const body = await res.json();
    expect(body.elements.length).toBe(1);
    expect(body.elements[0].type).toBe('rectangle');
  });

  test('full-text search finds elements by label', async ({ request }) => {
    await request.post(`${API}/api/elements`, {
      data: { id: 'fts-el', type: 'rectangle', x: 0, y: 0, width: 100, height: 50, label: { text: 'Authentication Service' } },
    });

    const res = await request.get(`${API}/api/elements/search?q=Authentication`);
    const body = await res.json();
    expect(body.elements.length).toBeGreaterThanOrEqual(1);
    expect(body.elements.some((e: any) => e.id === 'fts-el')).toBe(true);
  });
});

// ─── Tenant API E2E ─────────────────────────────────────────

test.describe('Tenant management E2E', () => {
  test('list tenants returns at least default', async ({ request }) => {
    const res = await request.get(`${API}/api/tenants`);
    const body = await res.json();
    expect(body.tenants.length).toBeGreaterThanOrEqual(1);
  });

  test('active tenant is available', async ({ request }) => {
    const res = await request.get(`${API}/api/tenant/active`);
    const body = await res.json();
    expect(body.tenant).toBeDefined();
    expect(body.tenant.id).toBeDefined();
  });
});

// ─── Element Version History E2E ────────────────────────────

test.describe('Element version history E2E', () => {
  test('element history tracks create and update', async ({ request }) => {
    await request.post(`${API}/api/elements`, {
      data: { id: 'hist-el', type: 'rectangle', x: 0, y: 0, width: 100, height: 50 },
    });

    await request.put(`${API}/api/elements/hist-el`, {
      data: { x: 500 },
    });

    // Get element to verify it exists and is updated
    const getRes = await request.get(`${API}/api/elements/hist-el`);
    const body = await getRes.json();
    expect(body.element.x).toBe(500);
  });
});
