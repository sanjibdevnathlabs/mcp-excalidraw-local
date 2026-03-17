import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  initDb,
  closeDb,
  setElement,
  getElement,
  hasElement,
  deleteElement,
  getAllElements,
  getElementCount,
  clearElements,
  queryElements,
  searchElements,
  getElementHistory,
  getProjectHistory,
  saveSnapshot,
  getSnapshot,
  listSnapshots,
  ensureTenant,
  setActiveTenant,
  getActiveTenant,
  getActiveTenantId,
  listTenants,
  createProject,
  listProjects,
  setActiveProject,
  getActiveProject,
  getActiveProjectId,
  getDefaultProjectForTenant,
  bulkReplaceElements,
  getSetting,
  setSetting,
  incrementSyncVersion,
  getCurrentSyncVersion,
  getChangesSince,
} from '../../src/db.js';
import type { ServerElement } from '../../src/types.js';
import path from 'path';
import os from 'os';
import fs from 'fs';

let dbPath: string;

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

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `excalidraw-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  initDb(dbPath);
  // Reset module-level active tenant/project to 'default' which initDb() always creates
  setActiveTenant('default');
});

afterEach(() => {
  closeDb();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
});

// ─── Element CRUD ────────────────────────────────────────────

describe('Element CRUD', () => {
  it('setElement + getElement round-trips correctly', () => {
    const el = makeElement({ id: 'e1' });
    setElement('e1', el);

    const fetched = getElement('e1');
    expect(fetched).toBeDefined();
    expect(fetched!.id).toBe('e1');
    expect(fetched!.type).toBe('rectangle');
    expect(fetched!.x).toBe(100);
    expect(fetched!.y).toBe(200);
  });

  it('hasElement returns true for existing, false for missing', () => {
    expect(hasElement('missing')).toBe(false);
    setElement('exists', makeElement({ id: 'exists' }));
    expect(hasElement('exists')).toBe(true);
  });

  it('getElement returns undefined for non-existent id', () => {
    expect(getElement('nope')).toBeUndefined();
  });

  it('setElement updates an existing element and increments version', () => {
    const el = makeElement({ id: 'e1' });
    setElement('e1', el);

    const updated = makeElement({ id: 'e1', x: 999 });
    setElement('e1', updated);

    const fetched = getElement('e1');
    expect(fetched!.x).toBe(999);
  });

  it('deleteElement soft-deletes and returns true', () => {
    setElement('del1', makeElement({ id: 'del1' }));
    expect(deleteElement('del1')).toBe(true);
    expect(getElement('del1')).toBeUndefined();
    expect(hasElement('del1')).toBe(false);
  });

  it('deleteElement returns false for non-existent id', () => {
    expect(deleteElement('nope')).toBe(false);
  });

  it('deleted element can be re-created', () => {
    setElement('recr', makeElement({ id: 'recr' }));
    deleteElement('recr');
    expect(getElement('recr')).toBeUndefined();

    setElement('recr', makeElement({ id: 'recr', x: 42 }));
    expect(getElement('recr')!.x).toBe(42);
  });

  it('getAllElements returns all non-deleted elements', () => {
    setElement('a', makeElement({ id: 'a' }));
    setElement('b', makeElement({ id: 'b' }));
    setElement('c', makeElement({ id: 'c' }));
    deleteElement('b');

    const all = getAllElements();
    expect(all.length).toBe(2);
    expect(all.map(e => e.id).sort()).toEqual(['a', 'c']);
  });

  it('getElementCount returns correct count', () => {
    expect(getElementCount()).toBe(0);
    setElement('x', makeElement({ id: 'x' }));
    setElement('y', makeElement({ id: 'y' }));
    expect(getElementCount()).toBe(2);
    deleteElement('x');
    expect(getElementCount()).toBe(1);
  });

  it('clearElements soft-deletes all and returns count', () => {
    setElement('a', makeElement({ id: 'a' }));
    setElement('b', makeElement({ id: 'b' }));
    setElement('c', makeElement({ id: 'c' }));

    const count = clearElements();
    expect(count).toBe(3);
    expect(getAllElements()).toEqual([]);
    expect(getElementCount()).toBe(0);
  });

  it('clearElements on empty canvas returns 0', () => {
    expect(clearElements()).toBe(0);
  });
});

// ─── Query & Search ──────────────────────────────────────────

describe('queryElements', () => {
  it('filters by type', () => {
    setElement('r1', makeElement({ id: 'r1', type: 'rectangle' }));
    setElement('e1', makeElement({ id: 'e1', type: 'ellipse' }));
    setElement('r2', makeElement({ id: 'r2', type: 'rectangle' }));

    const rects = queryElements('rectangle');
    expect(rects.length).toBe(2);
    expect(rects.every(e => e.type === 'rectangle')).toBe(true);
  });

  it('filters by arbitrary property', () => {
    setElement('a', makeElement({ id: 'a', x: 10, y: 20 }));
    setElement('b', makeElement({ id: 'b', x: 10, y: 99 }));

    const results = queryElements(undefined, { x: 10 });
    expect(results.length).toBe(2);
  });

  it('returns all when no filters', () => {
    setElement('a', makeElement({ id: 'a' }));
    setElement('b', makeElement({ id: 'b' }));
    expect(queryElements().length).toBe(2);
  });
});

describe('searchElements (FTS)', () => {
  it('finds elements by label text', () => {
    setElement('t1', makeElement({ id: 't1', type: 'text', label: { text: 'Hello World' } }));
    setElement('t2', makeElement({ id: 't2', type: 'text', label: { text: 'Goodbye' } }));

    const results = searchElements('Hello');
    expect(results.length).toBe(1);
    expect(results[0]!.id).toBe('t1');
  });

  it('finds elements by type in FTS', () => {
    setElement('r1', makeElement({ id: 'r1', type: 'rectangle' }));
    setElement('e1', makeElement({ id: 'e1', type: 'ellipse' }));

    const results = searchElements('rectangle');
    expect(results.length).toBe(1);
    expect(results[0]!.id).toBe('r1');
  });
});

// ─── Version History ─────────────────────────────────────────

describe('Version History', () => {
  it('records create and update operations', () => {
    setElement('v1', makeElement({ id: 'v1' }));
    setElement('v1', makeElement({ id: 'v1', x: 999 }));

    const history = getElementHistory('v1');
    expect(history.length).toBe(2);
    expect(history[0]!.operation).toBe('update');
    expect(history[1]!.operation).toBe('create');
  });

  it('records delete operation', () => {
    setElement('v2', makeElement({ id: 'v2' }));
    deleteElement('v2');

    const history = getElementHistory('v2');
    expect(history.length).toBe(2);
    expect(history[0]!.operation).toBe('delete');
    expect(history[1]!.operation).toBe('create');
  });

  it('getProjectHistory returns all operations across elements', () => {
    setElement('a', makeElement({ id: 'a' }));
    setElement('b', makeElement({ id: 'b' }));
    deleteElement('a');

    const history = getProjectHistory();
    expect(history.length).toBe(3);
  });

  it('respects limit parameter', () => {
    setElement('a', makeElement({ id: 'a' }));
    setElement('b', makeElement({ id: 'b' }));
    setElement('c', makeElement({ id: 'c' }));

    const history = getProjectHistory(2);
    expect(history.length).toBe(2);
  });
});

// ─── Snapshots ───────────────────────────────────────────────

describe('Snapshots', () => {
  it('save and retrieve a snapshot', () => {
    const elements = [makeElement({ id: 's1' }), makeElement({ id: 's2' })];
    saveSnapshot('snap1', elements);

    const snapshot = getSnapshot('snap1');
    expect(snapshot).toBeDefined();
    expect(snapshot!.name).toBe('snap1');
    expect(snapshot!.elements.length).toBe(2);
  });

  it('getSnapshot returns undefined for missing name', () => {
    expect(getSnapshot('nonexistent')).toBeUndefined();
  });

  it('listSnapshots returns all snapshots with counts', () => {
    saveSnapshot('snap-a', [makeElement()]);
    saveSnapshot('snap-b', [makeElement(), makeElement()]);

    const list = listSnapshots();
    expect(list.length).toBe(2);
    const snapB = list.find(s => s.name === 'snap-b');
    expect(snapB!.elementCount).toBe(2);
  });

  it('saveSnapshot with same name overwrites', () => {
    saveSnapshot('dup', [makeElement()]);
    saveSnapshot('dup', [makeElement(), makeElement(), makeElement()]);

    const snapshot = getSnapshot('dup');
    expect(snapshot!.elements.length).toBe(3);

    const list = listSnapshots();
    expect(list.filter(s => s.name === 'dup').length).toBe(1);
  });
});

// ─── Tenants ─────────────────────────────────────────────────

describe('Tenants', () => {
  it('default tenant exists after initDb', () => {
    const tenant = getActiveTenant();
    expect(tenant).toBeDefined();
    expect(tenant.id).toBe('default');
  });

  it('ensureTenant creates a new tenant', () => {
    const t = ensureTenant('t1', 'Test Tenant', '/workspace/test');
    expect(t.id).toBe('t1');
    expect(t.name).toBe('Test Tenant');
    expect(t.workspace_path).toBe('/workspace/test');
  });

  it('ensureTenant is idempotent', () => {
    ensureTenant('t1', 'Test', '/path');
    const t2 = ensureTenant('t1', 'Test', '/path');
    expect(t2.id).toBe('t1');

    const tenants = listTenants();
    expect(tenants.filter(t => t.id === 't1').length).toBe(1);
  });

  it('setActiveTenant switches the active tenant', () => {
    ensureTenant('t2', 'Tenant 2', '/t2');
    setActiveTenant('t2');
    expect(getActiveTenantId()).toBe('t2');
  });

  it('setActiveTenant throws for non-existent tenant', () => {
    expect(() => setActiveTenant('no-such')).toThrow();
  });

  it('listTenants returns all tenants', () => {
    ensureTenant('a', 'A', '/a');
    ensureTenant('b', 'B', '/b');

    const tenants = listTenants();
    expect(tenants.length).toBeGreaterThanOrEqual(3); // default + a + b
  });
});

// ─── Projects ────────────────────────────────────────────────

describe('Projects', () => {
  it('default project exists', () => {
    const project = getActiveProject();
    expect(project).toBeDefined();
    expect(project.id).toBe('default');
  });

  it('createProject creates and can be listed', () => {
    const proj = createProject('My Project', 'A test project');
    expect(proj.name).toBe('My Project');

    const projects = listProjects();
    expect(projects.some(p => p.name === 'My Project')).toBe(true);
  });

  it('setActiveProject changes the active project', () => {
    const proj = createProject('Switch Me');
    setActiveProject(proj.id);
    expect(getActiveProjectId()).toBe(proj.id);
  });

  it('setActiveProject throws for non-existent project', () => {
    expect(() => setActiveProject('fake')).toThrow();
  });

  it('elements are scoped to the active project', () => {
    const proj1 = createProject('P1');
    const proj2 = createProject('P2');

    setActiveProject(proj1.id);
    setElement('e1', makeElement({ id: 'e1' }));

    setActiveProject(proj2.id);
    setElement('e2', makeElement({ id: 'e2' }));

    setActiveProject(proj1.id);
    expect(getAllElements().length).toBe(1);
    expect(getAllElements()[0]!.id).toBe('e1');

    setActiveProject(proj2.id);
    expect(getAllElements().length).toBe(1);
    expect(getAllElements()[0]!.id).toBe('e2');
  });

  it('getDefaultProjectForTenant creates a default project if none exists', () => {
    ensureTenant('orphan', 'Orphan', '/orphan');
    const projId = getDefaultProjectForTenant('orphan');
    expect(projId).toBe('orphan-default');
  });
});

// ─── Settings ────────────────────────────────────────────────

describe('Settings', () => {
  it('getSetting returns undefined for missing key', () => {
    expect(getSetting('nonexistent')).toBeUndefined();
  });

  it('setSetting + getSetting round-trips', () => {
    setSetting('theme', 'dark');
    expect(getSetting('theme')).toBe('dark');
  });

  it('setSetting overwrites existing value', () => {
    setSetting('key', 'val1');
    setSetting('key', 'val2');
    expect(getSetting('key')).toBe('val2');
  });
});

// ─── Bulk Operations ─────────────────────────────────────────

describe('bulkReplaceElements', () => {
  it('replaces all elements atomically', () => {
    setElement('old1', makeElement({ id: 'old1' }));
    setElement('old2', makeElement({ id: 'old2' }));

    const newElements = [makeElement({ id: 'new1' }), makeElement({ id: 'new2' }), makeElement({ id: 'new3' })];
    const count = bulkReplaceElements(newElements);
    expect(count).toBe(3);

    const all = getAllElements();
    expect(all.length).toBe(3);
    expect(all.map(e => e.id).sort()).toEqual(['new1', 'new2', 'new3']);
  });

  it('replaces with empty array clears all', () => {
    setElement('x', makeElement({ id: 'x' }));
    bulkReplaceElements([]);
    expect(getAllElements()).toEqual([]);
  });
});

// ─── Sync Version ───────────────────────────────────────────

describe('Sync Version', () => {
  it('getCurrentSyncVersion returns 0 initially', () => {
    expect(getCurrentSyncVersion()).toBe(0);
  });

  it('incrementSyncVersion increments and returns new version', () => {
    expect(incrementSyncVersion()).toBe(1);
    expect(incrementSyncVersion()).toBe(2);
    expect(incrementSyncVersion()).toBe(3);
  });

  it('setElement increments sync_version', () => {
    setElement('sv1', makeElement({ id: 'sv1' }));
    expect(getCurrentSyncVersion()).toBeGreaterThan(0);
  });

  it('setElement returns sync_version', () => {
    const sv = setElement('sv2', makeElement({ id: 'sv2' }));
    expect(sv).toBeGreaterThan(0);
  });

  it('deleteElement increments sync_version', () => {
    setElement('del-sv', makeElement({ id: 'del-sv' }));
    const versionAfterCreate = getCurrentSyncVersion();
    deleteElement('del-sv');
    expect(getCurrentSyncVersion()).toBeGreaterThan(versionAfterCreate);
  });

  it('clearElements increments sync_version', () => {
    setElement('clr1', makeElement({ id: 'clr1' }));
    setElement('clr2', makeElement({ id: 'clr2' }));
    const versionAfterCreates = getCurrentSyncVersion();
    clearElements();
    expect(getCurrentSyncVersion()).toBeGreaterThan(versionAfterCreates);
  });

  it('getChangesSince returns empty for version 0 when no elements', () => {
    const changes = getChangesSince(0);
    expect(changes).toEqual([]);
  });

  it('getChangesSince returns upserts after setElement', () => {
    setElement('cs1', makeElement({ id: 'cs1' }));
    setElement('cs2', makeElement({ id: 'cs2' }));

    const changes = getChangesSince(0);
    expect(changes.length).toBe(2);
    expect(changes.every(c => c.action === 'upsert')).toBe(true);
  });

  it('getChangesSince returns delete entries', () => {
    setElement('csd1', makeElement({ id: 'csd1' }));
    deleteElement('csd1');

    const changes = getChangesSince(0);
    const deleteChange = changes.find(c => c.action === 'delete');
    expect(deleteChange).toBeDefined();
  });

  it('getChangesSince filters by version', () => {
    const sv1 = setElement('fv1', makeElement({ id: 'fv1' }));
    setElement('fv2', makeElement({ id: 'fv2' }));

    const changes = getChangesSince(sv1);
    expect(changes.length).toBe(1);
    expect(changes[0]!.id).toBe('fv2');
  });

  it('sync_version is scoped per project', () => {
    const proj1 = createProject('SV-P1');
    const proj2 = createProject('SV-P2');

    setActiveProject(proj1.id);
    setElement('sp1', makeElement({ id: 'sp1' }));
    const sv1 = getCurrentSyncVersion(proj1.id);

    setActiveProject(proj2.id);
    setElement('sp2', makeElement({ id: 'sp2' }));
    setElement('sp3', makeElement({ id: 'sp3' }));
    const sv2 = getCurrentSyncVersion(proj2.id);

    // Each project tracks its own sync_version independently
    expect(sv1).toBeGreaterThan(0);
    expect(sv2).toBeGreaterThan(0);
    // P2 had more mutations so its version should be higher than P1's
    expect(sv2).toBeGreaterThan(sv1);
  });
});
