(function () {
  const shared = globalThis.__CP_GITHUB_UPDATE_SHARED__;
  if (!shared || !globalThis.chrome?.runtime?.id) {
    return;
  }

  const {
    LATEST_JSON_URL,
    STORAGE_KEYS,
    MESSAGE_TYPES,
    ALARM_NAME,
    CHECK_INTERVAL_MINUTES,
    normalizeVersion,
    compareVersions,
    computeHasUpdate,
    isBlockedByMinVersion,
    createDefaultUpdateInfo,
    normalizeStoredInfo,
    normalizeLatestPayload,
    readStoredState
  } = shared;

  function log(event, detail, level) {
    const method = level === "error" ? "error" : level === "warn" ? "warn" : "info";
    try {
      console[method]("[github-update]", event, detail || "");
    } catch {}
  }

  function getCurrentVersion() {
    return normalizeVersion(chrome.runtime.getManifest().version || "");
  }

  function getVersionInfoPayload(info) {
    if (info && info.minSupportedVersion) {
      return {
        min_supported_version: info.minSupportedVersion
      };
    }
    return {};
  }

  function shouldSkipNetworkCheck(info, force) {
    if (force || !info?.lastCheckedAt) {
      return false;
    }
    const lastCheckedTime = new Date(info.lastCheckedAt).getTime();
    if (!Number.isFinite(lastCheckedTime) || lastCheckedTime <= 0) {
      return false;
    }
    return Date.now() - lastCheckedTime < CHECK_INTERVAL_MINUTES * 60 * 1000;
  }

  async function isAutoCheckEnabled() {
    const state = await readStoredState();
    return state.autoCheckEnabled !== false;
  }

  async function syncBadge(hasUpdate) {
    if (!chrome.action?.setBadgeText) {
      return;
    }
    const visible = !!hasUpdate;
    try {
      await chrome.action.setBadgeText({
        text: visible ? "NEW" : ""
      });
      if (visible) {
        await chrome.action.setBadgeBackgroundColor({
          color: "#ca4330"
        });
        await chrome.action.setBadgeTextColor?.({
          color: "#ffffff"
        });
      }
    } catch (error) {
      log("badge.sync_failed", {
        error: String(error?.message || error || "")
      }, "warn");
    }
  }

  async function persistInfo(info) {
    const normalizedInfo = normalizeStoredInfo(info, getCurrentVersion());
    await chrome.storage.local.set({
      [STORAGE_KEYS.INFO]: normalizedInfo,
      [STORAGE_KEYS.UPDATE_AVAILABLE]: normalizedInfo.hasUpdate,
      [STORAGE_KEYS.VERSION_INFO]: getVersionInfoPayload(normalizedInfo)
    });
    await syncBadge(normalizedInfo.hasUpdate);
    return normalizedInfo;
  }

  async function syncInstalledVersion(reason) {
    const currentVersion = getCurrentVersion();
    const state = await readStoredState();
    const nextInfo = normalizeStoredInfo(state.info, currentVersion);
    const updates = {};
    let needsPersist = false;

    if (state.info.currentVersion !== nextInfo.currentVersion || state.info.hasUpdate !== nextInfo.hasUpdate || state.info.latestVersion !== nextInfo.latestVersion || state.info.minSupportedVersion !== nextInfo.minSupportedVersion) {
      needsPersist = true;
    }

    const previousVersion = normalizeVersion(state.previousVersion);
    if (!previousVersion) {
      updates[STORAGE_KEYS.PREVIOUS_VERSION] = currentVersion;
    } else if (previousVersion !== currentVersion) {
      updates[STORAGE_KEYS.PREVIOUS_VERSION] = currentVersion;
      needsPersist = true;
    }

    if (needsPersist) {
      updates[STORAGE_KEYS.INFO] = nextInfo;
      updates[STORAGE_KEYS.UPDATE_AVAILABLE] = nextInfo.hasUpdate;
      updates[STORAGE_KEYS.VERSION_INFO] = getVersionInfoPayload(nextInfo);
    }

    if (Object.keys(updates).length > 0) {
      await chrome.storage.local.set(updates);
    }
    await syncBadge(nextInfo.hasUpdate);
    return {
      state,
      info: nextInfo
    };
  }

  async function fetchLatestPayload() {
    const response = await fetch(LATEST_JSON_URL, {
      cache: "no-store",
      headers: {
        Accept: "application/json"
      }
    });
    if (!response.ok) {
      throw new Error(`更新元数据请求失败（HTTP ${response.status}）。`);
    }
    return response.json();
  }

  async function performUpdateCheck(options) {
    const settings = options && typeof options === "object" ? options : {};
    const currentVersion = getCurrentVersion();
    const lifecycle = await syncInstalledVersion(settings.lifecycleReason || "");
    const cachedInfo = normalizeStoredInfo(lifecycle.info, currentVersion);

    if (shouldSkipNetworkCheck(cachedInfo, settings.force === true)) {
      log("check.skipped_recently", {
        reason: settings.reason || "unknown",
        lastCheckedAt: cachedInfo.lastCheckedAt
      });
      return {
        ok: true,
        info: cachedInfo,
        fromCache: true
      };
    }

    try {
      const rawPayload = await fetchLatestPayload();
      const normalizedInfo = normalizeLatestPayload(rawPayload, currentVersion);
      const persistedInfo = await persistInfo(normalizedInfo);
      log("check.success", {
        reason: settings.reason || "unknown",
        currentVersion,
        latestVersion: persistedInfo.latestVersion,
        hasUpdate: persistedInfo.hasUpdate,
        minSupportedVersion: persistedInfo.minSupportedVersion
      });
      return {
        ok: true,
        info: persistedInfo,
        fromCache: false
      };
    } catch (error) {
      const errorMessage = String(error?.message || error || "未知错误");
      log("check.failed", {
        reason: settings.reason || "unknown",
        error: errorMessage
      }, settings.silent ? "warn" : "error");
      if (!settings.silent) {
        throw error instanceof Error ? error : new Error(errorMessage);
      }
      return {
        ok: false,
        info: cachedInfo,
        error: errorMessage,
        fromCache: true
      };
    }
  }

  async function dismissUpdateBanner(version) {
    const currentDismissedVersion = normalizeVersion(version);
    await chrome.storage.local.set({
      [STORAGE_KEYS.DISMISSED_VERSION]: currentDismissedVersion
    });
  }

  async function initializeAlarm(forceEnabled) {
    if (!chrome.alarms?.create) {
      return;
    }
    const enabled = typeof forceEnabled === "boolean" ? forceEnabled : await isAutoCheckEnabled();
    if (!enabled) {
      await chrome.alarms.clear(ALARM_NAME);
      return;
    }
    await chrome.alarms.create(ALARM_NAME, {
      delayInMinutes: 1,
      periodInMinutes: CHECK_INTERVAL_MINUTES
    });
  }

  chrome.runtime.onInstalled.addListener(async function (details) {
    const reason = details?.reason || "";
    try {
      await initializeAlarm();
      if (!await isAutoCheckEnabled()) {
        await syncInstalledVersion(reason);
        return;
      }
      await performUpdateCheck({
        force: true,
        silent: true,
        reason: "onInstalled",
        lifecycleReason: reason
      });
    } catch (error) {
      log("install.init_failed", {
        reason,
        error: String(error?.message || error || "")
      }, "warn");
    }
  });

  chrome.runtime.onStartup.addListener(async function () {
    try {
      await initializeAlarm();
      if (!await isAutoCheckEnabled()) {
        await syncInstalledVersion("startup");
        return;
      }
      await performUpdateCheck({
        force: false,
        silent: true,
        reason: "onStartup",
        lifecycleReason: "startup"
      });
    } catch (error) {
      log("startup.init_failed", {
        error: String(error?.message || error || "")
      }, "warn");
    }
  });

  chrome.alarms?.onAlarm.addListener(function (alarm) {
    if (!alarm || alarm.name !== ALARM_NAME) {
      return;
    }
    isAutoCheckEnabled().then(function (enabled) {
      if (!enabled) {
        return initializeAlarm(false);
      }
      return performUpdateCheck({
        force: true,
        silent: true,
        reason: "alarm"
      });
    }).catch(function (error) {
      log("alarm.check_failed", {
        error: String(error?.message || error || "")
      }, "warn");
    });
  });

  chrome.storage.onChanged.addListener(function (changes, areaName) {
    if (areaName !== "local" || !changes[STORAGE_KEYS.AUTO_CHECK_ENABLED]) {
      return;
    }
    const enabled = changes[STORAGE_KEYS.AUTO_CHECK_ENABLED].newValue !== false;
    initializeAlarm(enabled).catch(function (error) {
      log("alarm.reconfigure_failed", {
        enabled,
        error: String(error?.message || error || "")
      }, "warn");
    });
  });

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    const type = message?.type;
    if (type === MESSAGE_TYPES.CHECK_NOW) {
      performUpdateCheck({
        force: true,
        silent: false,
        reason: "manual_check"
      }).then(function (result) {
        sendResponse({
          ok: true,
          info: result.info
        });
      }).catch(function (error) {
        sendResponse({
          ok: false,
          error: String(error?.message || error || "检查更新失败。")
        });
      });
      return true;
    }
    if (type === MESSAGE_TYPES.DISMISS) {
      dismissUpdateBanner(message?.version || "").then(function () {
        sendResponse({
          ok: true
        });
      }).catch(function (error) {
        sendResponse({
          ok: false,
          error: String(error?.message || error || "忽略更新失败。")
        });
      });
      return true;
    }
    return false;
  });

  (async function bootstrap() {
    try {
      await initializeAlarm();
      const state = await readStoredState();
      const currentVersion = getCurrentVersion();
      const info = normalizeStoredInfo(state.info, currentVersion);
      const fixedInfo = {
        ...createDefaultUpdateInfo(currentVersion),
        ...info,
        currentVersion,
        hasUpdate: computeHasUpdate(currentVersion, info.latestVersion),
        minSupportedVersion: info.minSupportedVersion || null
      };
      fixedInfo.hasUpdate = computeHasUpdate(fixedInfo.currentVersion, fixedInfo.latestVersion);
      if (isBlockedByMinVersion(fixedInfo.currentVersion, fixedInfo.minSupportedVersion)) {
        fixedInfo.hasUpdate = fixedInfo.hasUpdate || false;
      }
      await persistInfo(fixedInfo);
      await syncInstalledVersion("bootstrap");
    } catch (error) {
      log("bootstrap.failed", {
        error: String(error?.message || error || "")
      }, "warn");
    }
  })();
})();
