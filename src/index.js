import {
  APP_CONFIG,
  ViewerConfig
} from "./AppConfig.js";
import {
  createDialog,
  showDialog,
  showErrorMessage,
} from "./UIManager.js";
import { subscriptionManager } from "./ZapManager.js";
import { profilePool } from "./ProfilePool.js";
import { eventPool } from "./EventPool.js";
import { cacheManager } from "./CacheManager.js";

import {
  autoInitialize as autoInitializeNostrZap,
  nostrZap as nostrZapApi,
  zapInit,
  zapInitTarget,
  zapInitTargets,
  zapInjectCSS,
  autoInitializeZapButtons,
  canUseNip07,
} from "./LegacyZap.js";

// Viewer initialization helpers
async function initializeViewer(viewId, config) {
  const cachedEvents = cacheManager.getZapEvents(viewId);
  if (cachedEvents.length > 0) {
    const pubkeys = [...new Set(cachedEvents.map(event => event.pubkey))];
    profilePool.fetchProfiles(pubkeys);
  }

  const { hasEnoughCachedEvents } = await cacheManager.processCachedData(
    viewId,
    config,
  );

  if (hasEnoughCachedEvents) {
    subscriptionManager.setupInfiniteScroll(viewId);
  }

  return hasEnoughCachedEvents;
}

async function handleButtonClick(button, viewId) {
  try {
    const config = ViewerConfig.fromButton(button);
    if (!config) {
      throw new Error('Failed to create config from button');
    }

    subscriptionManager.setViewConfig(viewId, config);
    const dialog = await createDialog(viewId, config);

    if (!dialog) {
      throw new Error(APP_CONFIG.ZAP_CONFIG.ERRORS.DIALOG_NOT_FOUND);
    }

    await showDialog(viewId);

    // Validate config early and surface a friendly message.
    if (!config.identifier || !String(config.identifier).trim()) {
      showErrorMessage(APP_CONFIG.ZAP_CONFIG.ERRORS.DECODE_FAILED, viewId);
      return;
    }
    if (!Array.isArray(config.relayUrls) || config.relayUrls.length === 0) {
      showErrorMessage(APP_CONFIG.ZAP_CONFIG.ERRORS.RELAYS_REQUIRED, viewId);
      return;
    }

    // Run async initialization without blocking the click handler
    setTimeout(async () => {
      try {
        await initializeViewer(viewId, config);

        if (!button.hasAttribute("data-initialized")) {
          const identifier = button.getAttribute("data-nzv-id");
          await Promise.all([
            eventPool.connectToRelays(config.relayUrls),
            subscriptionManager.initializeSubscriptions(config, viewId),
          ]);
          button.setAttribute("data-initialized", "true");
        }
      } catch (error) {
        const message =
          error?.message ||
          (typeof error === "string" ? error : "Initialization failed");
        showErrorMessage(message, viewId);
        console.error("Async initialization failed:", error);
      }
    }, 0);
  } catch (error) {
    console.error(`Failed to handle click for viewId ${viewId}:`, error);
  }
}

function initializeApp() {
  Object.entries(APP_CONFIG.LIBRARIES).forEach(([key, value]) => {
    window[key] = value;
  });

  document.querySelectorAll("button[data-nzv-id]").forEach((button, index) => {
    if (button.hasAttribute("data-zap-view-id")) return;

    const viewId = `nostr-zap-${index}`;
    button.setAttribute("data-zap-view-id", viewId);

    // If data-zap-color-mode is missing, apply the default
    if (!button.hasAttribute("data-zap-color-mode")) {
      button.setAttribute("data-zap-color-mode", APP_CONFIG.ZAP_CONFIG.DEFAULT_COLOR_MODE);
    }

    button.addEventListener("click", () => handleButtonClick(button, viewId));
  });
}

if (typeof window !== 'undefined') {
  document.addEventListener("DOMContentLoaded", initializeApp);
}

// Auto-wire zap buttons as well (formerly provided by the external nostr-zap script)
autoInitializeNostrZap();

// Export all the modules and classes that are declared in the type definitions
export { APP_CONFIG, ViewerConfig } from "./AppConfig.js";
export { profilePool } from "./ProfilePool.js";
export { eventPool } from "./EventPool.js";
export { subscriptionManager } from "./ZapManager.js";
export { cacheManager } from "./CacheManager.js";

// nostr-zap (merged)
export {
  nostrZapApi as nostrZap,
  zapInit,
  zapInitTarget,
  zapInitTargets,
  zapInjectCSS,
  autoInitializeZapButtons,
  canUseNip07,
};

// Public initialization API
export function initialize(options = {}) {
  // Merge user options into the default config
  Object.assign(APP_CONFIG, options);

  if (typeof window !== 'undefined') {
    initializeApp();
  }
}

// Keep the original function name for backward compatibility
export function nostrZapView(options = {}) {
  return initialize(options);
}
