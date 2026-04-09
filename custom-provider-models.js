(function () {
  const ANTHROPIC_FORMAT = "anthropic";
  const OPENAI_CHAT_FORMAT = "openai_chat";
  const OPENAI_RESPONSES_FORMAT = "openai_responses";
  const DEFAULT_FORMAT = ANTHROPIC_FORMAT;
  const DEFAULT_CONTEXT_WINDOW = 200000;
  const MIN_CONTEXT_WINDOW = 20000;
  const FETCH_TIMEOUT_MS = 15000;
  const REASONING_EFFORT_VALUES = ["none", "low", "medium", "high", "max"];
  const LEGACY_STORAGE_KEY = "customProviderConfig";
  const PROFILES_STORAGE_KEY = "customProviderProfiles";
  const ACTIVE_PROFILE_STORAGE_KEY = "customProviderActiveProfileId";
  const BACKUP_KEY = "customProviderOriginalApiKey";
  const ANTHROPIC_API_KEY_STORAGE_KEY = "anthropicApiKey";
  const FETCHED_MODELS_CACHE_KEY = "customProviderFetchedModelsCache";
  const FETCHED_MODELS_CACHE_LIMIT = 24;
  const HEALTH_CHECK_PROMPT = "Reply with OK only.";
  const HEALTH_CHECK_MAX_TOKENS = 64;
  function normalizeFormat(value) {
    const format = String(value || "").trim().toLowerCase();
    if (!format || format === ANTHROPIC_FORMAT) {
      return ANTHROPIC_FORMAT;
    }
    if (format === "openai" || format === OPENAI_CHAT_FORMAT) {
      return OPENAI_CHAT_FORMAT;
    }
    if (format === "responses" || format === OPENAI_RESPONSES_FORMAT) {
      return OPENAI_RESPONSES_FORMAT;
    }
    return DEFAULT_FORMAT;
  }
  function inferFormat(source) {
    const explicitFormat = String(source?.format || "").trim();
    if (explicitFormat) {
      return normalizeFormat(explicitFormat);
    }
    const baseUrl = String(source?.baseUrl || "").trim().toLowerCase();
    if (/\/responses$/i.test(baseUrl)) {
      return OPENAI_RESPONSES_FORMAT;
    }
    if (/\/chat\/completions$/i.test(baseUrl)) {
      return OPENAI_CHAT_FORMAT;
    }
    const name = String(source?.name || "").trim().toLowerCase();
    const model = String(source?.defaultModel || "").trim().toLowerCase();
    if (name.includes("openai") || name.includes("gpt") || model.startsWith("gpt-") || model.startsWith("chatgpt") || model.length > 1 && model.startsWith("o") && /\d/.test(model[1])) {
      return OPENAI_CHAT_FORMAT;
    }
    return DEFAULT_FORMAT;
  }
  function normalizeReasoningEffort(value) {
    const effort = String(value || "").trim().toLowerCase();
    return REASONING_EFFORT_VALUES.includes(effort) ? effort : "medium";
  }
  function normalizeContextWindow(value) {
    const numeric = Number(String(value ?? "").trim());
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return DEFAULT_CONTEXT_WINDOW;
    }
    return Math.max(MIN_CONTEXT_WINDOW, Math.round(numeric));
  }
  function normalizeConfig(raw, fallbackEnabled) {
    const source = raw && typeof raw === "object" ? raw : {};
    return {
      enabled: true,
      name: String(source.name || "").trim(),
      format: inferFormat(source),
      baseUrl: String(source.baseUrl || "").trim().replace(/\/+$/, ""),
      apiKey: String(source.apiKey || "").trim(),
      defaultModel: String(source.defaultModel || "").trim(),
      reasoningEffort: normalizeReasoningEffort(source.reasoningEffort),
      contextWindow: normalizeContextWindow(source.contextWindow),
      notes: String(source.notes || "").trim(),
      fetchedModels: normalizeFetchedModels(source.fetchedModels)
    };
  }
  function createEmptyConfig() {
    return {
      enabled: true,
      name: "",
      format: DEFAULT_FORMAT,
      baseUrl: "",
      apiKey: "",
      defaultModel: "",
      reasoningEffort: "medium",
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      notes: "",
      fetchedModels: []
    };
  }
  function joinUrl(baseUrl, suffix) {
    return `${String(baseUrl || "").replace(/\/+$/, "")}/${String(suffix || "").replace(/^\/+/, "")}`;
  }
  function buildRequestUrl(baseUrl, format) {
    const normalizedBaseUrl = String(baseUrl || "").trim().replace(/\/+$/, "");
    const normalizedFormat = normalizeFormat(format);
    if (!normalizedBaseUrl) {
      return "";
    }
    if (normalizedFormat === OPENAI_CHAT_FORMAT) {
      if (/\/chat\/completions$/i.test(normalizedBaseUrl)) {
        return normalizedBaseUrl;
      } else {
        return normalizedBaseUrl + "/chat/completions";
      }
    }
    if (normalizedFormat === OPENAI_RESPONSES_FORMAT) {
      if (/\/responses$/i.test(normalizedBaseUrl)) {
        return normalizedBaseUrl;
      } else {
        return normalizedBaseUrl + "/responses";
      }
    }
    if (/\/messages$/i.test(normalizedBaseUrl)) {
      return normalizedBaseUrl;
    } else {
      return normalizedBaseUrl + "/messages";
    }
  }
  function extractErrorMessage(payload, fallback) {
    if (typeof payload === "string" && payload.trim()) {
      return payload.trim();
    }
    if (!payload || typeof payload !== "object") {
      return fallback;
    }
    const candidates = [payload.error, payload.message, payload.detail, payload.title, payload.reason, payload.msg, payload.err_msg, payload.error_msg, payload.statusText, payload.responseText, payload.base_resp, payload.baseResp];
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate.trim();
      }
      if (candidate && typeof candidate === "object") {
        const nested = [candidate.message, candidate.error, candidate.detail, candidate.type, candidate.reason, candidate.msg, candidate.err_msg, candidate.error_msg, candidate.status_msg, candidate.statusMessage];
        for (const item of nested) {
          if (typeof item === "string" && item.trim()) {
            return item.trim();
          }
        }
      }
    }
    return fallback;
  }
  function sortModels(models) {
    const conversationalHints = ["claude", "gpt", "o1", "o3", "o4", "o5", "sonnet", "opus", "haiku", "chat"];
    function score(model) {
      const value = String(model?.value || "").toLowerCase();
      if (conversationalHints.some(hint => value.includes(hint))) {
        return 0;
      } else {
        return 1;
      }
    }
    return [...models].sort((left, right) => {
      const leftScore = score(left);
      const rightScore = score(right);
      if (leftScore !== rightScore) {
        return leftScore - rightScore;
      }
      return String(left.label || left.value).localeCompare(String(right.label || right.value), "en");
    });
  }
  function dedupeModels(models) {
    const map = new Map();
    for (const item of models || []) {
      const value = String(item?.value || "").trim();
      if (!value) {
        continue;
      }
      if (!map.has(value)) {
        map.set(value, {
          value,
          label: String(item?.label || value).trim() || value,
          manual: !!item?.manual
        });
      }
    }
    return sortModels(Array.from(map.values()));
  }
  function normalizeFetchedModels(models) {
    const map = new Map();
    for (const item of models || []) {
      const value = String(item?.value || item?.model || "").trim();
      if (!value) {
        continue;
      }
      const current = map.get(value);
      if (!current) {
        map.set(value, {
          value,
          label: String(item?.label || item?.name || value).trim() || value,
          manual: !!item?.manual
        });
      } else if (item?.manual) {
        current.manual = true;
      }
    }
    return sortModels(Array.from(map.values()));
  }
  function hashProviderCacheKey(value) {
    let hash = 2166136261;
    const text = String(value || "");
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }
  function buildFetchedModelsCacheEntryKey(config) {
    const next = normalizeConfig(config);
    if (!next.baseUrl || !next.apiKey) {
      return "";
    }
    return "provider_" + hashProviderCacheKey([next.format, next.baseUrl, next.apiKey].join("\n"));
  }
  function normalizeFetchedModelsCache(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    const entries = {};
    for (const [key, entry] of Object.entries(source)) {
      if (!key) {
        continue;
      }
      const models = normalizeFetchedModels(entry?.models);
      if (!models.length) {
        continue;
      }
      entries[key] = {
        models,
        updatedAt: Number.isFinite(entry?.updatedAt) ? entry.updatedAt : 0
      };
    }
    return entries;
  }
  async function readFetchedModelsCache(options) {
    const settings = options && typeof options === "object" ? options : {};
    const storage = settings.storageArea || globalThis.chrome?.storage?.local;
    if (!storage) {
      return {};
    }
    const stored = await storage.get(FETCHED_MODELS_CACHE_KEY);
    return normalizeFetchedModelsCache(stored[FETCHED_MODELS_CACHE_KEY]);
  }
  async function readCachedFetchedModels(config, options) {
    const cacheKey = buildFetchedModelsCacheEntryKey(config);
    if (!cacheKey) {
      return [];
    }
    const cache = await readFetchedModelsCache(options);
    return normalizeFetchedModels(cache[cacheKey]?.models);
  }
  async function persistFetchedModelsForConfig(config, models, options) {
    const cacheKey = buildFetchedModelsCacheEntryKey(config);
    const normalizedModels = normalizeFetchedModels(models);
    if (!cacheKey || !normalizedModels.length) {
      return normalizedModels;
    }
    const settings = options && typeof options === "object" ? options : {};
    const storage = settings.storageArea || globalThis.chrome?.storage?.local;
    if (!storage) {
      return normalizedModels;
    }
    const cache = await readFetchedModelsCache({
      storageArea: storage
    });
    cache[cacheKey] = {
      models: normalizedModels,
      updatedAt: Date.now()
    };
    const prunedEntries = Object.entries(cache).sort(function (left, right) {
      return (right[1]?.updatedAt || 0) - (left[1]?.updatedAt || 0);
    }).slice(0, FETCHED_MODELS_CACHE_LIMIT);
    await storage.set({
      [FETCHED_MODELS_CACHE_KEY]: Object.fromEntries(prunedEntries)
    });
    return normalizedModels;
  }
  function createProfileId() {
    return "provider_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
  }
  function normalizeProfile(raw) {
    const config = normalizeConfig(raw);
    return {
      id: String(raw?.id || "").trim() || createProfileId(),
      name: String(raw?.name || "").trim(),
      format: config.format,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      defaultModel: config.defaultModel,
      reasoningEffort: config.reasoningEffort,
      contextWindow: config.contextWindow,
      notes: config.notes,
      fetchedModels: normalizeFetchedModels(raw?.fetchedModels)
    };
  }
  function hasConfigContent(raw) {
    const config = normalizeConfig(raw);
    return !!(config.name || config.baseUrl || config.apiKey || config.defaultModel || config.notes || normalizeFetchedModels(raw?.fetchedModels).length);
  }
  function projectProfileToConfig(profile) {
    if (!profile) {
      return createEmptyConfig();
    }
    return {
      enabled: true,
      name: String(profile.name || "").trim(),
      format: normalizeFormat(profile.format),
      baseUrl: String(profile.baseUrl || "").trim().replace(/\/+$/, ""),
      apiKey: String(profile.apiKey || "").trim(),
      defaultModel: String(profile.defaultModel || "").trim(),
      reasoningEffort: normalizeReasoningEffort(profile.reasoningEffort),
      contextWindow: normalizeContextWindow(profile.contextWindow),
      notes: String(profile.notes || "").trim(),
      fetchedModels: normalizeFetchedModels(profile.fetchedModels)
    };
  }
  function resolveActiveProfileId(profiles, requestedId) {
    const normalizedRequestedId = String(requestedId || "").trim();
    if (normalizedRequestedId && profiles.some(function (profile) {
      return profile.id === normalizedRequestedId;
    })) {
      return normalizedRequestedId;
    }
    return profiles[0]?.id || null;
  }
  function stableSerialize(value) {
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }
  async function persistProviderStoreState(nextState) {
    const state = nextState && typeof nextState === "object" ? nextState : {};
    const storage = state.storageArea || globalThis.chrome?.storage?.local;
    if (!storage) {
      throw new Error("Provider storage is not available.");
    }
    const profiles = Array.isArray(state.profiles) ? state.profiles.map(normalizeProfile) : [];
    const activeProfileId = resolveActiveProfileId(profiles, state.activeProfileId);
    const activeProfile = profiles.find(function (profile) {
      return profile.id === activeProfileId;
    }) || null;
    const legacyConfig = projectProfileToConfig(activeProfile);
    const writes = [storage.set({
      [PROFILES_STORAGE_KEY]: profiles,
      [ACTIVE_PROFILE_STORAGE_KEY]: activeProfileId,
      [LEGACY_STORAGE_KEY]: legacyConfig
    }), storage.remove(ANTHROPIC_API_KEY_STORAGE_KEY)];
    if (state.originalApiKey === undefined) {
      const nextBackupApiKey = state.currentApiKey && state.currentApiKey !== activeProfile?.apiKey ? state.currentApiKey : null;
      writes.push(storage.set({
        [BACKUP_KEY]: nextBackupApiKey
      }));
    }
    await Promise.all(writes);
    return {
      profiles,
      activeProfileId,
      activeProfile,
      config: legacyConfig,
      originalApiKey: state.originalApiKey === undefined ? state.currentApiKey && state.currentApiKey !== activeProfile?.apiKey ? state.currentApiKey : null : state.originalApiKey,
      currentApiKey: "",
      migrated: !!state.migrated
    };
  }
  async function readProviderStoreState(options) {
    const settings = options && typeof options === "object" ? options : {};
    const storage = settings.storageArea || globalThis.chrome?.storage?.local;
    if (!storage) {
      const emptyConfig = createEmptyConfig();
      return {
        profiles: [],
        activeProfileId: null,
        activeProfile: null,
        config: emptyConfig,
        originalApiKey: undefined,
        currentApiKey: "",
        migrated: false
      };
    }
    const stored = await storage.get([LEGACY_STORAGE_KEY, PROFILES_STORAGE_KEY, ACTIVE_PROFILE_STORAGE_KEY, BACKUP_KEY, ANTHROPIC_API_KEY_STORAGE_KEY]);
    let profiles = Array.isArray(stored[PROFILES_STORAGE_KEY]) ? stored[PROFILES_STORAGE_KEY].map(normalizeProfile) : [];
    let activeProfileId = resolveActiveProfileId(profiles, stored[ACTIVE_PROFILE_STORAGE_KEY]);
    let migrated = false;
    if (!profiles.length && hasConfigContent(stored[LEGACY_STORAGE_KEY])) {
      profiles = [normalizeProfile(stored[LEGACY_STORAGE_KEY])];
      activeProfileId = profiles[0].id;
      migrated = true;
    }
    const activeProfile = profiles.find(function (profile) {
      return profile.id === activeProfileId;
    }) || null;
    const legacyConfig = projectProfileToConfig(activeProfile);
    const needsSync = migrated || stableSerialize(legacyConfig) !== stableSerialize(normalizeConfig(stored[LEGACY_STORAGE_KEY])) || stored[ACTIVE_PROFILE_STORAGE_KEY] !== activeProfileId;
    if (needsSync && settings.persist !== false) {
      return persistProviderStoreState({
        storageArea: storage,
        profiles,
        activeProfileId,
        originalApiKey: Object.prototype.hasOwnProperty.call(stored, BACKUP_KEY) ? stored[BACKUP_KEY] : undefined,
        currentApiKey: stored[ANTHROPIC_API_KEY_STORAGE_KEY] || "",
        migrated
      });
    }
    return {
      profiles,
      activeProfileId,
      activeProfile,
      config: legacyConfig,
      originalApiKey: Object.prototype.hasOwnProperty.call(stored, BACKUP_KEY) ? stored[BACKUP_KEY] : undefined,
      currentApiKey: stored[ANTHROPIC_API_KEY_STORAGE_KEY] || "",
      migrated
    };
  }
  async function saveProviderProfile(profileInput, options) {
    const settings = options && typeof options === "object" ? options : {};
    const currentState = settings.state || await readProviderStoreState({
      storageArea: settings.storageArea
    });
    const incoming = profileInput && typeof profileInput === "object" ? profileInput : {};
    const nextProfile = normalizeProfile({
      ...incoming,
      id: settings.profileId || incoming.id || ""
    });
    const profiles = currentState.profiles.slice();
    const existingIndex = profiles.findIndex(function (profile) {
      return profile.id === nextProfile.id;
    });
    if (existingIndex >= 0) {
      profiles.splice(existingIndex, 1, nextProfile);
    } else {
      profiles.push(nextProfile);
    }
    const shouldActivate = settings.activateOnSave !== false;
    return persistProviderStoreState({
      storageArea: settings.storageArea,
      profiles,
      activeProfileId: shouldActivate ? nextProfile.id : currentState.activeProfileId,
      originalApiKey: currentState.originalApiKey,
      currentApiKey: currentState.currentApiKey
    });
  }
  async function setActiveProviderProfile(profileId, options) {
    const settings = options && typeof options === "object" ? options : {};
    const currentState = settings.state || await readProviderStoreState({
      storageArea: settings.storageArea
    });
    if (!currentState.profiles.some(function (profile) {
      return profile.id === profileId;
    })) {
      throw new Error("Provider profile not found.");
    }
    return persistProviderStoreState({
      storageArea: settings.storageArea,
      profiles: currentState.profiles,
      activeProfileId: profileId,
      originalApiKey: currentState.originalApiKey,
      currentApiKey: currentState.currentApiKey
    });
  }
  async function deleteProviderProfile(profileId, options) {
    const settings = options && typeof options === "object" ? options : {};
    const currentState = settings.state || await readProviderStoreState({
      storageArea: settings.storageArea
    });
    const profiles = currentState.profiles.filter(function (profile) {
      return profile.id !== profileId;
    });
    const activeProfileId = currentState.activeProfileId === profileId ? profiles[0]?.id || null : resolveActiveProfileId(profiles, currentState.activeProfileId);
    return persistProviderStoreState({
      storageArea: settings.storageArea,
      profiles,
      activeProfileId,
      originalApiKey: currentState.originalApiKey,
      currentApiKey: currentState.currentApiKey
    });
  }
  async function parseJsonSafe(response) {
    const text = await response.text();
    if (!text) {
      return {};
    }
    try {
      return JSON.parse(text);
    } catch {
      return {
        message: text
      };
    }
  }
  function buildProviderHeaders(config, format, includeContentType) {
    const normalizedFormat = normalizeFormat(format);
    const headers = normalizedFormat === ANTHROPIC_FORMAT ? {
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
      Accept: "application/json"
    } : {
      Authorization: `Bearer ${config.apiKey}`,
      Accept: "application/json"
    };
    if (includeContentType) {
      headers["content-type"] = "application/json";
    }
    return headers;
  }
  function isLikelyChatLikeModel(value) {
    const model = String(value || "").trim().toLowerCase();
    return model.startsWith("gpt-") || model.startsWith("chatgpt") || model.length > 1 && model.startsWith("o") && /\d/.test(model[1]);
  }
  function buildHealthCheckCandidates(config) {
    const requestedFormat = normalizeFormat(config?.format);
    const candidates = [requestedFormat];
    const baseUrl = String(config?.baseUrl || "").trim().toLowerCase();
    const model = String(config?.defaultModel || "").trim().toLowerCase();
    const name = String(config?.name || "").trim().toLowerCase();
    const looksChatLike = isLikelyChatLikeModel(model) || name.includes("openai") || name.includes("gpt");
    if (requestedFormat === OPENAI_RESPONSES_FORMAT && looksChatLike && !/\/responses$/i.test(baseUrl)) {
      candidates.push(OPENAI_CHAT_FORMAT);
    }
    return candidates;
  }
  function buildHealthCheckBody(config, format) {
    const model = String(config?.defaultModel || "").trim();
    const normalizedFormat = normalizeFormat(format);
    if (normalizedFormat === ANTHROPIC_FORMAT) {
      return {
        model,
        max_tokens: HEALTH_CHECK_MAX_TOKENS,
        stream: false,
        messages: [{
          role: "user",
          content: HEALTH_CHECK_PROMPT
        }]
      };
    }
    if (normalizedFormat === OPENAI_CHAT_FORMAT) {
      return {
        model,
        max_tokens: HEALTH_CHECK_MAX_TOKENS,
        temperature: 0,
        stream: false,
        messages: [{
          role: "user",
          content: HEALTH_CHECK_PROMPT
        }]
      };
    }
    return {
      model,
      max_output_tokens: HEALTH_CHECK_MAX_TOKENS,
      input: HEALTH_CHECK_PROMPT,
      stream: false
    };
  }
  function extractReadableTextFromPart(part, options) {
    const settings = options && typeof options === "object" ? options : {};
    const allowReasoning = settings.allowReasoning !== false;
    if (typeof part === "string") {
      return part.trim();
    }
    if (!part || typeof part !== "object") {
      return "";
    }
    const type = String(part.type || "").trim().toLowerCase();
    if (type === "tool_use" || type === "tool_result") {
      return "";
    }
    if (type === "text" && typeof part.text === "string") {
      return part.text.trim();
    }
    if (allowReasoning && type === "thinking" && typeof part.thinking === "string") {
      return part.thinking.trim();
    }
    if (allowReasoning && type === "reasoning") {
      if (typeof part.text === "string" && part.text.trim()) {
        return part.text.trim();
      }
      if (typeof part.reasoning === "string" && part.reasoning.trim()) {
        return part.reasoning.trim();
      }
    }
    const directCandidates = [part.output_text, part.content_text, part.response_text, part.text];
    if (allowReasoning) {
      directCandidates.push(part.reasoning, part.thinking);
    }
    for (const candidate of directCandidates) {
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate.trim();
      }
    }
    if (typeof part.content === "string" && part.content.trim()) {
      return part.content.trim();
    }
    const nestedCollections = [part.content, part.message?.content, part.output, part.reasoning_details, part.delta];
    for (const nested of nestedCollections) {
      const text = extractTextFromContentParts(nested, options);
      if (text) {
        return text;
      }
    }
    return "";
  }
  function extractTextFromContentParts(parts, options) {
    if (typeof parts === "string") {
      return parts.trim();
    }
    if (parts && typeof parts === "object" && !Array.isArray(parts)) {
      return extractReadableTextFromPart(parts, options);
    }
    if (!Array.isArray(parts)) {
      return "";
    }
    return parts.map(function (part) {
      return extractReadableTextFromPart(part, options);
    }).filter(Boolean).join(" ").trim();
  }
  function hasProbeResponseSignalInParts(parts) {
    if (typeof parts === "string") {
      return !!parts.trim();
    }
    if (!parts) {
      return false;
    }
    if (!Array.isArray(parts)) {
      if (typeof parts !== "object") {
        return false;
      }
      const type = String(parts.type || "").trim().toLowerCase();
      if (type === "tool_use" || type === "tool_result") {
        return false;
      }
      if (typeof parts.text === "string" && parts.text.trim()) {
        return true;
      }
      if (typeof parts.thinking === "string" && parts.thinking.trim()) {
        return true;
      }
      if (typeof parts.reasoning === "string" && parts.reasoning.trim()) {
        return true;
      }
      if (typeof parts.content === "string" && parts.content.trim()) {
        return true;
      }
      return hasProbeResponseSignalInParts(parts.content) || hasProbeResponseSignalInParts(parts.message?.content) || hasProbeResponseSignalInParts(parts.output) || hasProbeResponseSignalInParts(parts.reasoning_details) || hasProbeResponseSignalInParts(parts.delta);
    }
    return parts.some(function (part) {
      return hasProbeResponseSignalInParts(part);
    });
  }
  function extractProbeReply(payload) {
    if (!payload || typeof payload !== "object") {
      return "";
    }
    if (typeof payload.output_text === "string" && payload.output_text.trim()) {
      return payload.output_text.trim();
    }
    const textFirstCandidates = [
      extractTextFromContentParts(payload.content, {
        allowReasoning: false
      }),
      extractTextFromContentParts(payload.message?.content, {
        allowReasoning: false
      }),
      Array.isArray(payload.output) ? payload.output.map(function (item) {
        return extractTextFromContentParts(item?.content, {
          allowReasoning: false
        });
      }).filter(Boolean).join(" ").trim() : "",
      Array.isArray(payload.choices) ? payload.choices.map(function (choice) {
        if (typeof choice?.message?.content === "string") {
          return choice.message.content.trim();
        }
        return extractTextFromContentParts(choice?.message?.content, {
          allowReasoning: false
        });
      }).filter(Boolean).join(" ").trim() : "",
      typeof payload.message === "string" ? payload.message.trim() : "",
      typeof payload.content === "string" ? payload.content.trim() : ""
    ];
    for (const candidate of textFirstCandidates) {
      if (candidate) {
        return candidate;
      }
    }
    return "";
  }
  function hasProbeResponseSignal(payload) {
    if (!payload || typeof payload !== "object") {
      return false;
    }
    if (typeof payload.output_text === "string" && payload.output_text.trim()) {
      return true;
    }
    if (typeof payload.message === "string" && payload.message.trim()) {
      return true;
    }
    if (typeof payload.content === "string" && payload.content.trim()) {
      return true;
    }
    if (typeof payload.thinking === "string" && payload.thinking.trim()) {
      return true;
    }
    if (typeof payload.reasoning === "string" && payload.reasoning.trim()) {
      return true;
    }
    return hasProbeResponseSignalInParts(payload.content) || hasProbeResponseSignalInParts(payload.message?.content) || hasProbeResponseSignalInParts(payload.output) || hasProbeResponseSignalInParts(payload.choices?.map(function (choice) {
      return choice?.message?.content;
    })) || hasProbeResponseSignalInParts(payload.reasoning_details);
  }
  // 统一向兼容供应商请求 /models，并把返回值整理成下拉可选项。
  async function fetchProviderModels(config, options) {
    const next = normalizeConfig(config);
    if (!next.baseUrl) {
      throw new Error("请先填写 Base URL。");
    }
    if (!next.apiKey) {
      throw new Error("请先填写 API Key。");
    }
    const controller = new AbortController();
    const timer = globalThis.setTimeout(function () {
      controller.abort();
    }, FETCH_TIMEOUT_MS);
    try {
      const headers = buildProviderHeaders(next, next.format, false);
      const response = await (options?.fetchImpl || globalThis.fetch)(joinUrl(next.baseUrl, "models"), {
        method: "GET",
        headers,
        signal: controller.signal
      });
      const payload = await parseJsonSafe(response);
      if (!response.ok) {
        throw new Error(extractErrorMessage(payload, `获取模型失败（${response.status}）`));
      }
      const list = Array.isArray(payload?.data) ? payload.data : [];
      const models = dedupeModels(list.map(function (item) {
        const id = String(item?.id || "").trim();
        return {
          value: id,
          label: String(item?.display_name || id).trim() || id
        };
      }));
      if (!models.length) {
        throw new Error("接口已响应，但没有返回可选模型。");
      }
      return models;
    } catch (error) {
      if (error && error.name === "AbortError") {
        throw new Error("获取模型超时，请稍后重试。");
      }
      throw error;
    } finally {
      globalThis.clearTimeout(timer);
    }
  }
  async function probeProviderModel(config, options) {
    const next = normalizeConfig(config);
    if (!next.baseUrl) {
      throw new Error("请先填写 Base URL。");
    }
    if (!next.apiKey) {
      throw new Error("请先填写 API Key。");
    }
    if (!next.defaultModel) {
      throw new Error("请先选择一个模型后再检测。");
    }
    const controller = new AbortController();
    const timer = globalThis.setTimeout(function () {
      controller.abort();
    }, FETCH_TIMEOUT_MS);
    const fetchImpl = options?.fetchImpl || globalThis.fetch;
    const candidates = buildHealthCheckCandidates(next);
    let lastError = null;
    try {
      for (const format of candidates) {
        const requestUrl = buildRequestUrl(next.baseUrl, format);
        try {
          const response = await fetchImpl(requestUrl, {
            method: "POST",
            headers: buildProviderHeaders(next, format, true),
            body: JSON.stringify(buildHealthCheckBody(next, format)),
            signal: controller.signal
          });
          const payload = await parseJsonSafe(response);
          if (!response.ok) {
            throw new Error(extractErrorMessage(payload, `健康检测失败（${response.status}）`));
          }
          const replyText = extractProbeReply(payload);
          const responseDetected = hasProbeResponseSignal(payload);
          if (!replyText && !responseDetected) {
            throw new Error("模型已响应，但没有返回可读文本。");
          }
          return {
            ok: true,
            format,
            requestUrl,
            replyText,
            responseDetected
          };
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError || new Error("健康检测失败。");
    } catch (error) {
      if (error && error.name === "AbortError") {
        throw new Error("健康检测超时，请稍后重试。");
      }
      throw error;
    } finally {
      globalThis.clearTimeout(timer);
    }
  }
  function syncModelOptions(select, models, selectedValue) {
    if (!select) {
      return;
    }
    select.innerHTML = "";
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = models.length ? "选择一个已获取的模型" : "点击“获取模型”后可直接选择";
    select.appendChild(placeholder);
    for (const model of models) {
      const option = document.createElement("option");
      option.value = model.value;
      option.textContent = model.label && model.label !== model.value ? `${model.label} (${model.value})` : model.value;
      select.appendChild(option);
    }
    select.disabled = models.length === 0;
    if (selectedValue && models.some(model => model.value === selectedValue)) {
      select.value = selectedValue;
    } else {
      select.value = "";
    }
  }
  globalThis.CustomProviderModels = {
    ANTHROPIC_FORMAT,
    OPENAI_CHAT_FORMAT,
    OPENAI_RESPONSES_FORMAT,
    DEFAULT_FORMAT,
    DEFAULT_CONTEXT_WINDOW,
    LEGACY_STORAGE_KEY,
    PROFILES_STORAGE_KEY,
    ACTIVE_PROFILE_STORAGE_KEY,
    BACKUP_KEY,
    ANTHROPIC_API_KEY_STORAGE_KEY,
    FETCHED_MODELS_CACHE_KEY,
    extractErrorMessage,
    normalizeFormat,
    normalizeReasoningEffort,
    normalizeContextWindow,
    normalizeConfig,
    normalizeProfile,
    createEmptyConfig,
    projectProfileToConfig,
    readProviderStoreState,
    saveProviderProfile,
    setActiveProviderProfile,
    deleteProviderProfile,
    readCachedFetchedModels,
    persistFetchedModelsForConfig,
    buildRequestUrl,
    fetchProviderModels,
    probeProviderModel,
    syncModelOptions
  };
})();
