// Load the project-root .env no matter which folder `npm start` is run from.
// Imported first in server.js so every module sees the keys at import time.
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const result = dotenv.config({
  path: [path.join(here, ".env"), path.join(here, "..", ".env")],
  override: true,
  quiet: true,
});

const loaded = Object.keys(result.parsed || {}).length;
console.log(`[env] loaded ${loaded} variables`);
