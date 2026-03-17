import express, { type Application, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import logger from './utils/logger.js';
import {
  generateId,
  EXCALIDRAW_ELEMENT_TYPES,
  ServerElement,
  ExcalidrawElementType,
  WebSocketMessage,
  ElementCreatedMessage,
  ElementUpdatedMessage,
  ElementDeletedMessage,
  BatchCreatedMessage,
  SyncStatusMessage,
  InitialElementsMessage,
  Snapshot,
  normalizeFontFamily,
  ExcalidrawFile,
  files,
  ClientConnection,
  BroadcastResult
} from './types.js';
import * as store from './db.js';
import { initDb, listTenants as dbListTenants, getActiveTenant as dbGetActiveTenant, setActiveTenant as dbSetActiveTenant, getDefaultProjectForTenant, getCurrentSyncVersion, getChangesSince } from './db.js';
import { z } from 'zod';
import WebSocket from 'ws';

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app: Application = express();
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Serve static files from the build directory
const staticDir = path.join(__dirname, '../dist');
app.use(express.static(staticDir));
// Also serve frontend assets
app.use(express.static(path.join(__dirname, '../dist/frontend')));

// Resolve tenant from X-Tenant-Id header to a projectId override.
// Returns undefined when header is absent (browser requests), falling back to global state.
function resolveTenantProject(req: Request): string | undefined {
  const tenantId = req.headers['x-tenant-id'] as string | undefined;
  if (!tenantId) return undefined;
  return getDefaultProjectForTenant(tenantId);
}

// Resolve both tenantId and projectId for scoped broadcast.
// Falls back to active tenant/project when header is absent.
function resolveScope(req: Request): { tenantId: string; projectId: string } {
  const headerTenantId = req.headers['x-tenant-id'] as string | undefined;
  if (headerTenantId) {
    const projectId = getDefaultProjectForTenant(headerTenantId) ?? `${headerTenantId}-default`;
    return { tenantId: headerTenantId, projectId };
  }
  // Fallback for browser requests without header
  const tenant = dbGetActiveTenant();
  const projectId = getDefaultProjectForTenant(tenant.id) ?? `${tenant.id}-default`;
  return { tenantId: tenant.id, projectId };
}

// ── Connection Registry (Task 3) ──────────────────────────────────────────
// Scoped by tenant → project → Set<ClientConnection>
const connections = new Map<string, Map<string, Set<ClientConnection>>>();
// Reverse lookup: ws → ClientConnection (for fast cleanup)
const wsToConnection = new Map<WebSocket, ClientConnection>();

function registerConnection(conn: ClientConnection): void {
  let tenantMap = connections.get(conn.tenantId);
  if (!tenantMap) {
    tenantMap = new Map();
    connections.set(conn.tenantId, tenantMap);
  }
  let projectSet = tenantMap.get(conn.projectId);
  if (!projectSet) {
    projectSet = new Set();
    tenantMap.set(conn.projectId, projectSet);
  }
  projectSet.add(conn);
  wsToConnection.set(conn.ws, conn);
}

function unregisterConnection(ws: WebSocket): void {
  const conn = wsToConnection.get(ws);
  if (!conn) return;
  const tenantMap = connections.get(conn.tenantId);
  if (tenantMap) {
    const projectSet = tenantMap.get(conn.projectId);
    if (projectSet) {
      projectSet.delete(conn);
      if (projectSet.size === 0) tenantMap.delete(conn.projectId);
    }
    if (tenantMap.size === 0) connections.delete(conn.tenantId);
  }
  wsToConnection.delete(ws);
}

function moveConnection(ws: WebSocket, newTenantId: string, newProjectId: string): void {
  unregisterConnection(ws);
  const conn = { ws, tenantId: newTenantId, projectId: newProjectId, connectedAt: Date.now(), identified: true };
  registerConnection(conn);
}

function getConnectionsForScope(tenantId: string, projectId: string): Set<ClientConnection> {
  return connections.get(tenantId)?.get(projectId) ?? new Set();
}

// ── Scoped Broadcast (Task 5) ─────────────────────────────────────────────
function broadcastToScope(
  tenantId: string,
  projectId: string,
  message: WebSocketMessage,
  exclude?: WebSocket
): BroadcastResult {
  const msgId = generateId();
  (message as any).msgId = msgId;

  const scopeConns = getConnectionsForScope(tenantId, projectId);
  const targets = [...scopeConns].filter(c =>
    c.ws !== exclude && c.ws.readyState === WebSocket.OPEN
  );

  if (targets.length === 0) {
    return { delivered: 0, msgId, reason: 'no_clients_in_scope' };
  }

  const data = JSON.stringify(message);
  for (const conn of targets) {
    conn.ws.send(data);
  }

  return { delivered: targets.length, msgId };
}

// ── ACK Tracking (Task 6) ─────────────────────────────────────────────────
interface AckResult {
  acked: boolean;
  delivered: number;
  reason?: string;
  ackPayload?: { status: string; elementCount?: number; expectedCount?: number };
}

interface PendingAck {
  resolve: (payload: { status: string; elementCount?: number; expectedCount?: number } | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pendingAcks = new Map<string, PendingAck>();

function resolveAck(msgId: string, payload: { status: string; elementCount?: number; expectedCount?: number }): void {
  const pending = pendingAcks.get(msgId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingAcks.delete(msgId);
  pending.resolve(payload);
}

async function broadcastWithAck(
  tenantId: string,
  projectId: string,
  message: WebSocketMessage,
  timeoutMs: number = 3000
): Promise<AckResult> {
  const br = broadcastToScope(tenantId, projectId, message);

  if (br.delivered === 0) {
    return { acked: false, delivered: 0, reason: br.reason ?? 'no_clients' };
  }

  // Wait for first ACK from any client
  const ackPayload = await new Promise<{ status: string; elementCount?: number; expectedCount?: number } | null>((resolve) => {
    const timer = setTimeout(() => {
      pendingAcks.delete(br.msgId);
      resolve(null);
    }, timeoutMs);
    pendingAcks.set(br.msgId, { resolve, timer });
  });

  return {
    acked: ackPayload !== null,
    delivered: br.delivered,
    ackPayload: ackPayload ?? undefined,
    reason: ackPayload ? undefined : 'ack_timeout'
  };
}

// ── Per-Scope Broadcast Serialization ────────────────────────────────────
// When multiple MCP tool calls fire in parallel (e.g., parallel create_element),
// each produces a broadcastWithAck. Without serialization, the frontend receives
// overlapping WS messages and getSceneElements() returns stale snapshots,
// causing earlier elements to be clobbered.
// This queue ensures broadcasts within the same scope are sent one at a time,
// waiting for the previous ACK before sending the next.
const scopeBroadcastQueues = new Map<string, Promise<AckResult>>();

async function serializedBroadcastWithAck(
  tenantId: string,
  projectId: string,
  message: WebSocketMessage,
  timeoutMs: number = 3000
): Promise<AckResult> {
  const scopeKey = `${tenantId}/${projectId}`;

  // Chain onto the previous broadcast for this scope (or start fresh)
  const previous = scopeBroadcastQueues.get(scopeKey) ?? Promise.resolve({} as AckResult);

  const current = previous
    // Wait for previous to settle (success or failure) before sending ours
    .catch(() => {})
    .then(() => broadcastWithAck(tenantId, projectId, message, timeoutMs));

  scopeBroadcastQueues.set(scopeKey, current);

  try {
    return await current;
  } finally {
    // Clean up if we're still the tail of the queue
    if (scopeBroadcastQueues.get(scopeKey) === current) {
      scopeBroadcastQueues.delete(scopeKey);
    }
  }
}

// Legacy broadcast: sends to ALL connected clients (used for global messages
// like tenant_switched that aren't scoped to a single project).
function broadcast(message: WebSocketMessage): void {
  const data = JSON.stringify(message);
  for (const conn of wsToConnection.values()) {
    if (conn.ws.readyState === WebSocket.OPEN) {
      conn.ws.send(data);
    }
  }
}

// ── WebSocket Connection Handling (Task 4: Hello Handshake) ───────────────
wss.on('connection', (ws: WebSocket) => {
  // Register with fallback scope until hello handshake identifies the client.
  const tenant = (() => { try { return dbGetActiveTenant(); } catch { return { id: 'default', name: 'default', workspace_path: '' }; } })();
  const fallbackProjectId = getDefaultProjectForTenant(tenant.id) ?? 'default';
  const conn: ClientConnection = {
    ws,
    tenantId: tenant.id,
    projectId: fallbackProjectId,
    connectedAt: Date.now(),
    identified: false
  };
  registerConnection(conn);
  logger.info('New WebSocket connection established (awaiting hello)');

  // Send tenant info so the FE knows where to send hello
  ws.send(JSON.stringify({
    type: 'tenant_switched',
    tenant: { id: tenant.id, name: tenant.name, workspace_path: tenant.workspace_path }
  }));

  // For backward compatibility: also send initial_elements immediately.
  // New FE versions will ignore this and use hello_ack instead.
  const initialMessage: InitialElementsMessage = {
    type: 'initial_elements',
    elements: store.getAllElements(fallbackProjectId)
  };
  ws.send(JSON.stringify(initialMessage));

  // Send any stored files (image data)
  if (files.size > 0) {
    const allFiles: Record<string, ExcalidrawFile> = {};
    for (const [id, file] of files) {
      allFiles[id] = file;
    }
    ws.send(JSON.stringify({ type: 'files_added', files: allFiles }));
  }

  // Send sync status to new client
  const syncMessage: SyncStatusMessage = {
    type: 'sync_status',
    elementCount: store.getElementCount(fallbackProjectId),
    timestamp: new Date().toISOString()
  };
  ws.send(JSON.stringify(syncMessage));

  // Handle incoming messages from this client
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'hello') {
        const helloTenantId = msg.tenantId as string;
        const helloProjectId = (msg.projectId as string) || getDefaultProjectForTenant(msg.tenantId) || `${msg.tenantId}-default`;
        if (helloTenantId) {
          // Move connection to the correct scope
          moveConnection(ws, helloTenantId, helloProjectId);
          logger.info(`Client identified: tenant=${helloTenantId} project=${helloProjectId}`);

          // Respond with scoped elements
          const elements = store.getAllElements(helloProjectId);
          ws.send(JSON.stringify({
            type: 'hello_ack',
            tenantId: helloTenantId,
            projectId: helloProjectId,
            elements
          }));
        }
      }
      if (msg.type === 'ack' && msg.msgId) {
        resolveAck(msg.msgId, {
          status: msg.status ?? 'applied',
          elementCount: msg.elementCount,
          expectedCount: msg.expectedCount
        });
      }
    } catch (err) {
      logger.debug('Failed to parse WS message from client:', (err as Error).message);
    }
  });

  ws.on('close', () => {
    unregisterConnection(ws);
    logger.info('WebSocket connection closed');
  });

  ws.on('error', (error) => {
    logger.error('WebSocket error:', error);
    unregisterConnection(ws);
  });
});

// Schema validation
const CreateElementSchema = z.object({
  id: z.string().optional(),
  type: z.enum(Object.values(EXCALIDRAW_ELEMENT_TYPES) as [ExcalidrawElementType, ...ExcalidrawElementType[]]),
  x: z.number(),
  y: z.number(),
  width: z.number().optional(),
  height: z.number().optional(),
  backgroundColor: z.string().optional(),
  strokeColor: z.string().optional(),
  strokeWidth: z.number().optional(),
  strokeStyle: z.string().optional(),
  roughness: z.number().optional(),
  opacity: z.number().optional(),
  text: z.string().optional(),
  originalText: z.string().optional(),
  label: z.object({
    text: z.string()
  }).optional(),
  fontSize: z.number().optional(),
  fontFamily: z.union([z.string(), z.number()]).optional(),
  groupIds: z.array(z.string()).optional(),
  locked: z.boolean().optional(),
  roundness: z.object({ type: z.number(), value: z.number().optional() }).nullable().optional(),
  fillStyle: z.string().optional(),
  // Arrow-specific properties
  points: z.any().optional(),
  start: z.object({ id: z.string() }).optional(),
  end: z.object({ id: z.string() }).optional(),
  startArrowhead: z.string().nullable().optional(),
  endArrowhead: z.string().nullable().optional(),
  startBinding: z.any().nullable().optional(),
  endBinding: z.any().nullable().optional(),
  boundElements: z.any().nullable().optional(),
  elbowed: z.boolean().optional(),
  // Image element properties
  fileId: z.string().optional(),
  status: z.string().optional(),
  scale: z.tuple([z.number(), z.number()]).optional(),
});

const UpdateElementSchema = z.object({
  id: z.string(),
  type: z.enum(Object.values(EXCALIDRAW_ELEMENT_TYPES) as [ExcalidrawElementType, ...ExcalidrawElementType[]]).optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  backgroundColor: z.string().optional(),
  strokeColor: z.string().optional(),
  strokeWidth: z.number().optional(),
  strokeStyle: z.string().optional(),
  roughness: z.number().optional(),
  opacity: z.number().optional(),
  text: z.string().optional(),
  originalText: z.string().optional(),
  label: z.object({
    text: z.string()
  }).optional(),
  fontSize: z.number().optional(),
  fontFamily: z.union([z.string(), z.number()]).optional(),
  groupIds: z.array(z.string()).optional(),
  locked: z.boolean().optional(),
  roundness: z.object({ type: z.number(), value: z.number().optional() }).nullable().optional(),
  fillStyle: z.string().optional(),
  points: z.array(z.union([
    z.tuple([z.number(), z.number()]),
    z.object({ x: z.number(), y: z.number() })
  ])).optional(),
  start: z.object({ id: z.string() }).optional(),
  end: z.object({ id: z.string() }).optional(),
  startArrowhead: z.string().nullable().optional(),
  endArrowhead: z.string().nullable().optional(),
  startBinding: z.any().nullable().optional(),
  endBinding: z.any().nullable().optional(),
  boundElements: z.any().nullable().optional(),
  elbowed: z.boolean().optional(),
  fileId: z.string().optional(),
  status: z.string().optional(),
  scale: z.tuple([z.number(), z.number()]).optional(),
});

// API Routes

// Get all elements
app.get('/api/elements', (req: Request, res: Response) => {
  try {
    const projId = resolveTenantProject(req);
    const allElements = store.getAllElements(projId);
    res.json({
      success: true,
      elements: allElements,
      count: allElements.length
    });
  } catch (error) {
    logger.error('Error fetching elements:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Create new element
app.post('/api/elements', async (req: Request, res: Response) => {
  try {
    const projId = resolveTenantProject(req);
    const params = CreateElementSchema.parse(req.body);
    logger.info('Creating element via API', { type: params.type });

    const id = params.id || generateId();
    const normalizedFont = normalizeFontFamily(params.fontFamily);
    const element: ServerElement = {
      id,
      ...params,
      ...(normalizedFont !== undefined ? { fontFamily: normalizedFont } : {}),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1
    };

    const sv = store.setElement(id, element, projId);

    const scope = resolveScope(req);
    const message: ElementCreatedMessage = {
      type: 'element_created',
      element: element
    };
    (message as any).sync_version = sv;
    const ackResult = await serializedBroadcastWithAck(scope.tenantId, scope.projectId, message);

    res.json({
      success: true,
      element: element,
      syncedToCanvas: ackResult.acked,
      canvasStatus: {
        connectedBrowsers: ackResult.delivered,
        ackedBy: ackResult.acked ? 1 : 0,
        reason: ackResult.reason,
        scope: `${scope.tenantId}/${scope.projectId}`
      }
    });
  } catch (error) {
    logger.error('Error creating element:', error);
    res.status(400).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Update element
app.put('/api/elements/:id', async (req: Request, res: Response) => {
  try {
    const projId = resolveTenantProject(req);
    const { id } = req.params;
    const updates = UpdateElementSchema.parse({ id, ...req.body });
    
    if (!id) {
      return res.status(400).json({
        success: false,
        error: 'Element ID is required'
      });
    }
    
    const existingElement = store.getElement(id, projId);
    if (!existingElement) {
      return res.status(404).json({
        success: false,
        error: `Element with ID ${id} not found`
      });
    }

    const normalizedFont = normalizeFontFamily(updates.fontFamily);
    const updatedElement: ServerElement = {
      ...existingElement,
      ...updates,
      ...(normalizedFont !== undefined ? { fontFamily: normalizedFont } : {}),
      updatedAt: new Date().toISOString(),
      version: (existingElement.version || 0) + 1
    };

    const sv = store.setElement(id, updatedElement, projId);

    const scope = resolveScope(req);
    const message: ElementUpdatedMessage = {
      type: 'element_updated',
      element: updatedElement
    };
    (message as any).sync_version = sv;
    const ackResult = await serializedBroadcastWithAck(scope.tenantId, scope.projectId, message);

    res.json({
      success: true,
      element: updatedElement,
      syncedToCanvas: ackResult.acked,
      canvasStatus: {
        connectedBrowsers: ackResult.delivered,
        ackedBy: ackResult.acked ? 1 : 0,
        reason: ackResult.reason,
        scope: `${scope.tenantId}/${scope.projectId}`
      }
    });
  } catch (error) {
    logger.error('Error updating element:', error);
    res.status(400).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Clear all elements (must be before /:id route)
app.delete('/api/elements/clear', (req: Request, res: Response) => {
  try {
    const projId = resolveTenantProject(req);
    const count = store.clearElements(projId);

    const scope = resolveScope(req);
    broadcastToScope(scope.tenantId, scope.projectId, {
      type: 'canvas_cleared',
      timestamp: new Date().toISOString()
    });

    logger.info(`Canvas cleared: ${count} elements removed`);

    res.json({
      success: true,
      message: `Cleared ${count} elements`,
      count
    });
  } catch (error) {
    logger.error('Error clearing canvas:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Delete element
app.delete('/api/elements/:id', (req: Request, res: Response) => {
  try {
    const projId = resolveTenantProject(req);
    const { id } = req.params;
    
    if (!id) {
      return res.status(400).json({
        success: false,
        error: 'Element ID is required'
      });
    }
    
    if (!store.hasElement(id, projId)) {
      return res.status(404).json({
        success: false,
        error: `Element with ID ${id} not found`
      });
    }
    
    store.deleteElement(id, projId);

    const scope = resolveScope(req);
    const message: ElementDeletedMessage = {
      type: 'element_deleted',
      elementId: id!
    };
    broadcastToScope(scope.tenantId, scope.projectId, message);
    
    res.json({
      success: true,
      message: `Element ${id} deleted successfully`
    });
  } catch (error) {
    logger.error('Error deleting element:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Query elements with filters
app.get('/api/elements/search', (req: Request, res: Response) => {
  try {
    const projId = resolveTenantProject(req);
    const { type, q, ...filters } = req.query;

    if (q && typeof q === 'string') {
      const results = store.searchElements(q, projId);
      return res.json({ success: true, elements: results, count: results.length });
    }

    const results = store.queryElements(
      type && typeof type === 'string' ? type : undefined,
      Object.keys(filters).length > 0 ? filters as Record<string, any> : undefined,
      projId
    );
    
    res.json({
      success: true,
      elements: results,
      count: results.length
    });
  } catch (error) {
    logger.error('Error querying elements:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Get element by ID
app.get('/api/elements/:id', (req: Request, res: Response) => {
  try {
    const projId = resolveTenantProject(req);
    const { id } = req.params;
    
    if (!id) {
      return res.status(400).json({
        success: false,
        error: 'Element ID is required'
      });
    }
    
    const element = store.getElement(id, projId);
    
    if (!element) {
      return res.status(404).json({
        success: false,
        error: `Element with ID ${id} not found`
      });
    }
    
    res.json({
      success: true,
      element: element
    });
  } catch (error) {
    logger.error('Error fetching element:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Helper: compute edge point for an element given a direction toward a target
function computeEdgePoint(
  el: ServerElement,
  targetCenterX: number,
  targetCenterY: number
): { x: number; y: number } {
  const cx = el.x + (el.width || 0) / 2;
  const cy = el.y + (el.height || 0) / 2;
  const dx = targetCenterX - cx;
  const dy = targetCenterY - cy;

  if (el.type === 'diamond') {
    // Diamond edge: use diamond geometry (rotated square)
    const hw = (el.width || 0) / 2;
    const hh = (el.height || 0) / 2;
    if (dx === 0 && dy === 0) return { x: cx, y: cy + hh };
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);
    // Scale factor to reach diamond edge
    const scale = (absDx / hw + absDy / hh) > 0
      ? 1 / (absDx / hw + absDy / hh)
      : 1;
    return { x: cx + dx * scale, y: cy + dy * scale };
  }

  if (el.type === 'ellipse') {
    // Ellipse edge: parametric intersection
    const a = (el.width || 0) / 2;
    const b = (el.height || 0) / 2;
    if (dx === 0 && dy === 0) return { x: cx, y: cy + b };
    const angle = Math.atan2(dy, dx);
    return { x: cx + a * Math.cos(angle), y: cy + b * Math.sin(angle) };
  }

  // Rectangle: find intersection with edges
  const hw = (el.width || 0) / 2;
  const hh = (el.height || 0) / 2;
  if (dx === 0 && dy === 0) return { x: cx, y: cy + hh };
  const angle = Math.atan2(dy, dx);
  const tanA = Math.tan(angle);
  // Check if ray intersects top/bottom edge or left/right edge
  if (Math.abs(tanA * hw) <= hh) {
    // Intersects left or right edge
    const signX = dx >= 0 ? 1 : -1;
    return { x: cx + signX * hw, y: cy + signX * hw * tanA };
  } else {
    // Intersects top or bottom edge
    const signY = dy >= 0 ? 1 : -1;
    return { x: cx + signY * hh / tanA, y: cy + signY * hh };
  }
}

// Helper: resolve arrow bindings in a batch
function resolveArrowBindings(batchElements: ServerElement[], projectId?: string): void {
  const elementMap = new Map<string, ServerElement>();
  batchElements.forEach(el => elementMap.set(el.id, el));

  // Also check existing elements for cross-batch references
  for (const el of store.getAllElements(projectId)) {
    if (!elementMap.has(el.id)) elementMap.set(el.id, el);
  }

  for (const el of batchElements) {
    if (el.type !== 'arrow' && el.type !== 'line') continue;
    const startRef = (el as any).start as { id: string } | undefined;
    const endRef = (el as any).end as { id: string } | undefined;

    if (!startRef && !endRef) continue;

    const startEl = startRef ? elementMap.get(startRef.id) : undefined;
    const endEl = endRef ? elementMap.get(endRef.id) : undefined;

    // Calculate arrow path from edge to edge
    const startCenter = startEl
      ? { x: startEl.x + (startEl.width || 0) / 2, y: startEl.y + (startEl.height || 0) / 2 }
      : { x: el.x, y: el.y };
    const endCenter = endEl
      ? { x: endEl.x + (endEl.width || 0) / 2, y: endEl.y + (endEl.height || 0) / 2 }
      : { x: el.x + 100, y: el.y };

    const GAP = 8;
    const startPt = startEl
      ? computeEdgePoint(startEl, endCenter.x, endCenter.y)
      : startCenter;
    const endPt = endEl
      ? computeEdgePoint(endEl, startCenter.x, startCenter.y)
      : endCenter;

    // Apply gap: move start point slightly away from source, end point slightly away from target
    const startDx = endPt.x - startPt.x;
    const startDy = endPt.y - startPt.y;
    const startDist = Math.sqrt(startDx * startDx + startDy * startDy) || 1;
    const endDx = startPt.x - endPt.x;
    const endDy = startPt.y - endPt.y;
    const endDist = Math.sqrt(endDx * endDx + endDy * endDy) || 1;

    const finalStart = {
      x: startPt.x + (startDx / startDist) * GAP,
      y: startPt.y + (startDy / startDist) * GAP
    };
    const finalEnd = {
      x: endPt.x + (endDx / endDist) * GAP,
      y: endPt.y + (endDy / endDist) * GAP
    };

    // Set arrow position and points
    el.x = finalStart.x;
    el.y = finalStart.y;
    el.points = [[0, 0], [finalEnd.x - finalStart.x, finalEnd.y - finalStart.y]];

    // Keep start/end refs on the element — the frontend's
    // convertToExcalidrawElements uses them to compute proper bindings
    // (focus, gap, fixedPoint). Also set basic binding metadata for export.
    if (startEl) {
      (el as any).startBinding = {
        elementId: startEl.id,
        focus: 0,
        gap: GAP
      };
    }
    if (endEl) {
      (el as any).endBinding = {
        elementId: endEl.id,
        focus: 0,
        gap: GAP
      };
    }
  }
}

// Batch create elements
app.post('/api/elements/batch', async (req: Request, res: Response) => {
  try {
    const projId = resolveTenantProject(req);
    const { elements: elementsToCreate } = req.body;

    if (!Array.isArray(elementsToCreate)) {
      return res.status(400).json({
        success: false,
        error: 'Expected an array of elements'
      });
    }

    const createdElements: ServerElement[] = [];

    elementsToCreate.forEach(elementData => {
      const params = CreateElementSchema.parse(elementData);
      const id = params.id || generateId();
      const normalizedFont = normalizeFontFamily(params.fontFamily);
      const element: ServerElement = {
        id,
        ...params,
        ...(normalizedFont !== undefined ? { fontFamily: normalizedFont } : {}),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        version: 1
      };

      createdElements.push(element);
    });

    resolveArrowBindings(createdElements, projId);

    let latestSyncVersion = 0;
    createdElements.forEach(el => { latestSyncVersion = store.setElement(el.id, el, projId); });

    const scope = resolveScope(req);
    const message: BatchCreatedMessage = {
      type: 'elements_batch_created',
      elements: createdElements
    };
    (message as any).sync_version = latestSyncVersion;
    const ackResult = await serializedBroadcastWithAck(scope.tenantId, scope.projectId, message);

    res.json({
      success: true,
      elements: createdElements,
      count: createdElements.length,
      syncedToCanvas: ackResult.acked,
      canvasStatus: {
        connectedBrowsers: ackResult.delivered,
        ackedBy: ackResult.acked ? 1 : 0,
        reason: ackResult.reason,
        scope: `${scope.tenantId}/${scope.projectId}`
      }
    });
  } catch (error) {
    logger.error('Error batch creating elements:', error);
    res.status(400).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Convert Mermaid diagram to Excalidraw elements
app.post('/api/elements/from-mermaid', (req: Request, res: Response) => {
  try {
    const { mermaidDiagram, config } = req.body;
    
    if (!mermaidDiagram || typeof mermaidDiagram !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Mermaid diagram definition is required'
      });
    }
    
    logger.info('Received Mermaid conversion request', { 
      diagramLength: mermaidDiagram.length,
      hasConfig: !!config 
    });
    
    // Broadcast to scoped WebSocket clients to process the Mermaid diagram
    const scope = resolveScope(req);
    broadcastToScope(scope.tenantId, scope.projectId, {
      type: 'mermaid_convert',
      mermaidDiagram,
      config: config || {},
      timestamp: new Date().toISOString()
    });
    
    // Return the diagram for frontend processing
    res.json({
      success: true,
      mermaidDiagram,
      config: config || {},
      message: 'Mermaid diagram sent to frontend for conversion.'
    });
  } catch (error) {
    logger.error('Error processing Mermaid diagram:', error);
    res.status(400).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Sync elements from frontend (overwrite sync)
app.post('/api/elements/sync', (req: Request, res: Response) => {
  try {
    const projId = resolveTenantProject(req);
    const { elements: frontendElements, timestamp } = req.body;
    
    logger.info(`Sync request received: ${frontendElements.length} elements`, {
      timestamp,
      elementCount: frontendElements.length
    });
    
    if (!Array.isArray(frontendElements)) {
      return res.status(400).json({
        success: false,
        error: 'Expected elements to be an array'
      });
    }
    
    const beforeCount = store.getElementCount(projId);

    // Process elements with server metadata
    const processedElements: ServerElement[] = [];
    let successCount = 0;

    frontendElements.forEach((element: any, index: number) => {
      try {
        const elementId = element.id || generateId();
        const processedElement: ServerElement = {
          ...element,
          id: elementId,
          syncedAt: new Date().toISOString(),
          source: 'frontend_sync',
          syncTimestamp: timestamp,
          version: 1
        };
        processedElements.push(processedElement);
        successCount++;
      } catch (elementError) {
        logger.warn(`Failed to process element ${index}:`, elementError);
      }
    });

    store.bulkReplaceElements(processedElements, projId);
    logger.info(`Sync completed: ${successCount}/${frontendElements.length} elements synced`);

    const scope = resolveScope(req);
    broadcastToScope(scope.tenantId, scope.projectId, {
      type: 'elements_synced',
      count: successCount,
      timestamp: new Date().toISOString(),
      source: 'manual_sync'
    });

    res.json({
      success: true,
      message: `Successfully synced ${successCount} elements`,
      count: successCount,
      syncedAt: new Date().toISOString(),
      beforeCount,
      afterCount: store.getElementCount(projId)
    });
    
  } catch (error) {
    logger.error('Sync error:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message,
      details: 'Internal server error during sync operation'
    });
  }
});

// ── Delta Sync v2 (Task 10) ──

app.post('/api/elements/sync/v2', (req: Request, res: Response) => {
  try {
    const projId = resolveTenantProject(req);
    const { lastSyncVersion = 0, changes = [] } = req.body;

    if (typeof lastSyncVersion !== 'number') {
      return res.status(400).json({ success: false, error: 'lastSyncVersion must be a number' });
    }

    const scope = resolveScope(req);
    const feChangeIds = new Set<string>();

    // Apply FE changes to DB
    let appliedCount = 0;
    for (const change of changes) {
      const { id, action, element } = change;
      if (!id || !action) continue;
      feChangeIds.add(id);

      if (action === 'delete') {
        store.deleteElement(id, projId);
        appliedCount++;
      } else if (action === 'upsert' && element) {
        store.setElement(id, element, projId);
        appliedCount++;
      }
    }

    // Get BE-side changes the FE hasn't seen (excluding what FE just sent)
    const allBEChanges = getChangesSince(lastSyncVersion, projId);
    const serverChanges = allBEChanges.filter(c => !feChangeIds.has(c.id));

    const currentVersion = getCurrentSyncVersion(projId);

    // Broadcast FE changes to other tabs in scope
    if (appliedCount > 0) {
      broadcastToScope(scope.tenantId, scope.projectId, {
        type: 'elements_synced',
        count: appliedCount,
        timestamp: new Date().toISOString(),
        source: 'delta_sync_v2',
        sync_version: currentVersion
      });
    }

    res.json({
      success: true,
      currentSyncVersion: currentVersion,
      serverChanges,
      appliedCount
    });
  } catch (error) {
    logger.error('Delta sync v2 error:', error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// Get current sync version for a project
app.get('/api/sync/version', (req: Request, res: Response) => {
  try {
    const projId = resolveTenantProject(req);
    const version = getCurrentSyncVersion(projId);
    res.json({ success: true, syncVersion: version });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// ── Files API (image element data) ──

// Get all files
app.get('/api/files', (_req: Request, res: Response) => {
  try {
    const allFiles: Record<string, ExcalidrawFile> = {};
    for (const [id, file] of files) {
      allFiles[id] = file;
    }
    res.json({ success: true, files: allFiles });
  } catch (error) {
    logger.error('Error fetching files:', error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// Add files (image data)
app.post('/api/files', (req: Request, res: Response) => {
  try {
    const incoming = req.body.files;
    if (!incoming || typeof incoming !== 'object') {
      return res.status(400).json({ success: false, error: 'files object is required' });
    }

    const addedIds: string[] = [];
    for (const [id, fileData] of Object.entries(incoming)) {
      const file = fileData as ExcalidrawFile;
      files.set(id, {
        id,
        mimeType: file.mimeType || 'image/png',
        dataURL: file.dataURL,
        created: file.created || Date.now(),
      });
      addedIds.push(id);
    }

    broadcast({
      type: 'files_added',
      files: incoming
    });

    res.json({ success: true, addedIds, count: addedIds.length });
  } catch (error) {
    logger.error('Error adding files:', error);
    res.status(400).json({ success: false, error: (error as Error).message });
  }
});

// Delete a file
app.delete('/api/files/:id', (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (!files.has(id!)) {
      return res.status(404).json({ success: false, error: `File ${id} not found` });
    }
    files.delete(id!);
    broadcast({ type: 'file_deleted', fileId: id });
    res.json({ success: true, message: `File ${id} deleted` });
  } catch (error) {
    logger.error('Error deleting file:', error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// Image export: request (MCP -> Express -> WebSocket -> Frontend)
interface PendingExport {
  resolve: (data: { format: string; data: string }) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}
const pendingExports = new Map<string, PendingExport>();

app.post('/api/export/image', (req: Request, res: Response) => {
  try {
    const { format, background, captureViewport } = req.body;

    if (!format || !['png', 'svg'].includes(format)) {
      return res.status(400).json({
        success: false,
        error: 'format must be "png" or "svg"'
      });
    }

    if (wsToConnection.size === 0) {
      return res.status(503).json({
        success: false,
        error: 'No frontend client connected. Open the canvas in a browser first.'
      });
    }

    const requestId = generateId();
    const scope = resolveScope(req);

    const exportPromise = new Promise<{ format: string; data: string }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingExports.delete(requestId);
        reject(new Error('Export timed out after 30 seconds'));
      }, 30000);

      pendingExports.set(requestId, { resolve, reject, timeout });
    });

    broadcastToScope(scope.tenantId, scope.projectId, {
      type: 'export_image_request',
      requestId,
      format,
      background: background ?? true,
      captureViewport: captureViewport ?? false
    });

    exportPromise
      .then(result => {
        res.json({
          success: true,
          format: result.format,
          data: result.data
        });
      })
      .catch(error => {
        res.status(500).json({
          success: false,
          error: (error as Error).message
        });
      });
  } catch (error) {
    logger.error('Error initiating image export:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Image export: result (Frontend -> Express -> MCP)
app.post('/api/export/image/result', (req: Request, res: Response) => {
  try {
    const { requestId, format, data, error } = req.body;

    if (!requestId) {
      return res.status(400).json({
        success: false,
        error: 'requestId is required'
      });
    }

    const pending = pendingExports.get(requestId);
    if (!pending) {
      // Already resolved by another client, or expired — ignore silently
      return res.json({ success: true });
    }

    if (error) {
      // Don't reject on error — another WebSocket client may still succeed.
      // The timeout will handle the case where ALL clients fail.
      logger.warn(`Export error from one client (requestId=${requestId}): ${error}`);
      return res.json({ success: true });
    }

    clearTimeout(pending.timeout);
    pendingExports.delete(requestId);
    pending.resolve({ format, data });

    res.json({ success: true });
  } catch (error) {
    logger.error('Error processing export result:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Viewport control: request (MCP -> Express -> WebSocket -> Frontend)
interface PendingViewport {
  resolve: (data: { success: boolean; message: string }) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}
const pendingViewports = new Map<string, PendingViewport>();

app.post('/api/viewport', (req: Request, res: Response) => {
  try {
    const { scrollToContent, scrollToElementId, zoom, offsetX, offsetY } = req.body;

    if (wsToConnection.size === 0) {
      return res.status(503).json({
        success: false,
        error: 'No frontend client connected. Open the canvas in a browser first.'
      });
    }

    const requestId = generateId();
    const scope = resolveScope(req);

    const viewportPromise = new Promise<{ success: boolean; message: string }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingViewports.delete(requestId);
        reject(new Error('Viewport request timed out after 10 seconds'));
      }, 10000);

      pendingViewports.set(requestId, { resolve, reject, timeout });
    });

    broadcastToScope(scope.tenantId, scope.projectId, {
      type: 'set_viewport',
      requestId,
      scrollToContent,
      scrollToElementId,
      zoom,
      offsetX,
      offsetY
    });

    viewportPromise
      .then(result => {
        res.json(result);
      })
      .catch(error => {
        res.status(500).json({
          success: false,
          error: (error as Error).message
        });
      });
  } catch (error) {
    logger.error('Error initiating viewport change:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Viewport control: result (Frontend -> Express -> MCP)
app.post('/api/viewport/result', (req: Request, res: Response) => {
  try {
    const { requestId, success, message, error } = req.body;

    if (!requestId) {
      return res.status(400).json({
        success: false,
        error: 'requestId is required'
      });
    }

    const pending = pendingViewports.get(requestId);
    if (!pending) {
      return res.json({ success: true });
    }

    if (error) {
      clearTimeout(pending.timeout);
      pendingViewports.delete(requestId);
      pending.resolve({ success: false, message: error });
      return res.json({ success: true });
    }

    clearTimeout(pending.timeout);
    pendingViewports.delete(requestId);
    pending.resolve({ success: true, message: message || 'Viewport updated' });

    res.json({ success: true });
  } catch (error) {
    logger.error('Error processing viewport result:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Snapshots: save
app.post('/api/snapshots', (req: Request, res: Response) => {
  try {
    const projId = resolveTenantProject(req);
    const { name } = req.body;

    if (!name || typeof name !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Snapshot name is required'
      });
    }

    const allElements = store.getAllElements(projId);
    store.saveSnapshot(name, allElements, projId);
    logger.info(`Snapshot saved: "${name}" with ${allElements.length} elements`);

    res.json({
      success: true,
      name,
      elementCount: allElements.length,
      createdAt: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Error saving snapshot:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Snapshots: list
app.get('/api/snapshots', (req: Request, res: Response) => {
  try {
    const projId = resolveTenantProject(req);
    const list = store.listSnapshots(projId);

    res.json({
      success: true,
      snapshots: list,
      count: list.length
    });
  } catch (error) {
    logger.error('Error listing snapshots:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Snapshots: get by name
app.get('/api/snapshots/:name', (req: Request, res: Response) => {
  try {
    const projId = resolveTenantProject(req);
    const { name } = req.params;
    const snapshot = store.getSnapshot(name!, projId);

    if (!snapshot) {
      return res.status(404).json({
        success: false,
        error: `Snapshot "${name}" not found`
      });
    }

    res.json({
      success: true,
      snapshot
    });
  } catch (error) {
    logger.error('Error fetching snapshot:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Serve the frontend
app.get('/', (req: Request, res: Response) => {
  const htmlFile = path.join(__dirname, '../dist/frontend/index.html');
  res.sendFile(htmlFile, (err) => {
    if (err) {
      logger.error('Error serving frontend:', err);
      res.status(404).send('Frontend not found. Please run "npm run build" first.');
    }
  });
});

// ── Tenant API ──

app.get('/api/tenants', (req: Request, res: Response) => {
  try {
    const tenants = dbListTenants();
    const active = dbGetActiveTenant();
    res.json({ success: true, tenants, activeTenantId: active.id });
  } catch (error) {
    logger.error('Error listing tenants:', error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

app.get('/api/tenant/active', (req: Request, res: Response) => {
  try {
    const tenant = dbGetActiveTenant();
    res.json({ success: true, tenant });
  } catch (error) {
    logger.error('Error getting active tenant:', error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

app.put('/api/tenant/active', (req: Request, res: Response) => {
  try {
    const { tenantId } = req.body;
    if (!tenantId || typeof tenantId !== 'string') {
      return res.status(400).json({ success: false, error: 'tenantId is required' });
    }

    dbSetActiveTenant(tenantId);
    const tenant = dbGetActiveTenant();

    broadcast({
      type: 'tenant_switched',
      tenant: { id: tenant.id, name: tenant.name, workspace_path: tenant.workspace_path }
    });

    res.json({ success: true, tenant });
  } catch (error) {
    logger.error('Error switching tenant:', error);
    res.status(400).json({ success: false, error: (error as Error).message });
  }
});

// ── Settings API ──

app.get('/api/settings/:key', (req: Request, res: Response) => {
  try {
    const { key } = req.params;
    const value = store.getSetting(key!);
    res.json({ success: true, key, value: value ?? null });
  } catch (error) {
    logger.error('Error reading setting:', error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

app.put('/api/settings/:key', (req: Request, res: Response) => {
  try {
    const { key } = req.params;
    const { value } = req.body;
    if (value === undefined || value === null) {
      return res.status(400).json({ success: false, error: 'value is required' });
    }
    store.setSetting(key!, String(value));
    res.json({ success: true, key, value: String(value) });
  } catch (error) {
    logger.error('Error writing setting:', error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// Health check endpoint
app.get('/health', (req: Request, res: Response) => {
  const projId = resolveTenantProject(req);
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    elements_count: store.getElementCount(projId),
    websocket_clients: wsToConnection.size
  });
});

// Sync status endpoint
app.get('/api/sync/status', (req: Request, res: Response) => {
  const projId = resolveTenantProject(req);
  res.json({
    success: true,
    elementCount: store.getElementCount(projId),
    timestamp: new Date().toISOString(),
    memoryUsage: {
      heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024), // MB
      heapTotal: Math.round(process.memoryUsage().heapTotal / 1024 / 1024), // MB
    },
    websocketClients: wsToConnection.size
  });
});

// Error handling middleware
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

// Server configuration
const PORT = parseInt(process.env.CANVAS_PORT || process.env.PORT || '3000', 10);
const HOST = process.env.HOST || 'localhost';

/** Track whether we own the canvas server or are reusing an existing one. */
let canvasServerOwned = false;

export function isCanvasServerOwned(): boolean {
  return canvasServerOwned;
}

export async function startCanvasServer(): Promise<void> {
  // Ensure the database is initialized when running standalone (e.g. Docker: `node dist/server.js`).
  // When launched via index.ts (MCP entry point), initDb() is a no-op on the second call.
  initDb();

  // Pre-flight: check if an existing healthy canvas server is already on this port.
  // We do this BEFORE calling httpServer.listen() because Node's listen() can emit
  // EADDRINUSE as an uncaught exception that bypasses our error handler.
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`http://${HOST}:${PORT}/health`, { signal: controller.signal as any });
    clearTimeout(timeout);
    const body = await res.json() as any;
    if (body?.status === 'healthy') {
      logger.info(`Reusing existing canvas server on port ${PORT} (elements: ${body.elements_count}, ws clients: ${body.websocket_clients})`);
      return; // reuse — skip listen entirely
    }
  } catch {
    // No server on this port (connection refused) or not a canvas server — proceed to start our own
  }

  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      httpServer.removeListener('error', onError);
      reject(err);
    };
    httpServer.on('error', onError);

    httpServer.listen(PORT, HOST, () => {
      httpServer.removeListener('error', onError);
      resolve();
    });
  });
  canvasServerOwned = true;
  logger.info(`Canvas server running on http://${HOST}:${PORT}`);
  logger.info(`WebSocket server running on ws://${HOST}:${PORT}`);
}

export function stopCanvasServer(): Promise<void> {
  if (!canvasServerOwned) {
    logger.info('Canvas server not owned by this process, skipping shutdown');
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    for (const conn of wsToConnection.values()) conn.ws.close();
    httpServer.close(() => resolve());
  });
}

// Direct execution: `node dist/server.js` still works standalone
function isServerMainModule(): boolean {
  try {
    const ourPath = fs.realpathSync(fileURLToPath(import.meta.url));
    const argPath = process.argv[1];
    if (!argPath) return false;
    return ourPath === fs.realpathSync(path.resolve(argPath));
  } catch {
    return false;
  }
}

if (isServerMainModule()) {
  startCanvasServer().catch((err) => {
    logger.error('Failed to start canvas server:', err);
    process.exit(1);
  });
}

export default app;