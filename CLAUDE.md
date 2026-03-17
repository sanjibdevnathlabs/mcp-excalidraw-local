# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A fully local, self-hosted Excalidraw MCP server. Single Node.js process that runs an MCP server (stdio, 32 tools), an embedded Express+WebSocket canvas server, and SQLite persistence with multi-tenancy. Forked from [yctimlin/mcp_excalidraw](https://github.com/yctimlin/mcp_excalidraw).

## Build & Development Commands

```bash
# Install dependencies (pnpm preferred, npm works too)
pnpm install
pnpm rebuild better-sqlite3 esbuild

# Full build (frontend + server)
pnpm run build

# Build only server (TypeScript)
pnpm run build:server        # npx tsc

# Build only frontend (Vite/React)
pnpm run build:frontend      # vite build

# Type check without emit
pnpm run type-check           # npx tsc --noEmit

# Dev mode (watch server + Vite dev server on :5173)
pnpm run dev

# Run the MCP server (starts MCP stdio + canvas on :3000)
node dist/index.js

# Run canvas server standalone
node dist/server.js

# Health check
curl http://localhost:3000/health
```

There are no unit tests. Validation is done via type checking (`pnpm run type-check`) and build verification. The CI runs `type-check` then `build` across Node 18/20/22.

## Architecture

**Single process, three subsystems:**

```
src/index.ts   ── MCP Server (stdio) ── 32 tools, connects to canvas via HTTP
  ├── imports server.ts  ── Canvas Server (Express + WebSocket on CANVAS_PORT)
  ├── imports db.ts      ── SQLite layer (better-sqlite3, WAL mode)
  └── imports types.ts   ── Shared types, element validation, ID generation

frontend/      ── React + Excalidraw UI (Vite build → dist/frontend/)
  ├── src/App.tsx   ── Main component, WS connection, auto-sync, workspace switcher
  └── src/main.tsx  ── Entry point
```

**Data flow:** MCP tool call → `index.ts` handler → HTTP to canvas REST API (`server.ts`) → SQLite (`db.ts`) + WebSocket broadcast → frontend updates.

**Key design decisions:**
- Canvas server is embedded in the MCP process — `startCanvasServer()` is called from `runServer()`. If port is taken by an existing healthy instance, it reuses it instead of crashing.
- Multi-tenancy: workspace path → SHA-256 hash (12 chars) → tenant ID. Each tenant has isolated projects/elements. Tenant auto-detected via `server.listRoots()` after MCP connection.
- All element data stored as JSON blobs in SQLite `elements.data` column. FTS5 virtual table for full-text search on labels.
- Logging goes to file (`excalidraw.log`) at debug level, only warn+error to stderr (to avoid breaking stdio JSON protocol).

## Source Files

| File | Purpose |
|------|---------|
| `src/index.ts` (~2540 lines) | MCP server entry point. Tool definitions, tool handlers, tenant bootstrap, server lifecycle. |
| `src/server.ts` (~1155 lines) | Express canvas server. REST API, WebSocket, Zod schemas, arrow binding resolution, image export relay. |
| `src/db.ts` (~510 lines) | SQLite persistence. Migrations, CRUD, FTS, versioning, snapshots, tenants, projects. |
| `src/types.ts` (~315 lines) | TypeScript interfaces for elements, WebSocket messages, API responses. `generateId()` and `validateElement()`. |
| `src/utils/logger.ts` | Winston logger config (file + stderr). |
| `frontend/src/App.tsx` | React Excalidraw wrapper with WS sync, auto-sync, workspace switcher. |
| `vite.config.js` | Frontend build config. Root=`frontend/`, output=`dist/frontend/`. Dev proxy to `:3000`. |

## Environment Variables

| Variable | Default | Notes |
|----------|---------|-------|
| `CANVAS_PORT` | `3000` | Canvas server port |
| `EXCALIDRAW_DB_PATH` | `~/.excalidraw-mcp/excalidraw.db` | SQLite database location |
| `EXCALIDRAW_EXPORT_DIR` | `process.cwd()` | Allowed directory for file exports (path traversal protection) |
| `EXPRESS_SERVER_URL` | `http://localhost:{CANVAS_PORT}` | Only needed if running canvas separately |
| `LOG_FILE_PATH` | `excalidraw.log` | Winston log file |
| `LOG_LEVEL` | `info` | Winston log level |

## TypeScript Configuration

- ESM modules (`"type": "module"` in package.json, `"module": "ESNext"` in tsconfig)
- Strict mode enabled with `noUncheckedIndexedAccess`
- Target ES2022, output to `dist/`
- All `.js` imports in source use `.js` extension (ESM requirement)

## Key Patterns

- **Canvas sync is fire-and-forget**: MCP tool handlers call canvas REST API but don't fail if canvas is unavailable. The `syncToCanvas()` helper catches errors and returns null.
- **Tenant-scoped operations**: Every REST endpoint resolves tenant via `X-Tenant-Id` header → `resolveTenantProject()` → project ID. Browser requests (no header) fall back to global active state.
- **Arrow binding**: `startElementId`/`endElementId` on arrows are resolved to edge-point coordinates in `resolveArrowBindings()` (server.ts). The server computes intersection points for rectangle/ellipse/diamond shapes.
- **Image export relay**: MCP → REST `/api/export/image` → WebSocket broadcast → frontend renders → POST back to `/api/export/image/result` → resolves pending promise.
- **Element versioning**: Every create/update/delete records a version in `element_versions` table. Soft-delete pattern (`is_deleted` flag).

## Docker

Two Dockerfiles: `Dockerfile` (MCP server only), `Dockerfile.canvas` (canvas with frontend). `docker-compose.yml` orchestrates both with a `full` profile.


## Code Search Optimization

When exploring or understanding code in supported languages (JS, TS, Python, Go, Rust, Java, C, C++, Ruby):
- Use `smart_search(query, path)` instead of Grep+Glob chains for discovering functions/classes/symbols
- Use `smart_outline(file_path)` instead of Read to understand file structure (~1-2K tokens vs ~12K+)
- Use `smart_unfold(file_path, symbol_name)` instead of Read for viewing specific functions (~400-2K tokens)
- Fall back to Grep for exact string/regex searches, Read for non-code files and files under 100 lines
