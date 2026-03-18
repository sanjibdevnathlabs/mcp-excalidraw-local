import React, { useState, useEffect, useRef } from 'react'
import {
  Excalidraw,
  convertToExcalidrawElements,
  CaptureUpdateAction,
  ExcalidrawImperativeAPI,
  exportToBlob,
  exportToSvg
} from '@excalidraw/excalidraw'
import type { ExcalidrawElement, NonDeleted, NonDeletedExcalidrawElement } from '@excalidraw/excalidraw/types/element/types'
import { convertMermaidToExcalidraw, DEFAULT_MERMAID_CONFIG } from './utils/mermaidConverter'
import type { MermaidConfig } from '@excalidraw/mermaid-to-excalidraw'
import {
  cleanElementForExcalidraw,
  validateAndFixBindings,
  computeElementHash,
  isImageElement,
  normalizeImageElement,
  restoreBindings
} from './utils/elementHelpers'
import type { ServerElement } from './utils/elementHelpers'

type ExcalidrawAPIRefValue = ExcalidrawImperativeAPI;

interface WebSocketMessage {
  type: string;
  element?: ServerElement;
  elements?: ServerElement[];
  elementId?: string;
  count?: number;
  timestamp?: string;
  source?: string;
  mermaidDiagram?: string;
  config?: MermaidConfig;
  files?: Record<string, any>;
  [key: string]: any;
}

interface ApiResponse {
  success: boolean;
  elements?: ServerElement[];
  element?: ServerElement;
  count?: number;
  error?: string;
  message?: string;
}

type SyncStatus = 'idle' | 'syncing';

interface TenantInfo {
  id: string;
  name: string;
  workspace_path: string;
}

function App(): JSX.Element {
  const [excalidrawAPI, setExcalidrawAPI] = useState<ExcalidrawAPIRefValue | null>(null)
  const excalidrawAPIRef = useRef<ExcalidrawAPIRefValue | null>(null)
  const [isConnected, setIsConnected] = useState<boolean>(false)
  const websocketRef = useRef<WebSocket | null>(null)
  
  // Sync state
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('idle')
  const [autoSave, setAutoSave] = useState<boolean>(() => {
    const stored = localStorage.getItem('excalidraw-autosave')
    return stored === null ? true : stored === 'true'
  })
  const isSyncingRef = useRef<boolean>(false)
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastSyncedHashRef = useRef<string>('')
  const lastSyncVersionRef = useRef<number>(
    parseInt(localStorage.getItem('excalidraw-last-sync-version') ?? '0', 10)
  )
  const lastSyncedElementsRef = useRef<Map<string, ServerElement>>(new Map())
  const lastReceivedSyncVersionRef = useRef<number>(0)
  const isResyncingRef = useRef<boolean>(false)

  const DEBOUNCE_MS = 3000

  // Tenant state
  const [activeTenant, setActiveTenant] = useState<TenantInfo | null>(null)
  const activeTenantIdRef = useRef<string | null>(null)
  const [tenantList, setTenantList] = useState<TenantInfo[]>([])
  const [menuOpen, setMenuOpen] = useState<boolean>(false)
  const [tenantSearch, setTenantSearch] = useState<string>('')
  const searchInputRef = useRef<HTMLInputElement | null>(null)

  // Keep refs in sync so closures (WebSocket handlers) always see latest values
  useEffect(() => {
    excalidrawAPIRef.current = excalidrawAPI
  }, [excalidrawAPI])
  useEffect(() => {
    activeTenantIdRef.current = activeTenant?.id ?? null
  }, [activeTenant])

  // Build headers with tenant ID for all fetch calls to the backend
  const tenantHeaders = (extra?: Record<string, string>): Record<string, string> => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...extra
    }
    const tid = activeTenantIdRef.current
    if (tid) headers['X-Tenant-Id'] = tid
    return headers
  }

  // WebSocket connection
  useEffect(() => {
    connectWebSocket()
    return () => {
      if (websocketRef.current) {
        websocketRef.current.close()
      }
    }
  }, [])

  // Load existing elements when Excalidraw API becomes available
  useEffect(() => {
    if (excalidrawAPI) {
      loadExistingElements()
      
      // Ensure WebSocket is connected for real-time updates
      if (!isConnected) {
        connectWebSocket()
      }
    }
  }, [excalidrawAPI, isConnected])

  // Persist auto-save preference and cancel pending timer when toggled off
  const toggleAutoSave = () => {
    setAutoSave(prev => {
      const next = !prev
      localStorage.setItem('excalidraw-autosave', String(next))
      if (!next && debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
        debounceTimerRef.current = null
      }
      return next
    })
  }

  // Clean up debounce timer on unmount
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current)
    }
  }, [])

  // Trailing debounce: resets on every change, fires after user is idle.
  // Only active when auto-save is on.
  const handleCanvasChange = (): void => {
    if (!autoSave) return

    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current)

    debounceTimerRef.current = setTimeout(() => {
      if (!excalidrawAPI || isSyncingRef.current) return

      const elements = excalidrawAPI.getSceneElements()
      const hash = computeElementHash(elements)
      if (hash === lastSyncedHashRef.current) return

      syncToBackend()
    }, DEBOUNCE_MS)
  }

  const convertElementsPreservingImageProps = (
    cleanedElements: any[]
  ): any[] => {
    const imageElements = cleanedElements.filter(isImageElement)
    const nonImageElements = cleanedElements.filter(el => !isImageElement(el))

    let convertedNonImage: any[] = []
    if (nonImageElements.length > 0) {
      convertedNonImage = convertToExcalidrawElements(nonImageElements, { regenerateIds: false }) as any[]
      convertedNonImage = restoreBindings(convertedNonImage, nonImageElements)
    }

    const normalizedImages = imageElements.map(normalizeImageElement)

    return [...convertedNonImage, ...normalizedImages]
  }

  const loadExistingElements = async (): Promise<void> => {
    try {
      const response = await fetch('/api/elements', { headers: tenantHeaders() })
      const result: ApiResponse = await response.json()

      if (result.success && result.elements) {
        if (result.elements.length === 0) {
          excalidrawAPI?.updateScene({ elements: [] })
          lastSyncedElementsRef.current = new Map()
          return
        }
        const cleanedElements = result.elements.map(cleanElementForExcalidraw)
        const hasNativeFormat = cleanedElements.some((el: any) => el.containerId)
        if (hasNativeFormat) {
          const validated = validateAndFixBindings(cleanedElements)
          excalidrawAPI?.updateScene({ elements: validated as any })
        } else {
          const convertedElements = convertElementsPreservingImageProps(cleanedElements)
          excalidrawAPI?.updateScene({ elements: convertedElements })
        }

        // Populate sync baseline so deletions are detected on next sync
        const baselineMap = new Map<string, ServerElement>()
        for (const el of result.elements) {
          baselineMap.set(el.id, el)
        }
        lastSyncedElementsRef.current = baselineMap
      }

      // Fetch current sync version so delta sync works correctly
      try {
        const versionRes = await fetch('/api/sync/version', { headers: tenantHeaders() })
        const versionData = await versionRes.json()
        if (versionData.success && typeof versionData.syncVersion === 'number') {
          lastSyncVersionRef.current = versionData.syncVersion
          lastReceivedSyncVersionRef.current = versionData.syncVersion
          localStorage.setItem('excalidraw-last-sync-version', String(versionData.syncVersion))
        }
      } catch {}

      // Set hash baseline so auto-sync doesn't immediately re-sync unchanged content
      if (excalidrawAPI) {
        const sceneElements = excalidrawAPI.getSceneElements()
        lastSyncedHashRef.current = computeElementHash(sceneElements)
      }

      // Also load files (image data)
      try {
        const filesRes = await fetch('/api/files', { headers: tenantHeaders() })
        const filesData = await filesRes.json()
        if (filesData.success && filesData.files) {
          const fileValues = Object.values(filesData.files) as any[]
          if (fileValues.length > 0 && excalidrawAPI) {
            excalidrawAPI.addFiles(fileValues)
          }
        }
      } catch {}
    } catch (error) {
      console.error('Error loading existing elements:', error)
    }
  }

  const connectWebSocket = (): void => {
    if (websocketRef.current && websocketRef.current.readyState === WebSocket.OPEN) {
      return
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${protocol}//${window.location.host}`
    
    websocketRef.current = new WebSocket(wsUrl)
    
    websocketRef.current.onopen = () => {
      setIsConnected(true)
      
      if (excalidrawAPI) {
        setTimeout(loadExistingElements, 100)
      }
    }
    
    websocketRef.current.onmessage = (event: MessageEvent) => {
      try {
        const data: WebSocketMessage = JSON.parse(event.data)
        handleWebSocketMessage(data)
      } catch (error) {
        console.error('Error parsing WebSocket message:', error, event.data)
      }
    }
    
    websocketRef.current.onclose = (event: CloseEvent) => {
      setIsConnected(false)
      
      // Reconnect after 3 seconds if not a clean close
      if (event.code !== 1000) {
        setTimeout(connectWebSocket, 3000)
      }
    }
    
    websocketRef.current.onerror = (error: Event) => {
      console.error('WebSocket error:', error)
      setIsConnected(false)
    }
  }

  const sendHello = (tenantId: string): void => {
    const ws = websocketRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ type: 'hello', tenantId }))
  }

  const sendAck = (msgId: string | undefined, status: 'applied' | 'partial' | 'failed', elementCount?: number, expectedCount?: number): void => {
    if (!msgId) return
    const ws = websocketRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ type: 'ack', msgId, status, elementCount, expectedCount }))
  }

  const triggerDeltaResync = async (): Promise<void> => {
    if (isResyncingRef.current) return
    isResyncingRef.current = true
    try {
      const response = await fetch('/api/elements/sync/v2', {
        method: 'POST',
        headers: tenantHeaders(),
        body: JSON.stringify({
          lastSyncVersion: lastReceivedSyncVersionRef.current,
          changes: []
        })
      })
      if (response.ok) {
        const data = await response.json() as {
          currentSyncVersion: number
          serverChanges: { id: string; action: string; element: any; sync_version: number }[]
        }
        const api = excalidrawAPIRef.current
        if (api && data.serverChanges.length > 0) {
          const scene = api.getSceneElements()
          let merged = [...scene]
          for (const sc of data.serverChanges) {
            if (sc.action === 'delete') {
              merged = merged.filter(el => el.id !== sc.id)
            } else if (sc.element) {
              const cleaned = cleanElementForExcalidraw(sc.element)
              const converted = convertToExcalidrawElements([cleaned], { regenerateIds: false })
              const idx = merged.findIndex(el => el.id === sc.id)
              if (idx >= 0) {
                merged[idx] = converted[0]!
              } else {
                merged.push(...converted)
              }
            }
          }
          api.updateScene({ elements: merged, captureUpdate: CaptureUpdateAction.NEVER })
        }
        lastReceivedSyncVersionRef.current = data.currentSyncVersion
        lastSyncVersionRef.current = data.currentSyncVersion
        localStorage.setItem('excalidraw-last-sync-version', String(data.currentSyncVersion))
        // Update sync baseline so deletion detection works after resync
        if (api) {
          const activeElements = api.getSceneElements().filter(el => !el.isDeleted)
          const baselineMap = new Map<string, any>()
          for (const el of normalizeForBackend(activeElements)) {
            baselineMap.set(el.id, el)
          }
          lastSyncedElementsRef.current = baselineMap
          lastSyncedHashRef.current = computeElementHash(api.getSceneElements())
        }
        console.log(`Delta resync complete: received ${data.serverChanges.length} changes, now at v${data.currentSyncVersion}`)
      }
    } catch (err) {
      console.error('Delta resync failed:', err)
    } finally {
      isResyncingRef.current = false
    }
  }

  const handleWebSocketMessage = async (data: WebSocketMessage): Promise<void> => {
    // Gap detection (Task 12): if a message carries sync_version, check for gaps
    if (data.sync_version !== undefined && typeof data.sync_version === 'number') {
      const expected = lastReceivedSyncVersionRef.current + 1
      if (data.sync_version > expected && lastReceivedSyncVersionRef.current > 0) {
        console.warn(`Sync gap: expected v${expected}, got v${data.sync_version}. Triggering resync.`)
        triggerDeltaResync()
        return // resync will fetch everything including this message's changes
      }
      lastReceivedSyncVersionRef.current = data.sync_version
    }

    const api = excalidrawAPIRef.current
    if (!api) {
      sendAck(data.msgId, 'failed')
      return
    }

    try {
      const currentElements = api.getSceneElements()

      switch (data.type) {
        case 'initial_elements':
          if (data.elements && data.elements.length > 0) {
            const cleanedElements = data.elements.map(cleanElementForExcalidraw)
            const validatedElements = validateAndFixBindings(cleanedElements)
            const convertedElements = convertElementsPreservingImageProps(validatedElements)
            api.updateScene({
              elements: convertedElements,
              captureUpdate: CaptureUpdateAction.NEVER
            })
            // Update sync baseline for deletion detection
            const initBaseline = new Map<string, any>()
            for (const el of data.elements) {
              initBaseline.set(el.id, el)
            }
            lastSyncedElementsRef.current = initBaseline
          }
          break

        case 'element_created':
          if (data.element) {
            const cleanedNewElement = cleanElementForExcalidraw(data.element)
            const hasBindings = (cleanedNewElement as any).start || (cleanedNewElement as any).end
            if (hasBindings) {
              const allElements = [...currentElements, cleanedNewElement] as any[]
              const convertedAll = convertToExcalidrawElements(allElements, { regenerateIds: false })
              api.updateScene({
                elements: convertedAll,
                captureUpdate: CaptureUpdateAction.NEVER
              })
            } else {
              const newElement = convertToExcalidrawElements([cleanedNewElement], { regenerateIds: false })
              const updatedElementsAfterCreate = [...currentElements, ...newElement]
              api.updateScene({
                elements: updatedElementsAfterCreate,
                captureUpdate: CaptureUpdateAction.NEVER
              })
            }
            const scene = api.getSceneElements()
            const landed = scene.some(s => s.id === data.element!.id)
            sendAck(data.msgId, landed ? 'applied' : 'failed', landed ? 1 : 0, 1)
          }
          break
          
        case 'element_updated':
          if (data.element) {
            const cleanedUpdatedElement = cleanElementForExcalidraw(data.element)
            const convertedUpdatedElement = convertToExcalidrawElements([cleanedUpdatedElement], { regenerateIds: false })[0]
            const updatedElements = currentElements.map(el =>
              el.id === data.element!.id ? convertedUpdatedElement : el
            )
            api.updateScene({
              elements: updatedElements,
              captureUpdate: CaptureUpdateAction.NEVER
            })
            sendAck(data.msgId, 'applied', 1, 1)
          }
          break

        case 'element_deleted':
          if (data.elementId) {
            const filteredElements = currentElements.filter(el => el.id !== data.elementId)
            api.updateScene({
              elements: filteredElements,
              captureUpdate: CaptureUpdateAction.NEVER
            })
            sendAck(data.msgId, 'applied', 1, 1)
          }
          break

        case 'elements_batch_created':
          if (data.elements) {
            const cleanedBatchElements = data.elements.map(cleanElementForExcalidraw)
            const hasBoundArrows = cleanedBatchElements.some((el: any) => el.start || el.end)
            if (hasBoundArrows) {
              const allElements = [...currentElements, ...cleanedBatchElements] as any[]
              const convertedAll = convertElementsPreservingImageProps(allElements)
              api.updateScene({
                elements: convertedAll,
                captureUpdate: CaptureUpdateAction.NEVER
              })
            } else {
              const batchElements = convertElementsPreservingImageProps(cleanedBatchElements)
              const updatedElementsAfterBatch = [...currentElements, ...batchElements]
              api.updateScene({
                elements: updatedElementsAfterBatch,
                captureUpdate: CaptureUpdateAction.NEVER
              })
            }
            // Verify elements landed in the scene
            const scene = api.getSceneElements()
            const expectedIds = data.elements.map((e: ServerElement) => e.id)
            const landedCount = expectedIds.filter(id => scene.some(s => s.id === id)).length
            const status = landedCount === expectedIds.length ? 'applied' : landedCount > 0 ? 'partial' : 'failed'
            sendAck(data.msgId, status, landedCount, expectedIds.length)
          }
          break
          
        case 'elements_synced':
          console.log(`Sync confirmed by server: ${data.count} elements`)
          break
          
        case 'sync_status':
          console.log(`Server sync status: ${data.count} elements`)
          break
          
        case 'canvas_cleared':
          console.log('Canvas cleared by server')
          api.updateScene({
            elements: [],
            captureUpdate: CaptureUpdateAction.NEVER
          })
          sendAck(data.msgId, 'applied')
          break

        case 'export_image_request':
          console.log('Received image export request', data)
          if (data.requestId) {
            try {
              // Viewport capture: grab the rendered canvas DOM element directly
              // This captures exactly what the user sees, respecting zoom/scroll.
              if (data.captureViewport && data.format !== 'svg') {
                const canvasEl = document.querySelector('.excalidraw__canvas') as HTMLCanvasElement
                  ?? document.querySelector('canvas') as HTMLCanvasElement
                if (canvasEl) {
                  const dataUrl = canvasEl.toDataURL('image/png')
                  const base64 = dataUrl.split(',')[1]
                  if (base64) {
                    await fetch('/api/export/image/result', {
                      method: 'POST',
                      headers: tenantHeaders(),
                      body: JSON.stringify({
                        requestId: data.requestId,
                        format: 'png',
                        data: base64
                      })
                    })
                    console.log('Viewport screenshot captured for request', data.requestId)
                    break
                  }
                }
                // Fall through to exportToBlob if canvas capture failed
                console.warn('Viewport canvas capture failed, falling back to exportToBlob')
              }

              const elements = api.getSceneElements()
              const appState = api.getAppState()
              const files = api.getFiles()

              if (data.format === 'svg') {
                const svg = await exportToSvg({
                  elements,
                  appState: {
                    ...appState,
                    exportBackground: data.background !== false
                  },
                  files
                })
                const svgString = new XMLSerializer().serializeToString(svg)
                await fetch('/api/export/image/result', {
                  method: 'POST',
                  headers: tenantHeaders(),
                  body: JSON.stringify({
                    requestId: data.requestId,
                    format: 'svg',
                    data: svgString
                  })
                })
              } else {
                const blob = await exportToBlob({
                  elements,
                  appState: {
                    ...appState,
                    exportBackground: data.background !== false
                  },
                  files,
                  mimeType: 'image/png'
                })
                const reader = new FileReader()
                reader.onload = async () => {
                  try {
                    const resultString = reader.result as string
                    const base64 = resultString?.split(',')[1]
                    if (!base64) {
                      throw new Error('Could not extract base64 data from result')
                    }
                    await fetch('/api/export/image/result', {
                      method: 'POST',
                      headers: tenantHeaders(),
                      body: JSON.stringify({
                        requestId: data.requestId,
                        format: 'png',
                        data: base64
                      })
                    })
                  } catch (readerError) {
                    console.error('Image export (FileReader) failed:', readerError)
                    await fetch('/api/export/image/result', {
                      method: 'POST',
                      headers: tenantHeaders(),
                      body: JSON.stringify({
                        requestId: data.requestId,
                        error: (readerError as Error).message
                      })
                    }).catch(() => {})
                  }
                }
                reader.onerror = async () => {
                  console.error('FileReader error:', reader.error)
                  await fetch('/api/export/image/result', {
                    method: 'POST',
                    headers: tenantHeaders(),
                    body: JSON.stringify({
                      requestId: data.requestId,
                      error: reader.error?.message || 'FileReader failed'
                    })
                  }).catch(() => {})
                }
                reader.readAsDataURL(blob)
              }
              console.log('Image export completed for request', data.requestId)
            } catch (exportError) {
              console.error('Image export failed:', exportError)
              await fetch('/api/export/image/result', {
                method: 'POST',
                headers: tenantHeaders(),
                body: JSON.stringify({
                  requestId: data.requestId,
                  error: (exportError as Error).message
                })
              })
            }
          }
          break

        case 'set_viewport':
          console.log('Received viewport control request', data)
          if (data.requestId) {
            try {
              if (data.scrollToContent) {
                const allElements = api.getSceneElements()
                if (allElements.length > 0) {
                  api.scrollToContent(allElements, { fitToViewport: true, animate: false })
                }
              } else if (data.scrollToElementId) {
                const allElements = api.getSceneElements()
                const targetElement = allElements.find(el => el.id === data.scrollToElementId)
                if (targetElement) {
                  api.scrollToContent([targetElement], { fitToViewport: false, animate: false })
                } else {
                  throw new Error(`Element ${data.scrollToElementId} not found`)
                }
              } else {
                const appState: any = {}
                if (data.zoom !== undefined) {
                  appState.zoom = { value: data.zoom }
                }
                if (data.offsetX !== undefined) {
                  appState.scrollX = data.offsetX
                }
                if (data.offsetY !== undefined) {
                  appState.scrollY = data.offsetY
                }
                if (Object.keys(appState).length > 0) {
                  api.updateScene({ appState })
                }
              }

              await fetch('/api/viewport/result', {
                method: 'POST',
                headers: tenantHeaders(),
                body: JSON.stringify({
                  requestId: data.requestId,
                  success: true,
                  message: 'Viewport updated'
                })
              })
            } catch (viewportError) {
              console.error('Viewport control failed:', viewportError)
              await fetch('/api/viewport/result', {
                method: 'POST',
                headers: tenantHeaders(),
                body: JSON.stringify({
                  requestId: data.requestId,
                  error: (viewportError as Error).message
                })
              }).catch(() => {})
            }
          }
          break

        case 'mermaid_convert':
          console.log('Received Mermaid conversion request from MCP')
          if (data.mermaidDiagram) {
            try {
              const result = await convertMermaidToExcalidraw(data.mermaidDiagram, data.config || DEFAULT_MERMAID_CONFIG)

              if (result.error) {
                console.error('Mermaid conversion error:', result.error)
                return
              }

              if (result.elements && result.elements.length > 0) {
                const convertedElements = convertToExcalidrawElements(result.elements, { regenerateIds: false })
                api.updateScene({
                  elements: convertedElements,
                  captureUpdate: CaptureUpdateAction.IMMEDIATELY
                })

                if (result.files) {
                  api.addFiles(Object.values(result.files))
                }

                console.log('Mermaid diagram converted successfully:', result.elements.length, 'elements')

                // Sync to backend automatically after creating elements
                await syncToBackend()
              }
            } catch (error) {
              console.error('Error converting Mermaid diagram from WebSocket:', error)
            }
          }
          break
          
        case 'files_added':
          if (data.files && typeof data.files === 'object') {
            const fileValues = Object.values(data.files) as any[]
            if (fileValues.length > 0) {
              api.addFiles(fileValues)
            }
          }
          break

        case 'file_deleted':
          break

        case 'tenant_switched':
          console.log('Tenant switched:', data.tenant)
          if (data.tenant) {
            const incoming = data.tenant as TenantInfo
            // Send hello to register WS connection under the correct tenant scope
            sendHello(incoming.id)
            if (incoming.id !== activeTenantIdRef.current) {
              activeTenantIdRef.current = incoming.id
              setActiveTenant(incoming)
              api.updateScene({
                elements: [],
                captureUpdate: CaptureUpdateAction.NEVER
              })
              lastSyncedHashRef.current = ''
              loadExistingElements()
            } else {
              setActiveTenant(incoming)
            }
          }
          break

        case 'hello_ack':
          console.log('Hello acknowledged by server:', data.tenantId, data.projectId)
          if (data.elements && Array.isArray(data.elements) && data.elements.length > 0) {
            const converted = convertToExcalidrawElements(data.elements)
            api.updateScene({
              elements: converted,
              captureUpdate: CaptureUpdateAction.NEVER
            })
            // Update sync baseline for deletion detection
            const helloBaseline = new Map<string, any>()
            for (const el of data.elements) {
              helloBaseline.set(el.id, el)
            }
            lastSyncedElementsRef.current = helloBaseline
          } else if (data.elements && data.elements.length === 0) {
            lastSyncedElementsRef.current = new Map()
          }
          break

        default:
          console.log('Unknown WebSocket message type:', data.type)
      }
    } catch (error) {
      console.error('Error processing WebSocket message:', error, data)
    }
  }

  // Normalize Excalidraw native elements back to MCP format for backend storage.
  // Excalidraw internally splits label text out of containers into separate text
  // elements linked by containerId/boundElements. This causes text to detach on
  // reload because convertToExcalidrawElements doesn't reconstruct that binding.
  // Fix: merge bound text back into container label.text so the backend always
  // stores MCP format that round-trips cleanly.
  const normalizeForBackend = (elements: readonly ExcalidrawElement[]): ServerElement[] => {
    const elementMap = new Map<string, ExcalidrawElement>()
    for (const el of elements) elementMap.set(el.id, el)

    // Collect IDs of text elements that are bound inside a container
    const boundTextIds = new Set<string>()
    // Map containerId → text content for merging
    const containerTextMap = new Map<string, { text: string; fontSize?: number; fontFamily?: number }>()

    for (const el of elements) {
      const cid = (el as any).containerId
      if (el.type === 'text' && cid && elementMap.has(cid)) {
        boundTextIds.add(el.id)
        containerTextMap.set(cid, {
          text: (el as any).text || (el as any).originalText || '',
          fontSize: (el as any).fontSize,
          fontFamily: (el as any).fontFamily,
        })
      }
    }

    const result: ServerElement[] = []
    for (const el of elements) {
      if (boundTextIds.has(el.id)) continue // skip bound text — merged into container

      const out: any = { ...el }

      // If this container has bound text, put it back as label.text
      const merged = containerTextMap.get(el.id)
      if (merged && merged.text) {
        out.label = { text: merged.text }
        if (merged.fontSize) out.fontSize = merged.fontSize
        if (merged.fontFamily) out.fontFamily = merged.fontFamily
        // Clean up Excalidraw-internal binding metadata
        delete out.boundElements
      }

      // Normalize arrow bindings from Excalidraw format back to MCP format
      if (el.type === 'arrow') {
        const startBinding = (el as any).startBinding
        const endBinding = (el as any).endBinding
        if (startBinding?.elementId) out.start = { id: startBinding.elementId }
        if (endBinding?.elementId) out.end = { id: endBinding.elementId }
      }

      result.push(out as ServerElement)
    }
    return result
  }

  // Toast message shown briefly in the center of the header
  const [toast, setToast] = useState<string | null>(null)
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const showToast = (msg: string, durationMs = 2000) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    setToast(msg)
    toastTimerRef.current = setTimeout(() => setToast(null), durationMs)
  }

  // Fetch list of tenants for the menu
  const fetchTenants = async () => {
    try {
      const res = await fetch('/api/tenants', { headers: tenantHeaders() })
      if (!res.ok) return
      const data = await res.json()
      if (data.success) {
        setTenantList(data.tenants)
      }
    } catch (err) {
      console.error('Failed to fetch tenants:', err)
    }
  }

  // Switch active tenant via API, then reload canvas with new tenant's elements
  const switchTenant = async (tenantId: string) => {
    if (tenantId === activeTenantIdRef.current) {
      setMenuOpen(false)
      return
    }

    try {
      const res = await fetch('/api/tenant/active', {
        method: 'PUT',
        headers: tenantHeaders(),
        body: JSON.stringify({ tenantId })
      })
      if (!res.ok) return

      // Update ref immediately so subsequent fetch uses the new tenant
      activeTenantIdRef.current = tenantId

      // Clear the canvas before loading the new tenant's elements
      excalidrawAPI?.updateScene({
        elements: [],
        captureUpdate: CaptureUpdateAction.NEVER
      })
      lastSyncedHashRef.current = ''

      // Update React state (will also re-sync the ref via useEffect, which is fine)
      const tenant = tenantList.find(t => t.id === tenantId)
      if (tenant) setActiveTenant(tenant)

      setMenuOpen(false)

      // Load elements for the newly-active tenant
      const elemRes = await fetch('/api/elements', {
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-Id': tenantId
        }
      })
      const result: ApiResponse = await elemRes.json()
      if (result.success && result.elements && result.elements.length > 0) {
        const cleanedElements = result.elements.map(cleanElementForExcalidraw)
        const hasNativeFormat = cleanedElements.some((el: any) => el.containerId)
        if (hasNativeFormat) {
          const validated = validateAndFixBindings(cleanedElements)
          excalidrawAPI?.updateScene({ elements: validated as any })
        } else {
          const convertedElements = convertToExcalidrawElements(cleanedElements, { regenerateIds: false })
          excalidrawAPI?.updateScene({ elements: convertedElements })
        }
      }

      showToast('Workspace switched')
    } catch (err) {
      console.error('Failed to switch tenant:', err)
    }
  }

  const syncToBackend = async (): Promise<void> => {
    if (!excalidrawAPI || isSyncingRef.current) return

    isSyncingRef.current = true
    setSyncStatus('syncing')

    try {
      const currentElements = excalidrawAPI.getSceneElements()
      const activeElements = currentElements.filter(el => !el.isDeleted)
      const backendElements = normalizeForBackend(activeElements)

      // Compute delta: what changed since last sync
      const changes: { id: string; action: string; element?: any }[] = []
      const currentMap = new Map<string, any>()
      for (const el of backendElements) {
        currentMap.set(el.id, el)
        const prev = lastSyncedElementsRef.current.get(el.id)
        if (!prev || JSON.stringify(prev) !== JSON.stringify(el)) {
          changes.push({ id: el.id, action: 'upsert', element: el })
        }
      }
      // Detect deletions: elements in last sync but not current
      for (const [id] of lastSyncedElementsRef.current) {
        if (!currentMap.has(id)) {
          changes.push({ id, action: 'delete' })
        }
      }

      const response = await fetch('/api/elements/sync/v2', {
        method: 'POST',
        headers: tenantHeaders(),
        body: JSON.stringify({
          lastSyncVersion: lastSyncVersionRef.current,
          changes
        })
      })

      if (response.ok) {
        const result = await response.json() as {
          currentSyncVersion: number
          serverChanges: { id: string; action: string; element: any; sync_version: number }[]
          appliedCount: number
        }

        // Apply server-side changes (MCP-created elements, other tabs' changes)
        if (result.serverChanges.length > 0) {
          const api = excalidrawAPIRef.current
          if (api) {
            const scene = api.getSceneElements()
            let merged = [...scene]
            for (const sc of result.serverChanges) {
              if (sc.action === 'delete') {
                merged = merged.filter(el => el.id !== sc.id)
              } else if (sc.element) {
                const cleaned = cleanElementForExcalidraw(sc.element)
                const converted = convertToExcalidrawElements([cleaned], { regenerateIds: false })
                const idx = merged.findIndex(el => el.id === sc.id)
                if (idx >= 0) {
                  merged[idx] = converted[0]!
                } else {
                  merged.push(...converted)
                }
              }
            }
            api.updateScene({ elements: merged, captureUpdate: CaptureUpdateAction.NEVER })
          }
        }

        // Update tracking state
        lastSyncVersionRef.current = result.currentSyncVersion
        localStorage.setItem('excalidraw-last-sync-version', String(result.currentSyncVersion))
        lastSyncedElementsRef.current = currentMap
        lastSyncedHashRef.current = computeElementHash(currentElements)
        setSyncStatus('idle')
        showToast('Saved')
        console.log(`Delta sync: ${result.appliedCount} applied, ${result.serverChanges.length} received from server`)
      } else {
        setSyncStatus('idle')
        showToast('Sync failed', 3000)
        console.error('Sync failed:', (await response.json() as ApiResponse).error)
      }
    } catch (error) {
      setSyncStatus('idle')
      showToast('Sync failed', 3000)
      console.error('Sync error:', error)
    } finally {
      isSyncingRef.current = false
    }
  }

  // Clear canvas confirmation state (UI button only)
  const [showClearConfirm, setShowClearConfirm] = useState(false)
  const [clearSkipConfirm, setClearSkipConfirm] = useState(false)
  const [dontAskAgain, setDontAskAgain] = useState(false)

  // Load "skip confirm" preference from backend on mount
  useEffect(() => {
    fetch('/api/settings/clear_canvas_skip_confirm')
      .then(r => r.json())
      .then(data => {
        if (data.value === 'true') setClearSkipConfirm(true)
      })
      .catch(() => {})
  }, [])

  const handleClearCanvasClick = () => {
    if (clearSkipConfirm) {
      performClearCanvas()
    } else {
      setDontAskAgain(false)
      setShowClearConfirm(true)
    }
  }

  const handleClearConfirm = async () => {
    if (dontAskAgain) {
      setClearSkipConfirm(true)
      try {
        await fetch('/api/settings/clear_canvas_skip_confirm', {
          method: 'PUT',
          headers: tenantHeaders(),
          body: JSON.stringify({ value: 'true' })
        })
      } catch {}
    }
    setShowClearConfirm(false)
    performClearCanvas()
  }

  const performClearCanvas = async (): Promise<void> => {
    if (excalidrawAPI) {
      try {
        const response = await fetch('/api/elements', { headers: tenantHeaders() })
        const result: ApiResponse = await response.json()
        
        if (result.success && result.elements) {
          const deletePromises = result.elements.map(element => 
            fetch(`/api/elements/${element.id}`, { method: 'DELETE', headers: tenantHeaders() })
          )
          await Promise.all(deletePromises)
        }
        
        excalidrawAPI.updateScene({ 
          elements: [],
          captureUpdate: CaptureUpdateAction.IMMEDIATELY
        })
      } catch (error) {
        console.error('Error clearing canvas:', error)
        excalidrawAPI.updateScene({ 
          elements: [],
          captureUpdate: CaptureUpdateAction.IMMEDIATELY
        })
      }
    }
  }

  return (
    <div className="app">
      {/* Header */}
      <div className="header">
        <div className="header-left">
          <h1>Excalidraw Canvas</h1>
          {activeTenant && (
            <button
              className="tenant-badge-btn"
              onClick={() => {
                setMenuOpen(o => {
                  if (!o) {
                    setTenantSearch('')
                    fetchTenants()
                    setTimeout(() => searchInputRef.current?.focus(), 80)
                  }
                  return !o
                })
              }}
              title="Switch workspace"
            >
              <span className="tenant-label">Workspace:</span> {activeTenant.name} ▾
            </button>
          )}
        </div>

        {toast && <div className="toast">{toast}</div>}

        <div className="controls">
          <div className="status">
            <div className={`status-dot ${isConnected ? 'status-connected' : 'status-disconnected'}`}></div>
            <span>{isConnected ? 'Connected' : 'Disconnected'}</span>
          </div>
          
          <div className="btn-group">
            <button
              className={`btn-group-item ${syncStatus === 'syncing' ? 'btn-group-busy' : ''}`}
              onClick={syncToBackend}
              disabled={syncStatus === 'syncing' || !excalidrawAPI}
            >
              {syncStatus === 'syncing' ? 'Syncing...' : 'Sync'}
            </button>
            <button
              className="btn-group-item"
              onClick={toggleAutoSave}
              title={autoSave ? 'Auto-sync is on — click to turn off' : 'Auto-sync is off — click to turn on'}
            >
              {autoSave ? 'Auto ✓' : 'Auto ✗'}
            </button>
          </div>
          
          <button className="btn-secondary" onClick={handleClearCanvasClick}>Clear Canvas</button>
        </div>
      </div>

      {/* Tenant menu overlay */}
      {menuOpen && (() => {
        const q = tenantSearch.toLowerCase()
        const filtered = q
          ? tenantList.filter(t => t.name.toLowerCase().includes(q) || t.workspace_path.toLowerCase().includes(q))
          : tenantList
        return (
          <div className="menu-overlay" onClick={() => setMenuOpen(false)}>
            <div className="menu-panel" onClick={e => e.stopPropagation()}>
              <div className="menu-header">Workspaces</div>
              <div className="menu-search-wrap">
                <input
                  ref={searchInputRef}
                  className="menu-search"
                  type="text"
                  placeholder="Search workspaces..."
                  value={tenantSearch}
                  onChange={e => setTenantSearch(e.target.value)}
                />
              </div>
              <div className="menu-list">
                {filtered.map(t => (
                  <button
                    key={t.id}
                    className={`menu-item ${activeTenant?.id === t.id ? 'menu-item-active' : ''}`}
                    onClick={() => switchTenant(t.id)}
                  >
                    <span className="menu-item-name">{t.name}</span>
                    <span className="menu-item-path" title={t.workspace_path}>
                      {t.workspace_path.length > 40
                        ? '...' + t.workspace_path.slice(-37)
                        : t.workspace_path}
                    </span>
                    {activeTenant?.id === t.id && <span className="menu-item-check">✓</span>}
                  </button>
                ))}
                {filtered.length === 0 && <div className="menu-empty">No matching workspaces</div>}
              </div>
            </div>
          </div>
        )
      })()}

      {/* Clear canvas confirmation modal (UI button only) */}
      {showClearConfirm && (
        <div className="menu-overlay" onClick={() => setShowClearConfirm(false)}>
          <div className="confirm-dialog" onClick={e => e.stopPropagation()}>
            <div className="confirm-title">Clear Canvas</div>
            <p className="confirm-msg">This will permanently delete all elements. Continue?</p>
            <label className="confirm-checkbox-label">
              <input
                type="checkbox"
                checked={dontAskAgain}
                onChange={e => setDontAskAgain(e.target.checked)}
              />
              Don't ask again
            </label>
            <div className="confirm-actions">
              <button className="btn-secondary" onClick={() => setShowClearConfirm(false)}>Cancel</button>
              <button className="btn-danger" onClick={handleClearConfirm}>Clear</button>
            </div>
          </div>
        </div>
      )}

      {/* Canvas Container */}
      <div className="canvas-container">
        <Excalidraw
          excalidrawAPI={(api: ExcalidrawAPIRefValue) => setExcalidrawAPI(api)}
          initialData={{
            elements: [],
            appState: {
              theme: 'light',
              viewBackgroundColor: '#ffffff'
            }
          }}
          onChange={handleCanvasChange}
        />
      </div>
    </div>
  )
}

export default App
