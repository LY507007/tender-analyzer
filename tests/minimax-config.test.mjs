import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../frontend/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../frontend/index.html", import.meta.url), "utf8");

assert.match(app, /https:\/\/api\.minimax\.chat\/v1/);
assert.match(app, /MINIMAX_MODEL\s*=\s*"MiniMax-M2\.7"/);
assert.match(app, /settings\.minimaxKey/);
assert.doesNotMatch(app, /api\.kimi\.com|api\.moonshot\.cn|kimi-for-coding|kimi-k2\.6|proxyUrl|normalizeKimiEndpoint/);
assert.doesNotMatch(html, /Kimi|proxy-url-input|代理地址/);
assert.match(html, /MiniMax API Key/);
assert.match(html, /MiniMax-M2\.7/);
