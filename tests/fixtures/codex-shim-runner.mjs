// Test fixture (FEAT-18.7): the shim as the ClaudeRunner's «binary» in tests.
// The runner passes the CLI only an allow-listed environment (childEnv drops
// every TELEHARNESS_*), so TELEHARNESS_CODEX_BIN cannot reach the shim from the test process —
// this wrapper points it at the fake app-server and runs the shim's main().
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
process.env.TELEHARNESS_CODEX_BIN = path.join(HERE, "codex-appserver-fake.mjs");
const { main } = await import("../../lib/codex-shim.mjs");
await main(process.argv.slice(2));
