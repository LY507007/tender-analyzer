// ===== AI 服务商配置 =====
const PROVIDERS = {
  kimi: {
    name: "Kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    defaultModel: "moonshot-v1-128k",
    supportsVision: false,
  },
  minimax: {
    name: "MiniMax",
    baseUrl: "https://api.minimax.chat/v1",
    supportsVision: true,
  },
};

// ===== 设置 =====
const SETTINGS_KEY = "tenderSettings_v2";
let settings = { kimiKey: "", minimaxKey: "", minimaxModel: "MiniMax-M1-2.5" };

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
  const both = settings.kimiKey && settings.minimaxKey;
  const any = settings.kimiKey || settings.minimaxKey;
  if (both) {
    dot.className = "status-dot ok";
    text.textContent = "Kimi + MiniMax 已配置";
  } else if (settings.kimiKey) {
    dot.className = "status-dot partial";
    text.textContent = "Kimi 已配置（未配置 MiniMax）";
  } else if (settings.minimaxKey) {
    dot.className = "status-dot partial";
    text.textContent = "MiniMax 已配置（未配置 Kimi）";
  } else {
    dot.className = "status-dot warn";
    text.textContent = "未配置 API Key";
  }
}

// ===== PDF.js =====
pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js";

// ===== 浏览器端文件处理 =====

async function extractPDF(file) {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const parts = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    parts.push(content.items.map((item) => item.str).join(" "));
  }
  const text = parts.join("\n").trim();

  // 扫描件（文本极少）→ 渲染首页为图片
  if (text.length < 50) {
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    const base64 = canvas.toDataURL("image/png").split(",")[1];
    return { type: "image", content: base64, mediaType: "image/png" };
  }
  return { type: "text", content: text };
}

async function extractWord(file) {
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer });
  return { type: "text", content: result.value };
}

async function extractImage(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve({
        type: "image",
        content: reader.result.split(",")[1],
        mediaType: file.type || "image/png",
      });
    };
    reader.readAsDataURL(file);
  });
}

async function extractFileContent(file) {
  const ext = file.name.split(".").pop().toLowerCase();
  if (ext === "pdf") return extractPDF(file);
  if (["doc", "docx"].includes(ext)) return extractWord(file);
  return extractImage(file);
}

// ===== 智能选择 API =====
// 文本 → Kimi（优先，长文档强）；图片/扫描件 → MiniMax（视觉）
function selectProvider(fileInfo) {
  if (fileInfo.type === "image") {
    if (settings.minimaxKey) return { provider: "minimax", key: settings.minimaxKey, model: settings.minimaxModel };
    if (settings.kimiKey) return { provider: "kimi", key: settings.kimiKey, model: PROVIDERS.kimi.defaultModel };
  } else {
    if (settings.kimiKey) return { provider: "kimi", key: settings.kimiKey, model: PROVIDERS.kimi.defaultModel };
    if (settings.minimaxKey) return { provider: "minimax", key: settings.minimaxKey, model: settings.minimaxModel };
  }
  return null;
}

// ===== AI API 调用 =====
async function callAI(fileInfo, fields) {
  const sel = selectProvider(fileInfo);
  if (!sel) throw new Error("请先配置 API Key");

  const prov = PROVIDERS[sel.provider];
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
  } else if (prov.supportsVision) {
    messages = [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:${fileInfo.mediaType};base64,${fileInfo.content}` } },
          { type: "text", text: userText },
        ],
      },
    ];
  } else {
    // Kimi 不支持视觉但被选为 fallback
    messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: `${userText}\n\n（注：图片文件无法提取文字，请配置 MiniMax API Key 以启用 OCR 识别）` },
    ];
  }

  const resp = await fetch(`${prov.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${sel.key}`,
    },
    body: JSON.stringify({ model: sel.model, messages, max_tokens: 2048 }),
  });

  if (!resp.ok) {
    const errData = await resp.json().catch(() => ({}));
    throw new Error(errData.error?.message || errData.message || `API 错误 ${resp.status}`);
  }

  const data = await resp.json();
  const raw = (data.choices[0].message.content || "").trim();

  let jsonStr = raw;
  if (raw.includes("```")) {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}") + 1;
    if (start !== -1 && end > start) jsonStr = raw.slice(start, end);
  }

  try {
    return { result: JSON.parse(jsonStr), usedProvider: sel.provider };
  } catch (_) {
    return { result: fields.reduce((acc, f) => ({ ...acc, [f]: "解析失败" }), {}), usedProvider: sel.provider };
  }
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
const minimaxKeyInput   = document.getElementById("minimax-key-input");
const minimaxModelSel   = document.getElementById("minimax-model-select");

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
  if (!settings.kimiKey && !settings.minimaxKey) { openSettings(); return; }
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
      const fileInfo = await extractFileContent(file);
      const { result, usedProvider } = await callAI(fileInfo, fields);
      const normalized = {};
      for (const f of fields) {
        const v = result[f];
        normalized[f] = v == null ? "未找到" : String(v);
      }
      resultData.push({ filename: file.name, results: normalized, provider: usedProvider });
    } catch (err) {
      resultData.push({
        filename: file.name,
        results: fields.reduce((acc, f) => ({ ...acc, [f]: `失败: ${err.message}` }), {}),
        provider: null,
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
      } else if (value.startsWith("失败:") || value === "解析失败") {
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
  settings.minimaxKey = minimaxKeyInput.value.trim();
  settings.minimaxModel = minimaxModelSel.value;
  saveSettingsToStorage();
  updateStatusBar();
  closeModal();
});

function openSettings() {
  kimiKeyInput.value = settings.kimiKey;
  kimiKeyInput.type = "password";
  minimaxKeyInput.value = settings.minimaxKey;
  minimaxKeyInput.type = "password";
  minimaxModelSel.value = settings.minimaxModel;
  settingsModal.hidden = false;
}

function closeModal() { settingsModal.hidden = true; }

// ===== 工具 =====
function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}
