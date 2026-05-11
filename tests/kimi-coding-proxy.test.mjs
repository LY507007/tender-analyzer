import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const worker = readFileSync(new URL("../workers/kimi-coding-proxy.js", import.meta.url), "utf8");

assert.match(worker, /https:\/\/api\.kimi\.com\/coding\/v1\/chat\/completions/);
assert.match(worker, /Access-Control-Allow-Origin/);
assert.match(worker, /Authorization/);
assert.match(worker, /OPTIONS/);
assert.doesNotMatch(worker, /api\.moonshot\.cn|kimi-k2\.6|api\.minimax\.chat/);
