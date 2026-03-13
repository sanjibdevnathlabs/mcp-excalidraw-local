import type { ExcalidrawElement } from '@excalidraw/excalidraw/types/element/types';

export interface ServerElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  backgroundColor?: string;
  strokeColor?: string;
  strokeWidth?: number;
  roughness?: number;
  opacity?: number;
  text?: string;
  fontSize?: number;
  fontFamily?: string | number;
  label?: { text: string };
  createdAt?: string;
  updatedAt?: string;
  version?: number;
  syncedAt?: string;
  source?: string;
  syncTimestamp?: string;
  boundElements?: any[] | null;
  containerId?: string | null;
  locked?: boolean;
  start?: { id: string };
  end?: { id: string };
  strokeStyle?: string;
  endArrowhead?: string;
  startArrowhead?: string;
  startBinding?: any;
  endBinding?: any;
  // Image element properties
  fileId?: string;
  status?: string;
  scale?: [number, number];
}

export const cleanElementForExcalidraw = (element: ServerElement): Partial<ExcalidrawElement> => {
  const {
    createdAt,
    updatedAt,
    version,
    syncedAt,
    source,
    syncTimestamp,
    ...cleanElement
  } = element;
  return cleanElement;
};

export const validateAndFixBindings = (elements: Partial<ExcalidrawElement>[]): Partial<ExcalidrawElement>[] => {
  const elementMap = new Map(elements.map(el => [el.id!, el]));

  return elements.map(element => {
    const fixedElement = { ...element };

    if (fixedElement.boundElements) {
      if (Array.isArray(fixedElement.boundElements)) {
        fixedElement.boundElements = fixedElement.boundElements.filter((binding: any) => {
          if (!binding || typeof binding !== 'object') return false;
          if (!binding.id || !binding.type) return false;
          const referencedElement = elementMap.get(binding.id);
          if (!referencedElement) return false;
          if (!['text', 'arrow'].includes(binding.type)) return false;
          return true;
        });

        if (fixedElement.boundElements.length === 0) {
          fixedElement.boundElements = null;
        }
      } else {
        fixedElement.boundElements = null;
      }
    }

    if (fixedElement.containerId) {
      const containerElement = elementMap.get(fixedElement.containerId);
      if (!containerElement) {
        fixedElement.containerId = null;
      }
    }

    return fixedElement;
  });
};

export const isImageElement = (el: Partial<ExcalidrawElement>): boolean => {
  return el.type === 'image';
};

const SHAPE_CONTAINER_TYPES = new Set([
  'rectangle', 'ellipse', 'diamond', 'arrow', 'line'
]);

export const isShapeContainerType = (type: string): boolean => {
  return SHAPE_CONTAINER_TYPES.has(type);
};

export const normalizeImageElement = (el: any): any => {
  return {
    ...el,
    type: 'image',
    status: el.status || 'saved',
    fileId: el.fileId || null,
    scale: el.scale || [1, 1],
    angle: el.angle ?? 0,
    strokeColor: el.strokeColor ?? 'transparent',
    backgroundColor: el.backgroundColor ?? 'transparent',
    fillStyle: el.fillStyle ?? 'hachure',
    strokeWidth: el.strokeWidth ?? 1,
    strokeStyle: el.strokeStyle ?? 'solid',
    roughness: el.roughness ?? 1,
    opacity: el.opacity ?? 100,
    groupIds: el.groupIds ?? [],
    roundness: el.roundness ?? null,
    isDeleted: el.isDeleted ?? false,
    boundElements: el.boundElements ?? null,
    locked: el.locked ?? false,
    link: el.link ?? null,
  };
};

export const restoreBindings = (
  convertedElements: any[],
  originalElements: any[]
): any[] => {
  const originalMap = new Map<string, any>();
  for (const el of originalElements) {
    if (el.id) originalMap.set(el.id, el);
  }

  return convertedElements.map(el => {
    const orig = originalMap.get(el.id);
    if (!orig) return el;

    const patched = { ...el };
    if (orig.startBinding !== undefined && !patched.startBinding) {
      patched.startBinding = orig.startBinding;
    }
    if (orig.endBinding !== undefined && !patched.endBinding) {
      patched.endBinding = orig.endBinding;
    }
    if (orig.boundElements !== undefined && !patched.boundElements) {
      patched.boundElements = orig.boundElements;
    }
    if (orig.elbowed !== undefined && patched.elbowed === undefined) {
      patched.elbowed = orig.elbowed;
    }
    return patched;
  });
};

export const computeElementHash = (elements: readonly { id: string; version: number }[]): string => {
  let h = String(elements.length);
  for (let i = 0; i < elements.length; i++) {
    h += elements[i]!.id;
    h += elements[i]!.version;
  }
  return h;
};
