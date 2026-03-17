import { test, expect } from '@playwright/test';

const API = 'http://localhost:3100';

test.beforeEach(async ({ request }) => {
  await request.delete(`${API}/api/elements/clear`);
});

// ─── Page Load ───────────────────────────────────────────────

test.describe('Page Load', () => {
  test('canvas page loads successfully', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.header h1')).toContainText('Excalidraw Canvas');
  });

  test('shows connected status after WebSocket connects', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.status span')).toContainText('Connected', { timeout: 5000 });
  });

  test('has Clear Canvas button', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('button:has-text("Clear Canvas")')).toBeVisible();
  });

  test('has Sync button', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('button:has-text("Sync")')).toBeVisible();
  });
});

// ─── Health Endpoint ─────────────────────────────────────────

test.describe('Health Endpoint', () => {
  test('returns healthy status', async ({ request }) => {
    const res = await request.get(`${API}/health`);
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body.status).toBe('healthy');
  });
});

// ─── API Element CRUD via Playwright request ─────────────────

test.describe('Element CRUD via API', () => {
  test('create and list elements', async ({ request }) => {
    const createRes = await request.post(`${API}/api/elements`, {
      data: {
        id: 'e2e-rect-1',
        type: 'rectangle',
        x: 100,
        y: 100,
        width: 200,
        height: 100,
        backgroundColor: '#ff6b6b',
      },
    });
    expect(createRes.ok()).toBe(true);

    const listRes = await request.get(`${API}/api/elements`);
    const listBody = await listRes.json();
    expect(listBody.count).toBe(1);
    expect(listBody.elements[0].id).toBe('e2e-rect-1');
  });

  test('batch create elements', async ({ request }) => {
    const batchRes = await request.post(`${API}/api/elements/batch`, {
      data: {
        elements: [
          { id: 'batch-1', type: 'rectangle', x: 0, y: 0, width: 100, height: 50 },
          { id: 'batch-2', type: 'ellipse', x: 200, y: 0, width: 80, height: 80 },
          { id: 'batch-3', type: 'text', x: 50, y: 100, text: 'E2E Test' },
        ],
      },
    });
    expect(batchRes.ok()).toBe(true);

    const listRes = await request.get(`${API}/api/elements`);
    const listBody = await listRes.json();
    expect(listBody.count).toBe(3);
  });

  test('delete element', async ({ request }) => {
    await request.post(`${API}/api/elements`, {
      data: { id: 'del-e2e', type: 'rectangle', x: 50, y: 50, width: 100, height: 100 },
    });

    const delRes = await request.delete(`${API}/api/elements/del-e2e`);
    expect(delRes.ok()).toBe(true);

    const checkRes = await request.get(`${API}/api/elements/del-e2e`);
    expect(checkRes.status()).toBe(404);
  });

  test('clear all elements', async ({ request }) => {
    await request.post(`${API}/api/elements/batch`, {
      data: {
        elements: [
          { type: 'rectangle', x: 0, y: 0, width: 50, height: 50 },
          { type: 'ellipse', x: 100, y: 100, width: 40, height: 40 },
        ],
      },
    });

    const clearRes = await request.delete(`${API}/api/elements/clear`);
    expect(clearRes.ok()).toBe(true);
    const clearBody = await clearRes.json();
    expect(clearBody.count).toBe(2);

    const listRes = await request.get(`${API}/api/elements`);
    const listBody = await listRes.json();
    expect(listBody.count).toBe(0);
  });
});

// ─── Real-time Sync ──────────────────────────────────────────

test.describe('Real-time Canvas Sync', () => {
  test('element created via API appears in canvas', async ({ page, request }) => {
    await page.goto('/');
    await expect(page.locator('.status span')).toContainText('Connected', { timeout: 5000 });
    await page.waitForTimeout(500);

    await request.post(`${API}/api/elements`, {
      data: {
        id: 'sync-rect',
        type: 'rectangle',
        x: 100,
        y: 100,
        width: 200,
        height: 100,
      },
    });

    await page.waitForTimeout(1000);

    // Verify element exists in backend
    const verifyRes = await request.get(`${API}/api/elements/sync-rect`);
    expect(verifyRes.ok()).toBe(true);
  });

  test('canvas_cleared broadcast clears the canvas', async ({ page, request }) => {
    await page.goto('/');
    await expect(page.locator('.status span')).toContainText('Connected', { timeout: 5000 });
    await page.waitForTimeout(500);

    await request.post(`${API}/api/elements`, {
      data: { id: 'clear-test', type: 'rectangle', x: 0, y: 0, width: 50, height: 50 },
    });
    await page.waitForTimeout(300);

    await request.delete(`${API}/api/elements/clear`);
    await page.waitForTimeout(500);

    const listRes = await request.get(`${API}/api/elements`);
    const body = await listRes.json();
    expect(body.count).toBe(0);
  });
});

// ─── Clear Canvas UI Confirmation ────────────────────────────

test.describe('Clear Canvas UI Confirmation', () => {
  test('Clear Canvas button shows confirmation dialog', async ({ page, request }) => {
    // Reset the skip-confirm preference
    await request.put(`${API}/api/settings/clear_canvas_skip_confirm`, {
      data: { value: 'false' },
    });

    await page.goto('/');
    await page.waitForTimeout(500);

    await page.locator('button:has-text("Clear Canvas")').click();

    const dialog = page.locator('.confirm-dialog');
    await expect(dialog).toBeVisible({ timeout: 2000 });
    await expect(dialog.locator('.confirm-title')).toContainText('Clear Canvas');
  });

  test('Cancel closes the confirmation dialog', async ({ page, request }) => {
    await request.put(`${API}/api/settings/clear_canvas_skip_confirm`, {
      data: { value: 'false' },
    });

    await page.goto('/');
    await page.waitForTimeout(500);

    await page.locator('button:has-text("Clear Canvas")').click();
    await expect(page.locator('.confirm-dialog')).toBeVisible();

    await page.locator('.confirm-dialog button:has-text("Cancel")').click();
    await expect(page.locator('.confirm-dialog')).not.toBeVisible();
  });

  test('Confirm button clears the canvas', async ({ page, request }) => {
    await request.put(`${API}/api/settings/clear_canvas_skip_confirm`, {
      data: { value: 'false' },
    });

    await request.post(`${API}/api/elements`, {
      data: { type: 'rectangle', x: 0, y: 0, width: 100, height: 50 },
    });

    await page.goto('/');
    await page.waitForTimeout(500);

    await page.locator('button:has-text("Clear Canvas")').click();
    await expect(page.locator('.confirm-dialog')).toBeVisible();

    await page.locator('.confirm-dialog button:has-text("Clear")').click();
    await expect(page.locator('.confirm-dialog')).not.toBeVisible();

    await page.waitForTimeout(1000);

    const listRes = await request.get(`${API}/api/elements`);
    const body = await listRes.json();
    expect(body.count).toBe(0);
  });
});

// ─── Snapshots ───────────────────────────────────────────────

test.describe('Snapshots via API', () => {
  test('create and list snapshots', async ({ request }) => {
    await request.post(`${API}/api/elements`, {
      data: { type: 'rectangle', x: 0, y: 0, width: 50, height: 50 },
    });

    const snapRes = await request.post(`${API}/api/snapshots`, {
      data: { name: 'e2e-snapshot' },
    });
    expect(snapRes.ok()).toBe(true);

    const listRes = await request.get(`${API}/api/snapshots`);
    const listBody = await listRes.json();
    expect(listBody.snapshots.some((s: any) => s.name === 'e2e-snapshot')).toBe(true);
  });

  test('get snapshot by name', async ({ request }) => {
    await request.post(`${API}/api/elements`, {
      data: { type: 'ellipse', x: 10, y: 10, width: 30, height: 30 },
    });
    await request.post(`${API}/api/snapshots`, {
      data: { name: 'get-snap' },
    });

    const res = await request.get(`${API}/api/snapshots/get-snap`);
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body.snapshot.name).toBe('get-snap');
  });
});

// ─── Settings via API ────────────────────────────────────────

test.describe('Settings via API', () => {
  test('set and get a setting', async ({ request }) => {
    await request.put(`${API}/api/settings/e2e_key`, {
      data: { value: 'e2e_value' },
    });

    const res = await request.get(`${API}/api/settings/e2e_key`);
    const body = await res.json();
    expect(body.value).toBe('e2e_value');
  });

  test('returns null for missing key', async ({ request }) => {
    const res = await request.get(`${API}/api/settings/nonexistent_key`);
    const body = await res.json();
    expect(body.value).toBeNull();
  });
});

// ─── Sync Version API ───────────────────────────────────────

test.describe('Sync Version API', () => {
  test('GET /api/sync/version returns initial version', async ({ request }) => {
    const res = await request.get(`${API}/api/sync/version`);
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(typeof body.syncVersion).toBe('number');
  });

  test('sync version increases after element creation', async ({ request }) => {
    const beforeRes = await request.get(`${API}/api/sync/version`);
    const beforeBody = await beforeRes.json();
    const versionBefore = beforeBody.syncVersion;

    await request.post(`${API}/api/elements`, {
      data: {
        id: 'sync-ver-el',
        type: 'rectangle',
        x: 10,
        y: 10,
        width: 100,
        height: 50,
      },
    });

    const afterRes = await request.get(`${API}/api/sync/version`);
    const afterBody = await afterRes.json();
    expect(afterBody.syncVersion).toBeGreaterThan(versionBefore);
  });
});

// ─── Delta Sync v2 API ──────────────────────────────────────

test.describe('Delta Sync v2 API', () => {
  test('accepts empty changes and returns current state', async ({ request }) => {
    const res = await request.post(`${API}/api/elements/sync/v2`, {
      data: { lastSyncVersion: 0, changes: [] },
    });
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(typeof body.currentSyncVersion).toBe('number');
    expect(Array.isArray(body.serverChanges)).toBe(true);
  });

  test('applies upsert changes via delta sync', async ({ request }) => {
    const res = await request.post(`${API}/api/elements/sync/v2`, {
      data: {
        lastSyncVersion: 0,
        changes: [
          {
            id: 'delta-upsert-1',
            action: 'upsert',
            element: {
              id: 'delta-upsert-1',
              type: 'rectangle',
              x: 50,
              y: 50,
              width: 120,
              height: 60,
            },
          },
        ],
      },
    });
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.appliedCount).toBeGreaterThanOrEqual(1);

    // Verify the element exists via GET
    const getRes = await request.get(`${API}/api/elements/delta-upsert-1`);
    expect(getRes.ok()).toBe(true);
    const getBody = await getRes.json();
    expect(getBody.element.id).toBe('delta-upsert-1');
  });

  test('returns server changes for elements created via normal API', async ({ request }) => {
    // Create an element via the normal REST API
    await request.post(`${API}/api/elements`, {
      data: {
        id: 'normal-api-el',
        type: 'ellipse',
        x: 200,
        y: 200,
        width: 80,
        height: 80,
      },
    });

    // Now call delta sync with lastSyncVersion: 0 to get all server changes
    const syncRes = await request.post(`${API}/api/elements/sync/v2`, {
      data: { lastSyncVersion: 0, changes: [] },
    });
    expect(syncRes.ok()).toBe(true);
    const syncBody = await syncRes.json();
    expect(syncBody.serverChanges.some((el: any) => el.id === 'normal-api-el')).toBe(true);
  });
});

// ─── canvasStatus in API responses ──────────────────────────

test.describe('canvasStatus in API responses', () => {
  test('element creation response includes canvasStatus', async ({ request }) => {
    const createRes = await request.post(`${API}/api/elements`, {
      data: {
        id: 'status-check-el',
        type: 'rectangle',
        x: 300,
        y: 300,
        width: 150,
        height: 75,
      },
    });
    expect(createRes.ok()).toBe(true);
    const body = await createRes.json();

    // syncedToCanvas should be a boolean
    expect(typeof body.syncedToCanvas).toBe('boolean');

    // canvasStatus object should be present with expected fields
    expect(body.canvasStatus).toBeDefined();
    expect(typeof body.canvasStatus.connectedBrowsers).toBe('number');
    expect(typeof body.canvasStatus.ackedBy).toBe('number');
    expect(typeof body.canvasStatus.reason).toBe('string');
    expect(typeof body.canvasStatus.scope).toBe('string');
  });
});

// ─── Real-time Sync with ACK ────────────────────────────────

test.describe('Real-time Sync with ACK', () => {
  test('syncedToCanvas is true when browser is connected', async ({ page, request }) => {
    // Open the page and wait for WebSocket connection
    await page.goto('/');
    await expect(page.locator('.status span')).toContainText('Connected', { timeout: 5000 });
    await page.waitForTimeout(500);

    // Create an element via API while browser is connected
    const createRes = await request.post(`${API}/api/elements`, {
      data: {
        id: 'ack-test-rect',
        type: 'rectangle',
        x: 400,
        y: 400,
        width: 200,
        height: 100,
        backgroundColor: '#4ecdc4',
      },
    });
    expect(createRes.ok()).toBe(true);
    const body = await createRes.json();

    // Browser should have ACKed, so syncedToCanvas should be true
    expect(body.syncedToCanvas).toBe(true);

    // Also verify the element exists in the backend
    const verifyRes = await request.get(`${API}/api/elements/ack-test-rect`);
    expect(verifyRes.ok()).toBe(true);
    const verifyBody = await verifyRes.json();
    expect(verifyBody.element.id).toBe('ack-test-rect');
  });

  test('batch create with browser connected gets ACK', async ({ page, request }) => {
    // Open the page and wait for WebSocket connection
    await page.goto('/');
    await expect(page.locator('.status span')).toContainText('Connected', { timeout: 5000 });
    await page.waitForTimeout(500);

    // Batch create elements via API while browser is connected
    const batchRes = await request.post(`${API}/api/elements/batch`, {
      data: {
        elements: [
          { id: 'ack-batch-1', type: 'rectangle', x: 0, y: 0, width: 100, height: 50 },
          { id: 'ack-batch-2', type: 'ellipse', x: 200, y: 0, width: 80, height: 80 },
        ],
      },
    });
    expect(batchRes.ok()).toBe(true);
    const body = await batchRes.json();

    // Browser should have ACKed the batch broadcast
    expect(body.syncedToCanvas).toBe(true);
  });
});
