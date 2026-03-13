import { initDb } from '../../dist/db.js';
import { startCanvasServer } from '../../dist/server.js';

const dbPath = process.env.EXCALIDRAW_DB_PATH || '/tmp/excalidraw-e2e-test.db';
initDb(dbPath);
await startCanvasServer();
