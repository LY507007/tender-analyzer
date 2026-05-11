import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

await import(pathToFileURL("C:/Users/sheng.liu/Documents/Codex/2026-05-12/https-github-com-ly507007-tender-analyzer/frontend/doc-extract.js"));

const filePath = "C:/Users/sheng.liu/Desktop/王翠君/广东省能源集团西南（贵州）有限公司黔粤清洁能源分公司劳保用品采购项目询价书-报审版.doc";
const buffer = readFileSync(filePath);
const html = readFileSync(new URL("../frontend/index.html", import.meta.url), "utf8");

assert.match(html, /accept="[^"]*\.doc,\.docx/);
assert.match(html, /doc-extract\.js/);

assert.equal(globalThis.LegacyDocExtractor.isLegacyDoc(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)), true);

const text = globalThis.LegacyDocExtractor.extractText(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));

assert.match(text, /广东省能源集团/);
assert.match(text, /劳保用品采购项目/);
assert.match(text, /询价书/);
assert.ok(text.length > 500, `expected meaningful extracted text, got ${text.length} chars`);
