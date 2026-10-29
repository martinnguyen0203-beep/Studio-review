"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const SETTINGS_FILE = path.join(__dirname, "..", "..", "config", "ai-settings.json");

/**
 * Chuẩn hóa Base URL thành bộ URL đầy đủ cho chuẩn OpenAI-Compatible
 * @param {string} rawBaseUrl
 */
function normalizeBaseUrl(rawBaseUrl) {
  let clean = String(rawBaseUrl || "").trim().replace(/\/+$/, "");
  if (!clean) {
    clean = "https://api.xah.io/v1";
  }

  let baseUrl = clean;
  let chatUrl = `${clean}/chat/completions`;
  let modelsUrl = `${clean}/models`;

  if (clean.endsWith("/chat/completions")) {
    chatUrl = clean;
    baseUrl = clean.slice(0, -"/chat/completions".length);
    modelsUrl = `${baseUrl}/models`;
  } else if (clean.endsWith("/models")) {
    modelsUrl = clean;
    baseUrl = clean.slice(0, -"/models".length);
    chatUrl = `${baseUrl}/chat/completions`;
  }

  return {
    baseUrl,
    chatUrl,
    modelsUrl
  };
}

/**
 * Danh sách Preset Nhà cung cấp mặc định
 */
const DEFAULT_PROVIDERS = {
  ckey: {
    id: "ckey",
    name: "CKey.vn (DeepSeek V4.1 Flash / Multi-Model)",
    baseUrl: "https://api.xah.io/v1",
    chatUrl: "https://api.xah.io/v1/chat/completions",
    modelsUrl: "https://api.xah.io/v1/models",
    defaultModel: "deepseek-v4.1-flash",
    models: [
      "deepseek-v4.1-flash",
      "deepseek-v4-pro",
      "deepseek-chat",
      "deepseek-reasoner",
      "gemini-2.5-flash",
      "gemini-2.5-pro",
      "gpt-4o-mini",
      "claude-3-7-sonnet"
    ],
    reasoningEffort: "xhigh",
    apiKey: "",
    extraHeaders: {},
    isBuiltIn: true
  },
  deepseek: {
    id: "deepseek",
    name: "DeepSeek Official (platform.deepseek.com)",
    baseUrl: "https://api.deepseek.com/v1",
    chatUrl: "https://api.deepseek.com/v1/chat/completions",
    modelsUrl: "https://api.deepseek.com/v1/models",
    balanceUrl: "https://api.deepseek.com/user/balance",
    defaultModel: "deepseek-chat",
    models: ["deepseek-chat", "deepseek-reasoner"],
    reasoningEffort: "",
    apiKey: "",
    extraHeaders: {},
    isBuiltIn: true
  },
  gemini: {
    id: "gemini",
    name: "Google Gemini (aistudio.google.com)",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    chatUrl: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    modelsUrl: "https://generativelanguage.googleapis.com/v1beta/openai/models",
    defaultModel: "gemini-2.5-flash",
    models: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash"],
    reasoningEffort: "",
    apiKey: "",
    extraHeaders: {},
    isBuiltIn: true
  },
  openai: {
    id: "openai",
    name: "OpenAI / OpenRouter / Custom Gateway",
    baseUrl: "https://api.openai.com/v1",
    chatUrl: "https://api.openai.com/v1/chat/completions",
    modelsUrl: "https://api.openai.com/v1/models",
    defaultModel: "gpt-4o-mini",
    models: ["gpt-4o-mini", "gpt-4o", "o3-mini"],
    reasoningEffort: "",
    apiKey: "",
    extraHeaders: {},
    isBuiltIn: true
  }
};

/**
 * Tạo cấu hình mặc định ban đầu
 */
function createDefaultSettings() {
  const providers = {};
  for (const [id, p] of Object.entries(DEFAULT_PROVIDERS)) {
    providers[id] = JSON.parse(JSON.stringify(p));
  }
  return {
    activeProviderId: "ckey",
    activeModel: "deepseek-v4.1-flash",
    providers
  };
}

/**
 * Đọc cài đặt AI từ config/ai-settings.json
 */
function loadAiSettings() {
  const defaults = createDefaultSettings();
  try {
    if (!fs.existsSync(SETTINGS_FILE)) {
      saveAiSettings(defaults);
      return defaults;
    }
    const raw = fs.readFileSync(SETTINGS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const mergedProviders = { ...defaults.providers };

    if (parsed && typeof parsed.providers === "object") {
      for (const [id, customP] of Object.entries(parsed.providers)) {
        if (!customP || typeof customP !== "object") continue;
        const base = mergedProviders[id] || {
          id,
          name: customP.name || id,
          baseUrl: customP.baseUrl || "https://api.xah.io/v1",
          defaultModel: customP.defaultModel || "deepseek-v4.1-flash",
          models: [],
          reasoningEffort: "",
          apiKey: "",
          extraHeaders: {},
          isBuiltIn: false
        };
        const urls = normalizeBaseUrl(customP.baseUrl || base.baseUrl);
        mergedProviders[id] = {
          ...base,
          ...customP,
          id,
          baseUrl: urls.baseUrl,
          chatUrl: urls.chatUrl,
          modelsUrl: urls.modelsUrl,
          models: Array.isArray(customP.models) && customP.models.length
            ? customP.models
            : base.models || [customP.defaultModel || base.defaultModel]
        };
      }
    }

    const activeProviderId =
      parsed.activeProviderId && mergedProviders[parsed.activeProviderId]
        ? parsed.activeProviderId
        : "ckey";
    const activeProvider = mergedProviders[activeProviderId];
    const activeModel =
      parsed.activeModel || activeProvider.defaultModel || "deepseek-v4.1-flash";

    return {
      activeProviderId,
      activeModel,
      providers: mergedProviders
    };
  } catch (err) {
    return defaults;
  }
}

/**
 * Lưu cài đặt AI vào config/ai-settings.json
 */
function saveAiSettings(settings) {
  const dir = path.dirname(SETTINGS_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), "utf8");
  return settings;
}

/**
 * Thêm hoặc cập nhật một Provider (cho phép thêm không giới hạn bên cung cấp thứ 3)
 */
function upsertProvider(providerInput) {
  const settings = loadAiSettings();
  const id = String(providerInput.id || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-") || `custom-${Date.now()}`;

  const existing = settings.providers[id] || {};
  const urls = normalizeBaseUrl(providerInput.baseUrl || existing.baseUrl || "https://api.xah.io/v1");
  const defaultModel = String(
    providerInput.defaultModel || existing.defaultModel || "deepseek-v4.1-flash"
  ).trim();

  const modelsSet = new Set([
    defaultModel,
    ...(Array.isArray(providerInput.models) ? providerInput.models : []),
    ...(Array.isArray(existing.models) ? existing.models : [])
  ].filter(Boolean));

  settings.providers[id] = {
    ...existing,
    id,
    name: String(providerInput.name || existing.name || id).trim(),
    baseUrl: urls.baseUrl,
    chatUrl: urls.chatUrl,
    modelsUrl: urls.modelsUrl,
    defaultModel,
    models: [...modelsSet],
    reasoningEffort:
      providerInput.reasoningEffort !== undefined
        ? String(providerInput.reasoningEffort || "").trim()
        : existing.reasoningEffort || "",
    apiKey:
      providerInput.apiKey !== undefined
        ? String(providerInput.apiKey || "").trim()
        : existing.apiKey || "",
    extraHeaders:
      providerInput.extraHeaders && typeof providerInput.extraHeaders === "object"
        ? providerInput.extraHeaders
        : existing.extraHeaders || {},
    isBuiltIn: Boolean(DEFAULT_PROVIDERS[id])
  };

  if (providerInput.setActive) {
    settings.activeProviderId = id;
    settings.activeModel = defaultModel;
  }

  return saveAiSettings(settings);
}

/**
 * Xóa một Provider tùy chỉnh
 */
function removeProvider(providerId) {
  const settings = loadAiSettings();
  if (DEFAULT_PROVIDERS[providerId]) {
    throw new Error(`Không thể xóa nhà cung cấp mặc định "${providerId}". Bạn có thể sửa URL hoặc Key của nó.`);
  }
  delete settings.providers[providerId];
  if (settings.activeProviderId === providerId) {
    settings.activeProviderId = "ckey";
    settings.activeModel = settings.providers.ckey.defaultModel;
  }
  return saveAiSettings(settings);
}

/**
 * Tự động đọc cấu hình từ @openai/codex (~/.codex/config.toml & ~/.codex/auth.json)
 * hỗ trợ trực tiếp lệnh cài đặt từ CKey.vn:
 * curl -fsSL "https://ckey.vn/install/apiai-install?tool=codex&model=deepseek-v4.1-flash" | bash
 */
function importFromCodexConfig() {
  const homeDir = os.homedir();
  const codexDir = path.join(homeDir, ".codex");
  const configTomlPath = path.join(codexDir, "config.toml");
  const authJsonPath = path.join(codexDir, "auth.json");

  let model = "deepseek-v4.1-flash";
  let reasoningEffort = "xhigh";
  let baseUrl = "https://api.xah.io/v1";
  let apiKey = "";
  let foundConfig = false;
  let foundAuth = false;

  if (fs.existsSync(configTomlPath)) {
    const tomlRaw = fs.readFileSync(configTomlPath, "utf8");
    const modelMatch = /^\s*model\s*=\s*["']([^"']+)["']/m.exec(tomlRaw);
    const effortMatch = /^\s*model_reasoning_effort\s*=\s*["']([^"']+)["']/m.exec(tomlRaw);
    const urlMatch = /^\s*openai_base_url\s*=\s*["']([^"']+)["']/m.exec(tomlRaw);

    if (modelMatch) model = modelMatch[1].trim();
    if (effortMatch) reasoningEffort = effortMatch[1].trim();
    if (urlMatch) baseUrl = urlMatch[1].trim();
    foundConfig = true;
  }

  if (fs.existsSync(authJsonPath)) {
    try {
      const authObj = JSON.parse(fs.readFileSync(authJsonPath, "utf8"));
      if (authObj && typeof authObj.OPENAI_API_KEY === "string" && authObj.OPENAI_API_KEY.trim()) {
        apiKey = authObj.OPENAI_API_KEY.trim();
        foundAuth = true;
      }
    } catch (_) {}
  }

  if (!foundConfig && !foundAuth) {
    return {
      ok: false,
      message: `Không tìm thấy file cấu hình Codex tại ${codexDir}. Bạn có thể dán trực tiếp API Key CKey.vn vào ô cài đặt.`
    };
  }

  const updated = upsertProvider({
    id: "ckey",
    name: "CKey.vn (DeepSeek V4.1 Flash / Codex)",
    baseUrl,
    defaultModel: model,
    reasoningEffort,
    ...(apiKey ? { apiKey } : {}),
    setActive: true
  });

  return {
    ok: true,
    foundConfig,
    foundAuth,
    provider: updated.providers.ckey,
    message: `Đã nạp thành công cấu hình từ ~/.codex: Base URL = ${baseUrl}, Model = ${model}${apiKey ? ", đã nạp API Key" : " (chưa có API Key trong auth.json)"}.`
  };
}

/**
 * Tạo HTTP Headers cho request AI
 */
function buildHeaders(provider, apiKeyOverride) {
  const apiKey = String(apiKeyOverride !== undefined ? apiKeyOverride : provider.apiKey || "").trim();
  if (!apiKey) {
    throw new Error(
      `Chưa có API Key cho "${provider.name}". Vui lòng mở phần ⚙️ Cài đặt API để dán Key và bấm Lưu.`
    );
  }
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    ...(provider.extraHeaders || {})
  };
}

/**
 * Lấy danh sách Models thực tế từ endpoint GET /v1/models của nhà cung cấp
 */
async function fetchAvailableModels(providerId, { apiKeyOverride, baseUrlOverride, timeoutMs = 15000 } = {}) {
  const settings = loadAiSettings();
  const provider = settings.providers[providerId || settings.activeProviderId];
  if (!provider) {
    throw new Error(`Không tìm thấy nhà cung cấp "${providerId}".`);
  }

  const urls = baseUrlOverride ? normalizeBaseUrl(baseUrlOverride) : normalizeBaseUrl(provider.baseUrl);
  const headers = buildHeaders(provider, apiKeyOverride);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(urls.modelsUrl, {
      method: "GET",
      headers,
      signal: controller.signal
    });

    if (!res.ok) {
      let errDetail = `HTTP ${res.status}`;
      try {
        const errJson = await res.json();
        errDetail = (errJson.error && errJson.error.message) || errJson.message || errDetail;
      } catch (_) {}
      throw new Error(`Không lấy được danh sách model từ ${urls.modelsUrl}: ${errDetail}`);
    }

    const data = await res.json();
    const rawList = Array.isArray(data.data)
      ? data.data
      : Array.isArray(data.models)
      ? data.models
      : [];

    const modelIds = rawList
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item.id === "string") return item.id.replace(/^models\//, "");
        if (item && typeof item.name === "string") return item.name.replace(/^models\//, "");
        return null;
      })
      .filter(Boolean);

    if (modelIds.length) {
      const merged = [...new Set([provider.defaultModel, ...modelIds].filter(Boolean))];
      provider.models = merged;
      saveAiSettings(settings);
    }

    return {
      ok: true,
      modelsUrl: urls.modelsUrl,
      models: modelIds.length ? modelIds : provider.models || [provider.defaultModel]
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Bóc tách nội dung suy nghĩ (<think>...</think>) và JSON từ câu trả lời của LLM
 */
function stripThinkingTags(text) {
  return String(text || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function extractJsonSafely(rawText) {
  const cleaned = stripThinkingTags(rawText);
  if (!cleaned) {
    throw new Error("AI trả về nội dung rỗng.");
  }

  // 1. Thử parse trực tiếp
  try {
    return JSON.parse(cleaned);
  } catch (_) {}

  // 2. Bóc từ khối ```json ... ```
  const fenceMatch = /```(?:json)?\s*([\s\S]*?)```/i.exec(cleaned);
  if (fenceMatch && fenceMatch[1]) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch (_) {}
  }

  // 3. Tìm cặp ngoặc nhọn { ... } hoặc ngoặc vuông [ ... ] ngoài cùng
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const candidate = cleaned.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(candidate);
    } catch (_) {}
  }

  const firstBracket = cleaned.indexOf("[");
  const lastBracket = cleaned.lastIndexOf("]");
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    const candidate = cleaned.slice(firstBracket, lastBracket + 1);
    try {
      return JSON.parse(candidate);
    } catch (_) {}
  }

  throw new Error(`Không thể phân tích cú pháp JSON từ phản hồi của AI: ${cleaned.slice(0, 220)}...`);
}

/**
 * Gửi request Chat Completions chuẩn OpenAI-Compatible (hỗ trợ CKey.vn, DeepSeek, Gemini, Custom)
 * Tự động fallback nếu model không nhận tham số `reasoning_effort` hoặc `thinking`.
 */
async function aiPostChat({
  providerId,
  model,
  system,
  user,
  messages,
  temperature = 0.4,
  maxTokens = 8192,
  think = false,
  reasoningEffort,
  responseJson = false,
  apiKeyOverride,
  baseUrlOverride,
  timeoutMs = 180000,
  signal
} = {}) {
  const settings = loadAiSettings();
  const targetProviderId = providerId || settings.activeProviderId || "ckey";
  const provider = settings.providers[targetProviderId];
  if (!provider) {
    throw new Error(`Nhà cung cấp AI "${targetProviderId}" chưa được cấu hình.`);
  }

  const urls = baseUrlOverride ? normalizeBaseUrl(baseUrlOverride) : normalizeBaseUrl(provider.baseUrl);
  const targetModel = String(model || settings.activeModel || provider.defaultModel || "deepseek-v4.1-flash").trim();
  const headers = buildHeaders(provider, apiKeyOverride);

  const chatMessages = Array.isArray(messages) && messages.length
    ? messages
    : [
        ...(system ? [{ role: "system", content: String(system) }] : []),
        { role: "user", content: String(user || "") }
      ];

  const baseBody = {
    model: targetModel,
    messages: chatMessages,
    max_tokens: maxTokens
  };

  if (typeof temperature === "number") {
    baseBody.temperature = temperature;
  }

  const eff = reasoningEffort !== undefined ? reasoningEffort : provider.reasoningEffort;
  const bodyWithExtras = { ...baseBody };
  if (eff && String(eff).trim()) {
    bodyWithExtras.reasoning_effort = String(eff).trim();
  } else if (think && targetProviderId === "deepseek") {
    bodyWithExtras.thinking = { type: "enabled" };
    bodyWithExtras.reasoning_effort = "low";
  }

  const startTime = Date.now();

  async function doFetch(payload) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    try {
      return await fetch(urls.chatUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
  }

  let res = await doFetch(bodyWithExtras);

  // Nếu server báo lỗi do không hỗ trợ tham số phụ `reasoning_effort` hoặc `thinking`, tự động thử lại với `baseBody` chuẩn
  if (!res.ok && (bodyWithExtras.reasoning_effort || bodyWithExtras.thinking)) {
    const status = res.status;
    if (status === 400 || status === 422) {
      res = await doFetch(baseBody);
    }
  }

  const latencyMs = Date.now() - startTime;

  if (!res.ok) {
    let errMsg = `HTTP ${res.status}`;
    try {
      const errJson = await res.json();
      errMsg =
        (errJson && errJson.error && errJson.error.message) ||
        (errJson && errJson.message) ||
        JSON.stringify(errJson);
    } catch (_) {
      try {
        errMsg = (await res.text()).slice(0, 300) || errMsg;
      } catch (__) {}
    }
    const error = new Error(`[${provider.name} - ${targetModel}] Lỗi gọi API (${res.status}): ${errMsg}`);
    error.status = res.status;
    throw error;
  }

  const data = await res.json();
  const rawContent =
    (data &&
      Array.isArray(data.choices) &&
      data.choices[0] &&
      data.choices[0].message &&
      data.choices[0].message.content) ||
    "";

  const cleanContent = stripThinkingTags(rawContent);

  return {
    ok: true,
    providerId: targetProviderId,
    providerName: provider.name,
    model: data.model || targetModel,
    latencyMs,
    rawContent,
    content: cleanContent,
    json: responseJson ? extractJsonSafely(cleanContent) : null,
    usage: data.usage || null
  };
}

/**
 * Kiểm tra API Key và xác nhận Model đang chọn hoạt động 100%
 */
async function checkApiKey(providerId, { modelOverride, apiKeyOverride, baseUrlOverride } = {}) {
  const settings = loadAiSettings();
  const targetProviderId = providerId || settings.activeProviderId || "ckey";
  const provider = settings.providers[targetProviderId];
  if (!provider) {
    throw new Error(`Không tìm thấy cấu hình cho nhà cung cấp "${targetProviderId}".`);
  }

  const targetModel = String(
    modelOverride || settings.activeModel || provider.defaultModel || "deepseek-v4.1-flash"
  ).trim();

  let discoveredModels = [];
  try {
    const modelRes = await fetchAvailableModels(targetProviderId, {
      apiKeyOverride,
      baseUrlOverride,
      timeoutMs: 10000
    });
    discoveredModels = modelRes.models || [];
  } catch (_) {
    // Một số gateway không mở endpoint /models mà chỉ mở /chat/completions
  }

  const testRes = await aiPostChat({
    providerId: targetProviderId,
    model: targetModel,
    system: "You are a helpful assistant.",
    user: "Reply with OK.",
    temperature: 0,
    maxTokens: 16,
    apiKeyOverride,
    baseUrlOverride,
    timeoutMs: 25000
  });

  return {
    ok: true,
    providerId: targetProviderId,
    providerName: provider.name,
    model: testRes.model,
    latencyMs: testRes.latencyMs,
    reply: testRes.content.slice(0, 80),
    discoveredModels,
    message: `Kết nối thành công tới ${provider.name}! Model "${testRes.model}" phản hồi trong ${testRes.latencyMs}ms.`
  };
}

module.exports = {
  SETTINGS_FILE,
  DEFAULT_PROVIDERS,
  normalizeBaseUrl,
  loadAiSettings,
  saveAiSettings,
  upsertProvider,
  removeProvider,
  importFromCodexConfig,
  fetchAvailableModels,
  checkApiKey,
  aiPostChat,
  extractJsonSafely,
  stripThinkingTags
};
