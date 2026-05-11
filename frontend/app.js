// ===== AI 服务商配置 =====
const KIMI_BASE_URL = "https://api.moonshot.cn/v1";
const KIMI_MODEL = "kimi-k2.6";
const KIMI_MODEL_LABEL = "Kimi K2.6";

// ===== 设置 =====
const SETTINGS_KEY = "tenderSettings_kimi_v1";
let settings = { kimiKey: "" };

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    settings = { ...settings, ...s };
  } catch (_) {}
}

function saveSettingsToStorage() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function updateStatusBar() {
  const dot = document.getElementById("status-dot");
  const text = document.getElementById("status-text");
  if (settings.kimiKey) {
    dot.className = "status-dot ok";
    text.textContent = "Kimi 已配置";
  } else {
    dot.className = "status-dot warn";
    text.textContent = "未配置 API Key";
  }
}

// ===== PDF.js =====
pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js";

// ===== 浏览器端文件处理 =====

async function extractPDF(file, onStatus) {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  // 先尝试提取文字
  const parts = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    parts.push(content.items.map((item) => item.str).join(" "));
  }
  const text = parts.join("\n").trim();

  // 文字版 PDF → 直接返回文本
  if (text.length >= 50) {
    return { type: "text", content: text };
  }

  // 扫描件 → 逐页渲染为 PNG 图片，交由视觉模型处理
  const numPages = Math.min(pdf.numPages, 10);
  onStatus?.(`检测到扫描件，正在渲染 ${numPages} 页图片...`);
  const pages = [];
  for (let i = 1; i <= numPages; i++) {
    onStatus?.(`渲染第 ${i} / ${numPages} 页...`);
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    pages.push(canvas.toDataURL("image/png").split(",")[1]);
  }
  return { type: "images", pages, mediaType: "image/png" };
}

async function extractWord(file) {
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer });
  return { type: "text", content: result.value };
}

async function extractLegacyWord(file, onStatus) {
  onStatus?.("正在读取旧版 Word（.doc）文本...");
  const arrayBuffer = await file.arrayBuffer();
  if (!window.LegacyDocExtractor) {
    throw new Error("旧版 .doc 解析器未加载，请刷新页面后重试");
  }
  return { type: "text", content: window.LegacyDocExtractor.extractText(arrayBuffer) };
}

async function extractImage(file, onStatus) {
  onStatus?.("读取图片...");
  const base64 = await new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.readAsDataURL(file);
  });
  return { type: "images", pages: [base64], mediaType: file.type || "image/png" };
}

async function extractFileContent(file, onStatus) {
  const ext = file.name.split(".").pop().toLowerCase();
  if (ext === "pdf") return extractPDF(file, onStatus);
  if (ext === "doc") return extractLegacyWord(file, onStatus);
  if (ext === "docx") return extractWord(file);
  return extractImage(file, onStatus);
}

// ===== AI API 调用 =====
async function callAI(fileInfo, fields) {
  if (!settings.kimiKey) throw new Error("请先配置 Kimi API Key");

  const fieldsStr = fields.join("、");

  // 专业招投标文件提取 prompt —— 提供字段同义词和查找位置提示，大幅提升提取率
  const systemPrompt = `你是专业的中国政府采购和招投标文件信息提取专家。请仔细阅读文件全文，精确提取指定字段。

提取规则：
- 招标公司/采购单位：查找"招标人"、"采购人"、"甲方"、"委托单位"、"采购单位"附近内容
- 联系人：查找"联系人"、"经办人"、"联系方式"、"项目联系人"附近内容
- 电话：查找"联系电话"、"咨询电话"、"询价电话"、"传真"附近的号码
- 标的金额：查找"预算金额"、"最高限价"、"招标控制价"、"采购预算"、"预算总额"附近金额
- 标的产品范围：查找"采购内容"、"采购项目"、"标的物"、"货物清单"、"服务内容"附近内容
- 投标报名时间：查找"报名时间"、"报名截止"、"资格预审"附近日期
- 正式投标时间/开标时间：查找"开标时间"、"开标日期"、"评标时间"附近日期
- 截止投标时间：查找"投标截止"、"投标文件递交截止"、"递标截止"附近日期

字段格式约束（必须严格遵守）：
- 标的金额：仅返回整数数字（不含小数、不含单位），单位统一换算为元后取整。例如："150万元"→"1500000"，"50,000.00元"→"50000"，"约50万"→"500000"。若文件中确实没有任何金额信息，返回"无"
- 投标报名时间：仅返回日期，格式 YYYY-MM-DD，不含时分秒。若为时间范围则格式 YYYY-MM-DD:YYYY-MM-DD。例如："2026年1月23日至2026年1月29日"→"2026-01-23:2026-01-29"，"2026-02-03 09:30"→"2026-02-03"
- 正式投标时间：同上，格式 YYYY-MM-DD，时间范围用 YYYY-MM-DD:YYYY-MM-DD，不含时分秒
- 截止投标时间：同上，格式 YYYY-MM-DD，时间范围用 YYYY-MM-DD:YYYY-MM-DD，不含时分秒

输出规范：严格返回纯 JSON，不包含任何解释文字或 Markdown。格式：{"字段名": "值"}
注意：只有在文件中经过仔细搜索确实没有该信息时，才返回"未找到"。`;

  const userText =
    `请从以下招投标文件中提取这些字段：${fieldsStr}\n\n` +
    `严格返回 JSON 格式，示例：{"字段名": "提取值"}`;

  let messages;
  if (fileInfo.type === "text") {
    const content =
      fileInfo.content.length > 50000
        ? fileInfo.content.slice(0, 50000) + "\n...(内容已截断)"
        : fileInfo.content;
    messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: `${userText}\n\n文件内容：\n${content}` },
    ];
  } else {
    // 扫描件/图片 → 多图发给视觉模型
    const imageContents = fileInfo.pages.map((base64) => ({
      type: "image_url",
      image_url: { url: `data:${fileInfo.mediaType};base64,${base64}` },
    }));
    messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: [...imageContents, { type: "text", text: userText }] },
    ];
  }

  const resp = await fetch(`${KIMI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.kimiKey}`,
    },
    body: JSON.stringify({
      model: KIMI_MODEL,
      messages,
      max_tokens: 4096,
      thinking: { type: "disabled" },
    }),
  });

  if (!resp.ok) {
    const errData = await resp.json().catch(() => ({}));
    throw new Error(errData.error?.message || errData.message || `API 错误 ${resp.status}`);
  }

  const data = await resp.json();
  const raw = (data.choices?.[0]?.message?.content || "").trim();
  console.log("[AI raw response]", raw);

  // 无论响应格式如何，始终从原始内容中提取 {...}
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}") + 1;
  const jsonStr = (start !== -1 && end > start) ? raw.slice(start, end) : raw;

  try {
    return { result: JSON.parse(jsonStr), usedModel: data.model || KIMI_MODEL };
  } catch (e) {
    const preview = raw.slice(0, 120).replace(/\n/g, " ");
    console.error("[JSON parse error]", e.message, "raw:", raw);
    return {
      result: fields.reduce((acc, f) => ({ ...acc, [f]: `解析失败: ${preview || "空响应"}` }), {}),
      usedModel: data.model || KIMI_MODEL,
    };
  }
}

// ===== API 可用性验证 =====
async function validateAPI() {
  const key = kimiKeyInput.value.trim();
  const resultEl = document.getElementById("validate-result");
  const btn = document.getElementById("validate-btn");

  if (!key) {
    resultEl.hidden = false;
    resultEl.innerHTML = `<span class="vr-item vr-error">请先填写 API Key</span>`;
    return;
  }

  btn.disabled = true;
  btn.textContent = "验证中...";
  resultEl.hidden = false;
  resultEl.innerHTML = `<span class="vr-item vr-pending">正在测试...</span>`;

  try {
    const resp = await fetch(`${KIMI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: KIMI_MODEL,
        messages: [{ role: "user", content: "请回复 OK" }],
        max_tokens: 16,
        thinking: { type: "disabled" },
      }),
    });
    const data = await resp.json().catch(() => ({}));
    if (resp.ok || data.choices) {
      resultEl.innerHTML = `<span class="vr-item vr-ok">✓ ${KIMI_MODEL_LABEL}</span>`;
    } else {
      const msg = data.error?.message || data.message || `HTTP ${resp.status}`;
      resultEl.innerHTML = `<span class="vr-item vr-error">✗ ${KIMI_MODEL_LABEL}：${msg}</span>`;
    }
  } catch (e) {
    resultEl.innerHTML = `<span class="vr-item vr-error">✗ ${KIMI_MODEL_LABEL}：${e.message}</span>`;
  }

  btn.disabled = false;
  btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="6" stroke="currentColor" stroke-width="1.4"/><path d="M4.5 7l2 2 3-3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg> 验证模型可用性`;
}

// ===== 字段后处理（格式兜底）=====
const DATE_FIELDS = ["投标报名时间", "正式投标时间", "截止投标时间"];

function cleanDate(str) {
  // 提取所有 YYYY-MM-DD 格式的日期（忽略后面的时分秒）
  const matches = str.match(/\d{4}-\d{2}-\d{2}/g);
  if (matches && matches.length >= 2) return matches[0] + ":" + matches[1];
  if (matches && matches.length === 1) return matches[0];
  // 尝试中文日期 YYYY年MM月DD日
  const cn = str.match(/(\d{4})[年-](\d{1,2})[月-](\d{1,2})/g);
  if (cn && cn.length >= 2) {
    const fmt = (s) => s.replace(/(\d{4})[年-](\d{1,2})[月-](\d{1,2}).*/, (_, y, m, d) =>
      `${y}-${m.padStart(2,"0")}-${d.padStart(2,"0")}`);
    return fmt(cn[0]) + ":" + fmt(cn[1]);
  }
  if (cn && cn.length === 1) {
    return cn[0].replace(/(\d{4})[年-](\d{1,2})[月-](\d{1,2}).*/, (_, y, m, d) =>
      `${y}-${m.padStart(2,"0")}-${d.padStart(2,"0")}`);
  }
  return str; // 无法识别则原样返回
}

function cleanAmount(str) {
  if (!str || str === "未找到" || str === "无") return "无";
  // 提取数字（含小数）并换算单位
  const s = str.replace(/,/g, "");
  const wan = s.match(/([\d.]+)\s*万/);
  if (wan) return String(Math.round(parseFloat(wan[1]) * 10000));
  const yi = s.match(/([\d.]+)\s*亿/);
  if (yi) return String(Math.round(parseFloat(yi[1]) * 100000000));
  const num = s.match(/([\d.]+)/);
  if (num) return String(Math.round(parseFloat(num[1])));
  return "无";
}

function postProcess(fieldName, value) {
  if (value === "未找到" || value === "解析失败" || value.startsWith("失败:")) return value;
  if (fieldName === "标的金额") return cleanAmount(value);
  if (DATE_FIELDS.includes(fieldName)) return cleanDate(value);
  return value;
}

// ===== 状态 =====
let uploadedFiles = [];
let analysisResult = null;

const DEFAULT_FIELDS = [
  "文件名称", "招标公司名称", "联系人", "电话",
  "标的金额", "标的产品范围明细",
  "投标报名时间", "正式投标时间", "截止投标时间",
];
let fields = [...DEFAULT_FIELDS];

// ===== DOM =====
const dropZone      = document.getElementById("drop-zone");
const fileInput     = document.getElementById("file-input");
const fileChipsEl   = document.getElementById("file-chips");
const fileCountEl   = document.getElementById("file-count");
const clearFilesBtn = document.getElementById("clear-files");
const analyzeBtn    = document.getElementById("analyze-btn");
const loadingEl     = document.getElementById("loading");
const loadingText   = document.getElementById("loading-text");
const loadingSub    = document.getElementById("loading-sub");
const resultSection = document.getElementById("result-section");
const resultThead   = document.getElementById("result-thead");
const resultTbody   = document.getElementById("result-tbody");
const resultMeta    = document.getElementById("result-meta");
const exportBtn     = document.getElementById("export-btn");
const fieldInput    = document.getElementById("field-input");
const addFieldBtn   = document.getElementById("add-field-btn");
const fieldTagsEl   = document.getElementById("field-tags");
const fieldCountEl  = document.getElementById("field-count");

// Settings
const openSettingsBtn   = document.getElementById("open-settings");
const closeSettingsBtn  = document.getElementById("close-settings");
const cancelSettingsBtn = document.getElementById("cancel-settings");
const saveSettingsBtn   = document.getElementById("save-settings");
const settingsModal     = document.getElementById("settings-modal");
const kimiKeyInput      = document.getElementById("kimi-key-input");
const validateBtn       = document.getElementById("validate-btn");

// ===== 初始化 =====
loadSettings();
updateStatusBar();
renderFieldTags();

// ===== 文件上传 =====
dropZone.addEventListener("dragover", (e) => { e.preventDefault(); dropZone.classList.add("dragover"); });
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
dropZone.addEventListener("drop", (e) => { e.preventDefault(); dropZone.classList.remove("dragover"); addFiles(e.dataTransfer.files); });
dropZone.addEventListener("click", (e) => { if (!e.target.closest("label")) fileInput.click(); });
fileInput.addEventListener("change", () => { addFiles(fileInput.files); fileInput.value = ""; });
clearFilesBtn.addEventListener("click", () => { uploadedFiles = []; renderFileChips(); });

function addFiles(files) {
  for (const f of files) {
    if (!uploadedFiles.find((u) => u.name === f.name && u.size === f.size)) uploadedFiles.push(f);
  }
  renderFileChips();
}

function removeFile(index) {
  uploadedFiles.splice(index, 1);
  renderFileChips();
}

function fileTypeInfo(name) {
  const ext = name.split(".").pop().toLowerCase();
  if (ext === "pdf") return { label: "PDF", cls: "pdf" };
  if (["doc", "docx"].includes(ext)) return { label: "DOC", cls: "doc" };
  return { label: "IMG", cls: "img" };
}

function renderFileChips() {
  fileChipsEl.innerHTML = "";
  fileCountEl.textContent = uploadedFiles.length + " 个文件";
  clearFilesBtn.hidden = uploadedFiles.length === 0;

  uploadedFiles.forEach((file, i) => {
    const info = fileTypeInfo(file.name);
    const chip = document.createElement("span");
    chip.className = "file-chip";
    chip.innerHTML = `
      <span class="file-chip-type ${info.cls}">${info.label}</span>
      <span class="file-chip-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
      <button class="file-chip-remove" onclick="removeFile(${i})" title="移除">&#10005;</button>
    `;
    fileChipsEl.appendChild(chip);
  });
}

// ===== 字段管理 =====
function renderFieldTags() {
  fieldTagsEl.innerHTML = "";
  fieldCountEl.textContent = fields.length + " 个字段";
  fields.forEach((f, i) => {
    const span = document.createElement("span");
    span.className = "field-tag";
    span.innerHTML = `${escapeHtml(f)}<button class="field-tag-remove" onclick="removeField(${i})" title="删除">&#10005;</button>`;
    fieldTagsEl.appendChild(span);
  });
}

function removeField(index) { fields.splice(index, 1); renderFieldTags(); }

function addField() {
  const val = fieldInput.value.trim();
  if (!val || fields.includes(val)) { fieldInput.select(); return; }
  fields.push(val);
  fieldInput.value = "";
  renderFieldTags();
}

addFieldBtn.addEventListener("click", addField);
fieldInput.addEventListener("keydown", (e) => { if (e.key === "Enter") addField(); });

// ===== 分析 =====
analyzeBtn.addEventListener("click", analyze);

async function analyze() {
  if (!settings.kimiKey) { openSettings(); return; }
  if (uploadedFiles.length === 0) { alert("请先上传招投标文件"); return; }
  if (fields.length === 0) { alert("请至少添加一个提取字段"); return; }

  analyzeBtn.disabled = true;
  resultSection.hidden = true;
  loadingEl.hidden = false;

  const resultData = [];

  for (let i = 0; i < uploadedFiles.length; i++) {
    const file = uploadedFiles[i];
    loadingText.textContent = `正在分析第 ${i + 1} / ${uploadedFiles.length} 个文件`;
    loadingSub.textContent = file.name;

    try {
      const fileInfo = await extractFileContent(file, (msg) => {
        loadingSub.textContent = msg;
      });
      loadingSub.textContent = `${file.name}（${KIMI_MODEL_LABEL} 提取字段中...）`;
      const aiResult = await callAI(fileInfo, fields);
      const { result, usedModel } = aiResult;
      const normalized = {};
      for (const f of fields) {
        const v = result[f];
        let val = v == null ? "未找到" : String(v);
        val = postProcess(f, val);
        normalized[f] = val;
      }
      resultData.push({ filename: file.name, results: normalized, model: usedModel });
    } catch (err) {
      const errMsg = err?.message || String(err) || "未知错误";
      console.error("[analyze error]", file.name, err);
      resultData.push({
        filename: file.name,
        results: fields.reduce((acc, f) => ({ ...acc, [f]: `失败: ${errMsg}` }), {}),
        model: null,
      });
    }
  }

  analysisResult = { data: resultData, fields: [...fields] };
  renderResultTable(analysisResult);
  loadingEl.hidden = true;
  resultSection.hidden = false;
  analyzeBtn.disabled = false;
  resultSection.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderResultTable(result) {
  const { data, fields: cols } = result;
  resultMeta.textContent = `共 ${data.length} 份文件 · ${cols.length} 个字段`;

  resultThead.innerHTML = "";
  const hr = document.createElement("tr");
  ["文件名", ...cols].forEach((h) => {
    const th = document.createElement("th");
    th.textContent = h;
    th.title = h;
    hr.appendChild(th);
  });
  resultThead.appendChild(hr);

  resultTbody.innerHTML = "";
  data.forEach((item) => {
    const tr = document.createElement("tr");
    const tdName = document.createElement("td");
    tdName.textContent = item.filename;
    tdName.title = item.filename;
    tr.appendChild(tdName);

    cols.forEach((col) => {
      const td = document.createElement("td");
      const value = String(item.results[col] ?? "未找到");
      td.title = value; // tooltip 显示完整内容
      if (value === "未找到") {
        td.innerHTML = `<span class="not-found">—</span>`;
      } else if (value.startsWith("失败:") || value.startsWith("解析失败")) {
        td.innerHTML = `<span class="error-cell">${escapeHtml(value)}</span>`;
      } else {
        td.textContent = value;
      }
      tr.appendChild(td);
    });
    resultTbody.appendChild(tr);
  });
}

// ===== 导出 Excel =====
exportBtn.addEventListener("click", () => {
  if (!analysisResult) return;
  const { data, fields: cols } = analysisResult;
  const header = ["文件名", ...cols];
  const rows = data.map((item) => [
    item.filename,
    ...cols.map((col) => String(item.results[col] ?? "未找到")),
  ]);
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
  ws["!cols"] = header.map((_, i) => ({ wch: i === 0 ? 30 : 22 }));
  XLSX.utils.book_append_sheet(wb, ws, "招投标分析结果");
  XLSX.writeFile(wb, "招投标分析结果.xlsx");
});

// ===== 设置 Modal =====
validateBtn.addEventListener("click", validateAPI);
openSettingsBtn.addEventListener("click", openSettings);
closeSettingsBtn.addEventListener("click", closeModal);
cancelSettingsBtn.addEventListener("click", closeModal);
settingsModal.addEventListener("click", (e) => { if (e.target === settingsModal) closeModal(); });

// 显示/隐藏 Key 按钮
document.querySelectorAll(".key-toggle").forEach((btn) => {
  btn.addEventListener("click", () => {
    const input = document.getElementById(btn.dataset.target);
    input.type = input.type === "password" ? "text" : "password";
  });
});

saveSettingsBtn.addEventListener("click", () => {
  settings.kimiKey = kimiKeyInput.value.trim();
  saveSettingsToStorage();
  updateStatusBar();
  closeModal();
});

function openSettings() {
  kimiKeyInput.value = settings.kimiKey;
  kimiKeyInput.type = "password";
  document.getElementById("validate-result").hidden = true;
  settingsModal.hidden = false;
}

function closeModal() { settingsModal.hidden = true; }

// ===== 工具 =====
function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}
