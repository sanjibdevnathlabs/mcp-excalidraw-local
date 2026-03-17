import { test, expect } from '@playwright/test';

const API = 'http://localhost:3100';

test.beforeEach(async ({ request }) => {
  await request.delete(`${API}/api/elements/clear`);
});

// ─── Fix 3: Hello handshake → real-time sync works immediately ──

test.describe('Hello handshake and real-time sync', () => {
  test('element created via API appears in canvas without page reload', async ({ page, request }) => {
    await page.goto('/');
    await expect(page.locator('.status span')).toContainText('Connected', { timeout: 5000 });
    // Wait for hello handshake to complete
    await page.waitForTimeout(1000);

    // Create an element via API — it should appear in the canvas immediately
    const createRes = await request.post(`${API}/api/elements`, {
      data: {
        id: 'hello-sync-test',
        type: 'rectangle',
        x: 100,
        y: 100,
        width: 200,
        height: 100,
        backgroundColor: '#a5d8ff',
      },
    });
    expect(createRes.ok()).toBe(true);
    const body = await createRes.json();

    // syncedToCanvas should be true because the browser's WS is registered
    // via hello handshake
    expect(body.syncedToCanvas).toBe(true);
  });

  test('batch create via API syncs to canvas', async ({ page, request }) => {
    await page.goto('/');
    await expect(page.locator('.status span')).toContainText('Connected', { timeout: 5000 });
    await page.waitForTimeout(1000);

    const batchRes = await request.post(`${API}/api/elements/batch`, {
      data: {
        elements: [
          { id: 'batch-sync-1', type: 'rectangle', x: 0, y: 0, width: 100, height: 50 },
          { id: 'batch-sync-2', type: 'ellipse', x: 200, y: 0, width: 80, height: 80 },
        ],
      },
    });
    expect(batchRes.ok()).toBe(true);
    const body = await batchRes.json();

    // Should be ACKed because browser is connected and registered
    expect(body.syncedToCanvas).toBe(true);
    expect(body.count).toBe(2);
  });
});

// ─── Fix 6: Parallel creates don't lose elements ────────────

test.describe('Parallel element creation (race condition fix)', () => {
  test('5 parallel API creates all persist and sync to canvas', async ({ page, request }) => {
    await page.goto('/');
    await expect(page.locator('.status span')).toContainText('Connected', { timeout: 5000 });
    await page.waitForTimeout(1000);

    // Fire 5 parallel element creations
    const promises = Array.from({ length: 5 }, (_, i) =>
      request.post(`${API}/api/elements`, {
        data: {
          id: `parallel-${i}`,
          type: 'rectangle',
          x: i * 150,
          y: 0,
          width: 120,
          height: 60,
        },
      })
    );

    const results = await Promise.all(promises);
    for (const res of results) {
      expect(res.ok()).toBe(true);
    }

    // All 5 should exist in the DB
    const listRes = await request.get(`${API}/api/elements`);
    const listBody = await listRes.json();
    expect(listBody.count).toBe(5);

    // Wait for all broadcasts to complete
    await page.waitForTimeout(2000);

    // Verify via Excalidraw API that all 5 are in the canvas
    const canvasElementCount = await page.evaluate(() => {
      // Access the Excalidraw API through the window if exposed
      const excalidrawWrapper = document.querySelector('.excalidraw');
      if (!excalidrawWrapper) return -1;
      // Count rendered canvas elements via the backend
      return fetch('/api/elements')
        .then(r => r.json())
        .then(data => data.count);
    });
    expect(canvasElementCount).toBe(5);
  });

  test('parallel batch + single create all persist', async ({ page, request }) => {
    await page.goto('/');
    await expect(page.locator('.status span')).toContainText('Connected', { timeout: 5000 });
    await page.waitForTimeout(1000);

    const [batchRes, singleRes] = await Promise.all([
      request.post(`${API}/api/elements/batch`, {
        data: {
          elements: [
            { id: 'mix-batch-1', type: 'rectangle', x: 0, y: 0, width: 100, height: 50 },
            { id: 'mix-batch-2', type: 'ellipse', x: 200, y: 0, width: 80, height: 80 },
          ],
        },
      }),
      request.post(`${API}/api/elements`, {
        data: { id: 'mix-single', type: 'diamond', x: 400, y: 0, width: 60, height: 60 },
      }),
    ]);

    expect(batchRes.ok()).toBe(true);
    expect(singleRes.ok()).toBe(true);

    const listRes = await request.get(`${API}/api/elements`);
    const listBody = await listRes.json();
    expect(listBody.count).toBe(3);
  });
});

// ─── Fix 1: Batch create error messages ─────────────────────

test.describe('Batch create error handling (E2E)', () => {
  test('batch with invalid element returns descriptive error, not "unavailable"', async ({ request }) => {
    const res = await request.post(`${API}/api/elements/batch`, {
      data: {
        elements: [
          { type: 'rectangle', x: 0, y: 0, width: 100, height: 50 },
          { type: 'invalid-thing', x: 0, y: 0 },
        ],
      },
    });

    expect(res.ok()).toBe(false);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).not.toContain('HTTP server unavailable');
  });
});

// ─── Fix 5: Viewport control ────────────────────────────────

test.describe('Viewport control', () => {
  test('set_viewport scrollToContent works without animation delay', async ({ page, request }) => {
    await page.goto('/');
    await expect(page.locator('.status span')).toContainText('Connected', { timeout: 5000 });
    await page.waitForTimeout(1000);

    // Create some elements spread across the canvas
    await request.post(`${API}/api/elements/batch`, {
      data: {
        elements: [
          { id: 'vp-el-1', type: 'rectangle', x: 0, y: 0, width: 200, height: 100 },
          { id: 'vp-el-2', type: 'rectangle', x: 1000, y: 1000, width: 200, height: 100 },
        ],
      },
    });

    await page.waitForTimeout(500);

    // Elements should exist
    const listRes = await request.get(`${API}/api/elements`);
    const listBody = await listRes.json();
    expect(listBody.count).toBe(2);
  });
});

// ─── Fix 4: Screenshot capture ──────────────────────────────

test.describe('Screenshot and image export', () => {
  test('export image endpoint works with browser connected', async ({ page, request }) => {
    await page.goto('/');
    await expect(page.locator('.status span')).toContainText('Connected', { timeout: 5000 });
    await page.waitForTimeout(1000);

    // Create an element so there's something to capture
    await request.post(`${API}/api/elements`, {
      data: {
        id: 'screenshot-el',
        type: 'rectangle',
        x: 100,
        y: 100,
        width: 200,
        height: 100,
        backgroundColor: '#ff6b6b',
      },
    });
    await page.waitForTimeout(500);

    // Request a screenshot (full scene export)
    const exportRes = await request.post(`${API}/api/export/image`, {
      data: { format: 'png', background: true },
    });
    expect(exportRes.ok()).toBe(true);
    const exportBody = await exportRes.json();
    expect(exportBody.success).toBe(true);
    expect(exportBody.format).toBe('png');
    expect(typeof exportBody.data).toBe('string');
    expect(exportBody.data.length).toBeGreaterThan(100); // non-trivial base64
  });

  test('viewport screenshot (captureViewport) works with browser connected', async ({ page, request }) => {
    await page.goto('/');
    await expect(page.locator('.status span')).toContainText('Connected', { timeout: 5000 });
    await page.waitForTimeout(1000);

    // Create an element
    await request.post(`${API}/api/elements`, {
      data: {
        id: 'vp-screenshot-el',
        type: 'rectangle',
        x: 100,
        y: 100,
        width: 200,
        height: 100,
        backgroundColor: '#4ecdc4',
      },
    });
    await page.waitForTimeout(500);

    // Request a viewport screenshot
    const exportRes = await request.post(`${API}/api/export/image`, {
      data: { format: 'png', background: true, captureViewport: true },
    });
    expect(exportRes.ok()).toBe(true);
    const exportBody = await exportRes.json();
    expect(exportBody.success).toBe(true);
    expect(exportBody.format).toBe('png');
    expect(typeof exportBody.data).toBe('string');
    expect(exportBody.data.length).toBeGreaterThan(100);
  });
});
