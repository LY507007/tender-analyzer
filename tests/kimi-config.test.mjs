import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../frontend/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../frontend/index.html", import.meta.url), "utf8");

assert.match(app, /https:\/\/api\.kimi\.com\/coding\/v1/);
assert.match(app, /KIMI_MODEL\s*=\s*"kimi-for-coding"/);
assert.match(app, /normalizeKimiEndpoint/);
assert.doesNotMatch(app, /api\.minimax\.chat|MiniMax-M2\.7|MiniMax-Text-01/);
assert.doesNotMatch(app, /api\.moonshot\.cn|kimi-k2\.6/);
assert.doesNotMatch(html, /MiniMax|MiniMax-M2\.7|MiniMax-Text-01|minimax-key-input/);
assert.match(html, /Kimi API Key/);
assert.match(html, /Kimi Code \(K2\.6\)/);
assert.match(html, /proxy-url-input/);
