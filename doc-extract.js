(function (root) {
  const LEGACY_DOC_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  const MIN_RUN_LENGTH = 18;
  const MIN_TEXT_LENGTH = 80;

  function toUint8Array(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    throw new Error("无法读取 .doc 文件内容");
  }

  function isLegacyDoc(input) {
    const bytes = toUint8Array(input);
    return LEGACY_DOC_SIGNATURE.every((byte, index) => bytes[index] === byte);
  }

  function isReadableCodePoint(code) {
    return (
      code === 0x0009 ||
      code === 0x000a ||
      code === 0x000c ||
      code === 0x000d ||
      (code >= 0x0020 && code <= 0x007e) ||
      (code >= 0x00a0 && code <= 0x024f) ||
      (code >= 0x2000 && code <= 0x206f) ||
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff00 && code <= 0xffef)
    );
  }

  function normalizeChar(code) {
    if (code === 0x000c) return "\n";
    return String.fromCharCode(code);
  }

  function hasTextSignal(text) {
    const cjk = (text.match(/[\u3400-\u9fff]/g) || []).length;
    const latin = (text.match(/[A-Za-z]/g) || []).length;
    const digits = (text.match(/\d/g) || []).length;
    return cjk >= 2 || latin + digits >= 12;
  }

  function cleanText(text) {
    return text
      .replace(/\u0000/g, "")
      .replace(/[ \t　]+/g, " ")
      .replace(/[ \t　]*\r?\n[ \t　]*/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function scanUtf16Runs(bytes, offset) {
    const runs = [];
    let current = "";

    function flush() {
      const text = cleanText(current);
      if (text.length >= MIN_RUN_LENGTH && hasTextSignal(text)) {
        runs.push(text);
      }
      current = "";
    }

    for (let i = offset; i + 1 < bytes.length; i += 2) {
      const code = bytes[i] | (bytes[i + 1] << 8);
      if (isReadableCodePoint(code)) {
        current += normalizeChar(code);
      } else {
        flush();
      }
    }
    flush();
    return runs;
  }

  function decodeGb18030(bytes) {
    if (typeof TextDecoder === "undefined") return "";
    try {
      return new TextDecoder("gb18030", { fatal: false }).decode(bytes);
    } catch (_) {
      return "";
    }
  }

  function scanDecodedText(text) {
    const runs = [];
    let current = "";

    function flush() {
      const cleaned = cleanText(current);
      if (cleaned.length >= MIN_RUN_LENGTH && hasTextSignal(cleaned)) {
        runs.push(cleaned);
      }
      current = "";
    }

    for (const char of text) {
      const code = char.codePointAt(0);
      if (code && isReadableCodePoint(code)) {
        current += char;
      } else {
        flush();
      }
    }
    flush();
    return runs;
  }

  function compactRuns(runs) {
    const seen = new Set();
    const kept = [];
    for (const run of runs) {
      const normalized = cleanText(run);
      if (!normalized) continue;
      const key = normalized.slice(0, 160);
      if (seen.has(key)) continue;
      seen.add(key);
      kept.push(normalized);
    }
    return cleanText(kept.join("\n\n"));
  }

  function extractText(input) {
    const bytes = toUint8Array(input);
    if (!isLegacyDoc(bytes)) {
      throw new Error("不是有效的旧版 .doc 文件");
    }

    const utf16Text = compactRuns([
      ...scanUtf16Runs(bytes, 0),
      ...scanUtf16Runs(bytes, 1),
    ]);

    if (utf16Text.length >= MIN_TEXT_LENGTH) return utf16Text;

    const gbText = compactRuns(scanDecodedText(decodeGb18030(bytes)));
    if (gbText.length >= MIN_TEXT_LENGTH) return gbText;

    throw new Error("未能从旧版 .doc 文件中提取到足够文本，请尝试另存为 .docx 或 PDF");
  }

  root.LegacyDocExtractor = { isLegacyDoc, extractText };
})(typeof globalThis !== "undefined" ? globalThis : window);
