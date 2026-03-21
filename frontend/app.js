// ===== AI 服务商配置 =====
const PROVIDERS = {
  minimax: {
    name: "MiniMax",
    baseUrl: "https://api.minimax.chat/v1",
    models: [
      { id: "MiniMax-Text-01", label: "MiniMax-Text-01（推荐）" },
      { id: "abab6.5s-chat", label: "abab6.5s-chat" },
    ],
    supportsVision: true,
    note: "支持 PDF、Word 文本提取及图片（OCR）分析。",
  },
  kimi: {
    name: "Kimi（月之暗面）",
    baseUrl: "https://api.moonshot.cn/v1",
    models: [
      { id: "moonshot-v1-128k", label: "moonshot-v1-128k（推荐，超长文档）" },
      { id: "moonshot-v1-32k", label: "moonshot-v1-32k" },
      { id: "moonshot-v1-8k", label: "moonshot-v1-8k" },
    ],
    supportsVision: false,
    note: "支持 PDF、Word 文本提取。图片文件请切换为 MiniMax。",
  },
};

// ===== 设置管理 =====
const SETTINGS_KEY = "tenderSettings_v1";
let settings = { provider: "minimax", apiKey: "", model: "MiniMax-Text-01" };

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
  if (settings.apiKey) {
    dot.className = "status-dot ok";
    text.textContent = `${PROVIDERS[settings.provider].name} · ${settings.model}`;
  } else {
    dot.className = "status-dot warn";
    text.textContent = "未配置 API Key";
  }
}

// ===== PDF.js 初始化 =====
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
  return { type: "text", content: parts.join("\n") };
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
      const base64 = reader.result.split(",")[1];
      resolve({ type: "image", content: base64, mediaType: file.type || "image/png" });
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

// ===== AI API 调用 =====
async function callAI(fileInfo, fields) {
  const prov = PROVIDERS[settings.provider];
  const fieldsStr = fields.join("、");

  const systemPrompt =
    "你是一个专业的招投标文件分析助手。请从用户提供的文件内容中提取指定字段的信息。" +
    '如果某字段在文件中不存在或无法确认，请返回"未找到"。' +
    "只返回 JSON 格式的结果，key 为字段名，value 为提取的值，不要包含其他内容。";

  const userText =
    `请从以下招投标文件中提取这些字段的信息：${fieldsStr}\n\n` +
    `请以 JSON 格式返回，格式示例：{"字段名": "提取值"}`;

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
          {
            type: "image_url",
            image_url: { url: `data:${fileInfo.mediaType};base64,${fileInfo.content}` },
          },
          { type: "text", text: userText },
        ],
      },
    ];
  } else {
    return fields.reduce(
      (acc, f) => ({ ...acc, [f]: "当前模型不支持图片，请切换 MiniMax 或上传文字版文件" }),
      {}
    );
  }

  const resp = await fetch(`${prov.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify({ model: settings.model, messages, max_tokens: 2048 }),
  });

  if (!resp.ok) {
    const errData = await resp.json().catch(() => ({}));
    const msg = errData.error?.message || errData.message || `API 错误 ${resp.status}`;
    throw new Error(msg);
  }

  const data = await resp.json();
  const raw = (data.choices[0].message.content || "").trim();

  // 提取 JSON（兼容模型把结果包裹在 ```json``` 中）
  let jsonStr = raw;
  if (raw.includes("```")) {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}") + 1;
    if (start !== -1 && end > start) jsonStr = raw.slice(start, end);
  }

  try {
    return JSON.parse(jsonStr);
  } catch (_) {
    return fields.reduce((acc, f) => ({ ...acc, [f]: "解析失败" }), {});
  }
}

// ===== 状态 =====
let uploadedFiles = [];
let analysisResult = null;

const DEFAULT_FIELDS = [
  "文件名称",
  "招标公司名称",
  "联系人",
  "电话",
  "标的金额",
  "标的产品范围明细",
  "投标报名时间",
  "正式投标时间",
  "截止投标时间",
];
let fields = [...DEFAULT_FIELDS];

// ===== DOM =====
const dropZone     = document.getElementById("drop-zone");
const fileInput    = document.getElementById("file-input");
const fileListEl   = document.getElementById("file-list");
const fileCountEl  = document.getElementById("file-count");
const analyzeBtn   = document.getElementById("analyze-btn");
const loadingEl    = document.getElementById("loading");
const loadingText  = document.getElementById("loading-text");
const loadingSub   = document.getElementById("loading-sub");
const resultSection = document.getElementById("result-section");
const resultThead  = document.getElementById("result-thead");
const resultTbody  = document.getElementById("result-tbody");
const resultMeta   = document.getElementById("result-meta");
const exportBtn    = document.getElementById("export-btn");
const fieldInput   = document.getElementById("field-input");
const addFieldBtn  = document.getElementById("add-field-btn");
const fieldTagsEl  = document.getElementById("field-tags");
const fieldCountEl = document.getElementById("field-count");

// Settings modal
const openSettingsBtn   = document.getElementById("open-settings");
const closeSettingsBtn  = document.getElementById("close-settings");
const cancelSettingsBtn = document.getElementById("cancel-settings");
const saveSettingsBtn   = document.getElementById("save-settings");
const settingsModal     = document.getElementById("settings-modal");
const providerTabs      = document.querySelectorAll(".provider-tab");
const apiKeyInput       = document.getElementById("api-key-input");
const keyToggleBtn      = document.getElementById("key-toggle");
const modelSelect       = document.getElementById("model-select");
const providerNote      = document.getElementById("provider-note");

// ===== 初始化 =====
loadSettings();
updateStatusBar();
renderFieldTags();

// ===== 文件上传 =====
dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropZone.classList.add("dragover");
});
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("dragover");
  addFiles(e.dataTransfer.files);
});
dropZone.addEventListener("click", (e) => {
  if (!e.target.closest("label")) fileInput.click();
});
fileInput.addEventListener("change", () => {
  addFiles(fileInput.files);
  fileInput.value = "";
});

function addFiles(files) {
  for (const f of files) {
    if (!uploadedFiles.find((u) => u.name === f.name && u.size === f.size)) {
      uploadedFiles.push(f);
    }
  }
  renderFileList();
}

function removeFile(index) {
  uploadedFiles.splice(index, 1);
  renderFileList();
}

function fileTypeInfo(name) {
  const ext = name.split(".").pop().toLowerCase();
  if (ext === "pdf") return { label: "PDF", cls: "pdf" };
  if (["doc", "docx"].includes(ext)) return { label: "DOC", cls: "doc" };
  return { label: "IMG", cls: "img" };
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1048576).toFixed(1) + " MB";
}

function renderFileList() {
  fileListEl.innerHTML = "";
  fileCountEl.textContent = uploadedFiles.length + " 个文件";
  uploadedFiles.forEach((file, i) => {
    const info = fileTypeInfo(file.name);
    const li = document.createElement("li");
    li.innerHTML = `
      <div class="file-icon ${info.cls}">${info.label}</div>
      <span class="file-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
      <span class="file-size">${formatSize(file.size)}</span>
      <button class="remove-btn" onclick="removeFile(${i})" title="移除">&#10005;</button>
    `;
    fileListEl.appendChild(li);
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

function removeField(index) {
  fields.splice(index, 1);
  renderFieldTags();
}

function addField() {
  const val = fieldInput.value.trim();
  if (!val) return;
  if (fields.includes(val)) { fieldInput.select(); return; }
  fields.push(val);
  fieldInput.value = "";
  renderFieldTags();
}

addFieldBtn.addEventListener("click", addField);
fieldInput.addEventListener("keydown", (e) => { if (e.key === "Enter") addField(); });

// ===== 分析 =====
analyzeBtn.addEventListener("click", analyze);

async function analyze() {
  if (!settings.apiKey) {
    openSettings();
    return;
  }
  if (uploadedFiles.length === 0) {
    alert("请先上传招投标文件");
    return;
  }
  if (fields.length === 0) {
    alert("请至少添加一个提取字段");
    return;
  }

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
      const result = await callAI(fileInfo, fields);
      // 统一所有字段都有值
      const normalized = {};
      for (const f of fields) {
        const v = result[f];
        normalized[f] = v == null ? "未找到" : String(v);
      }
      resultData.push({ filename: file.name, results: normalized });
    } catch (err) {
      resultData.push({
        filename: file.name,
        results: fields.reduce((acc, f) => ({ ...acc, [f]: `处理失败: ${err.message}` }), {}),
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
    hr.appendChild(th);
  });
  resultThead.appendChild(hr);

  resultTbody.innerHTML = "";
  data.forEach((item) => {
    const tr = document.createElement("tr");
    const tdName = document.createElement("td");
    tdName.textContent = item.filename;
    tr.appendChild(tdName);

    cols.forEach((col) => {
      const td = document.createElement("td");
      const value = String(item.results[col] ?? "未找到");
      if (value === "未找到") {
        td.innerHTML = `<span class="not-found">—</span>`;
      } else if (value.startsWith("处理失败") || value === "解析失败") {
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

// API Key 显示/隐藏
keyToggleBtn.addEventListener("click", () => {
  apiKeyInput.type = apiKeyInput.type === "password" ? "text" : "password";
});

// Provider 切换
providerTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    providerTabs.forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    const prov = tab.dataset.provider;
    updateModelSelect(prov);
    providerNote.textContent = PROVIDERS[prov].note;
  });
});

saveSettingsBtn.addEventListener("click", () => {
  const activeTab = document.querySelector(".provider-tab.active");
  settings.provider = activeTab.dataset.provider;
  settings.apiKey = apiKeyInput.value.trim();
  settings.model = modelSelect.value;
  saveSettingsToStorage();
  updateStatusBar();
  closeModal();
});

function openSettings() {
  // 填充当前配置
  providerTabs.forEach((t) => t.classList.toggle("active", t.dataset.provider === settings.provider));
  apiKeyInput.value = settings.apiKey;
  apiKeyInput.type = "password";
  updateModelSelect(settings.provider);
  modelSelect.value = settings.model;
  providerNote.textContent = PROVIDERS[settings.provider].note;
  settingsModal.hidden = false;
}

function closeModal() {
  settingsModal.hidden = true;
}

function updateModelSelect(provider) {
  const models = PROVIDERS[provider].models;
  modelSelect.innerHTML = models
    .map((m) => `<option value="${m.id}">${m.label}</option>`)
    .join("");
}

// ===== 工具 =====
function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}
