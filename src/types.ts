export interface ExcalidrawElementBase {
  id: string;
  type: ExcalidrawElementType;
  x: number;
  y: number;
  width?: number;
  height?: number;
  angle?: number;
  strokeColor?: string;
  backgroundColor?: string;
  fillStyle?: string;
  strokeWidth?: number;
  strokeStyle?: string;
  roughness?: number;
  opacity?: number;
  groupIds?: string[];
  frameId?: string | null;
  roundness?: {
    type: number;
    value?: number;
  } | null;
  seed?: number;
  versionNonce?: number;
  isDeleted?: boolean;
  locked?: boolean;
  link?: string | null;
  customData?: Record<string, any> | null;
  boundElements?: readonly ExcalidrawBoundElement[] | null;
  updated?: number;
  containerId?: string | null;
}

export interface ExcalidrawTextElement extends ExcalidrawElementBase {
  type: 'text';
  text: string;
  fontSize?: number;
  fontFamily?: number;
  textAlign?: string;
  verticalAlign?: string;
  baseline?: number;
  lineHeight?: number;
}

export interface ExcalidrawRectangleElement extends ExcalidrawElementBase {
  type: 'rectangle';
  width: number;
  height: number;
}

export interface ExcalidrawEllipseElement extends ExcalidrawElementBase {
  type: 'ellipse';
  width: number;
  height: number;
}

export interface ExcalidrawDiamondElement extends ExcalidrawElementBase {
  type: 'diamond';
  width: number;
  height: number;
}

export interface ExcalidrawArrowElement extends ExcalidrawElementBase {
  type: 'arrow';
  points: readonly [number, number][];
  lastCommittedPoint?: readonly [number, number] | null;
  startBinding?: ExcalidrawBinding | null;
  endBinding?: ExcalidrawBinding | null;
  startArrowhead?: string | null;
  endArrowhead?: string | null;
}

export interface ExcalidrawLineElement extends ExcalidrawElementBase {
  type: 'line';
  points: readonly [number, number][];
  lastCommittedPoint?: readonly [number, number] | null;
  startBinding?: ExcalidrawBinding | null;
  endBinding?: ExcalidrawBinding | null;
}

export interface ExcalidrawFreedrawElement extends ExcalidrawElementBase {
  type: 'freedraw';
  points: readonly [number, number][];
  pressures?: readonly number[];
  simulatePressure?: boolean;
  lastCommittedPoint?: readonly [number, number] | null;
}

export type ExcalidrawElement = 
  | ExcalidrawTextElement
  | ExcalidrawRectangleElement
  | ExcalidrawEllipseElement
  | ExcalidrawDiamondElement
  | ExcalidrawArrowElement
  | ExcalidrawLineElement
  | ExcalidrawFreedrawElement;

export interface ExcalidrawBoundElement {
  id: string;
  type: 'text' | 'arrow';
}

export interface ExcalidrawBinding {
  elementId: string;
  focus: number;
  gap: number;
  fixedPoint?: readonly [number, number] | null;
}

export type ExcalidrawElementType = 'rectangle' | 'ellipse' | 'diamond' | 'arrow' | 'text' | 'line' | 'freedraw' | 'image';

// Excalidraw element types
export const EXCALIDRAW_ELEMENT_TYPES: Record<string, ExcalidrawElementType> = {
  RECTANGLE: 'rectangle',
  ELLIPSE: 'ellipse',
  DIAMOND: 'diamond',
  ARROW: 'arrow',
  TEXT: 'text',
  FREEDRAW: 'freedraw',
  LINE: 'line',
  IMAGE: 'image'
} as const;

// Server-side element with metadata
export interface ServerElement extends Omit<ExcalidrawElementBase, 'id'> {
  id: string;
  type: ExcalidrawElementType;
  createdAt?: string;
  updatedAt?: string;
  version?: number;
  syncedAt?: string;
  source?: string;
  syncTimestamp?: string;
  text?: string;
  fontSize?: number;
  fontFamily?: string | number;
  label?: {
    text: string;
  };
  points?: any;
  originalText?: string;
  // Arrow element binding: connect arrows to shapes by element ID
  start?: { id: string };
  end?: { id: string };
  startBinding?: ExcalidrawBinding | null;
  endBinding?: ExcalidrawBinding | null;
  // Image element properties
  fileId?: string;
  status?: string;
  scale?: [number, number];
}

// API Response types
export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface ElementsResponse extends ApiResponse {
  elements: ServerElement[];
  count: number;
}

export interface ElementResponse extends ApiResponse {
  element: ServerElement;
}

export interface SyncResponse extends ApiResponse {
  count: number;
  syncedAt: string;
  beforeCount: number;
  afterCount: number;
}

// WebSocket message types
export interface WebSocketMessage {
  type: WebSocketMessageType;
  [key: string]: any;
}

export type WebSocketMessageType =
  | 'initial_elements'
  | 'element_created'
  | 'element_updated'
  | 'element_deleted'
  | 'elements_batch_created'
  | 'elements_synced'
  | 'sync_status'
  | 'mermaid_convert'
  | 'canvas_cleared'
  | 'export_image_request'
  | 'set_viewport'
  | 'tenant_switched'
  | 'files_added'
  | 'file_deleted'
  | 'hello'
  | 'hello_ack'
  | 'ack';

// Connection registry types
export interface ClientConnection {
  ws: import('ws').WebSocket;
  tenantId: string;
  projectId: string;
  connectedAt: number;
  identified: boolean;  // true after hello handshake
}

export interface BroadcastResult {
  delivered: number;
  msgId: string;
  reason?: string;
}

export interface HelloMessage extends WebSocketMessage {
  type: 'hello';
  tenantId: string;
  projectId: string;
}

export interface HelloAckMessage extends WebSocketMessage {
  type: 'hello_ack';
  tenantId: string;
  projectId: string;
  elements: ServerElement[];
}

export interface AckMessage extends WebSocketMessage {
  type: 'ack';
  msgId: string;
  status: 'applied' | 'partial' | 'failed';
  elementCount?: number;
  expectedCount?: number;
}

export interface InitialElementsMessage extends WebSocketMessage {
  type: 'initial_elements';
  elements: ServerElement[];
}

export interface ElementCreatedMessage extends WebSocketMessage {
  type: 'element_created';
  element: ServerElement;
}

export interface ElementUpdatedMessage extends WebSocketMessage {
  type: 'element_updated';
  element: ServerElement;
}

export interface ElementDeletedMessage extends WebSocketMessage {
  type: 'element_deleted';
  elementId: string;
}

export interface BatchCreatedMessage extends WebSocketMessage {
  type: 'elements_batch_created';
  elements: ServerElement[];
}

export interface SyncStatusMessage extends WebSocketMessage {
  type: 'sync_status';
  elementCount: number;
  timestamp: string;
}

export interface MermaidConvertMessage extends WebSocketMessage {
  type: 'mermaid_convert';
  mermaidDiagram: string;
  config?: MermaidConfig;
  timestamp: string;
}

// Mermaid conversion types
export interface MermaidConfig {
  startOnLoad?: boolean;
  flowchart?: {
    curve?: 'linear' | 'basis';
  };
  themeVariables?: {
    fontSize?: string;
  };
  maxEdges?: number;
  maxTextSize?: number;
}

export interface MermaidConversionRequest {
  mermaidDiagram: string;
  config?: MermaidConfig;
}

export interface MermaidConversionResponse extends ApiResponse {
  elements: ServerElement[];
  files?: any;
  count: number;
}

// Canvas cleared message
export interface CanvasClearedMessage extends WebSocketMessage {
  type: 'canvas_cleared';
  timestamp: string;
}

// Image export types
export interface ExportImageRequestMessage extends WebSocketMessage {
  type: 'export_image_request';
  requestId: string;
  format: 'png' | 'svg';
  background?: boolean;
}

// Viewport control types
export interface SetViewportMessage extends WebSocketMessage {
  type: 'set_viewport';
  requestId: string;
  scrollToContent?: boolean;
  scrollToElementId?: string;
  zoom?: number;
  offsetX?: number;
  offsetY?: number;
}

// Tenant switched message
export interface TenantSwitchedMessage extends WebSocketMessage {
  type: 'tenant_switched';
  tenant: {
    id: string;
    name: string;
    workspace_path: string;
  };
}

// Snapshot types
export interface Snapshot {
  name: string;
  elements: ServerElement[];
  createdAt: string;
}

// Excalidraw file (image) data — stored in-memory alongside element data
export interface ExcalidrawFile {
  mimeType: string;
  id: string;
  dataURL: string;
  created: number;
  lastRetrieved?: number;
}

// In-memory file storage (image files are too large for SQLite row storage)
export const files = new Map<string, ExcalidrawFile>();

// ── Font families — single source of truth ──────────────────────────────
// IDs match the @excalidraw/excalidraw FONT_FAMILY constant.
// The canonical data lives in font-families.json; every other file derives from it.
import fontData from './font-families.json' with { type: 'json' };

export interface FontFamilyDef {
  id: number;
  name: string;
  label: string;
  aliases: string[];
  legacy?: boolean;         // hidden from setup menus / tool docs
}

export const FONT_FAMILIES: FontFamilyDef[] = fontData.fonts as FontFamilyDef[];

export const DEFAULT_FONT_FAMILY: number = fontData.defaultFontFamily;

// Derived: description string for MCP tool schemas
export const FONT_FAMILY_DESCRIPTION =
  'Font family: ' +
  FONT_FAMILIES.filter(f => !f.legacy).map(f => `${f.id}=${f.name}`).join(', ') +
  '. Accepts name strings too.';

// Derived: string → number mapping for normalization
const FONT_FAMILY_MAP: Record<string, number> = {};
for (const font of FONT_FAMILIES) {
  for (const alias of font.aliases) {
    FONT_FAMILY_MAP[alias] = font.id;
  }
}

export function normalizeFontFamily(value: string | number | undefined): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number') return value;
  const mapped = FONT_FAMILY_MAP[value.toLowerCase().trim()];
  if (mapped !== undefined) return mapped;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? 1 : parsed;
}

// Storage is now handled by src/db.ts (SQLite).
// The Map exports below are kept only for backward compatibility with
// standalone server.ts usage; they are NOT used when the DB is active.

// Validation function for Excalidraw elements
export function validateElement(element: Partial<ServerElement>): element is ServerElement {
  const requiredFields: (keyof ServerElement)[] = ['type', 'x', 'y'];
  const hasRequiredFields = requiredFields.every(field => field in element);
  
  if (!hasRequiredFields) {
    throw new Error(`Missing required fields: ${requiredFields.join(', ')}`);
  }

  if (!Object.values(EXCALIDRAW_ELEMENT_TYPES).includes(element.type as ExcalidrawElementType)) {
    throw new Error(`Invalid element type: ${element.type}`);
  }

  return true;
}

// Helper function to generate unique IDs
export function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2);
}