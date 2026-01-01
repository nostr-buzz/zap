import { ProfileUI } from "./ui/ProfileUI.js";
import { ZapListUI } from "./ui/ZapListUI.js";
import { DialogComponents } from "./DialogComponents.js";
import { APP_CONFIG } from "./AppConfig.js";
import styles from "./styles/styles.css";
import { escapeHTML, formatIdentifier, safeNip19Decode, sanitizeImageUrl, getProfileDisplayName } from "./utils.js";  // isValidCount removed
import { cacheManager } from "./CacheManager.js";
import { subscriptionManager } from "./ZapManager.js"; // Import subscription manager
import { eventPool } from "./EventPool.js";
import { profilePool } from "./ProfilePool.js";
import defaultIcon from "./assets/nostr-icon.svg";

class NostrZapViewDialog extends HTMLElement {
  #state;
  #initializationPromise;

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    
    this.#state = {
      isInitialized: false,
      theme: APP_CONFIG.DEFAULT_OPTIONS.theme,
    };

    this.popStateHandler = (e) => {
      e.preventDefault();
      if (this.#getElement(".dialog")?.open) {
        this.closeDialog();
      }
    };
  }

  async connectedCallback() {
    this.viewId = this.getAttribute("data-view-id");
    if (!this.viewId) {
      console.error("No viewId provided to dialog");
      return;
    }

    // Store initialization as a trackable Promise
    this.#initializationPromise = this.#initializeBasicDOM();
    
    try {
      await this.#initializationPromise;
      this.#state.isInitialized = true;
      
      // Initialize the full UI
      const config = subscriptionManager.getViewConfig(this.viewId);
      if (!config) {
        throw new Error("Config is required for initialization");
      }
      await this.#initializeFullUI(config);
      
      this.#state.isInitialized = true;
      this.dispatchEvent(new CustomEvent('dialog-initialized', { 
        detail: { viewId: this.viewId }
      }));
    } catch (error) {
      console.error("Dialog initialization failed:", error);
    }
  }


  async #initializeBasicDOM() {
    return new Promise(resolve => {
      // Initialize the basic dialog structure
      const template = document.createElement("template");
      template.innerHTML = DialogComponents.getDialogTemplate();
      this.shadowRoot.appendChild(template.content.cloneNode(true));
      
      this.#setupEventListeners();
      
      // Resolve on a microtask to ensure DOM is attached
      queueMicrotask(() => resolve());
    });
  }

  async #initializeFullUI(config) {

    // Add stylesheet
    const styleSheet = document.createElement("style");
    styleSheet.textContent = styles;
    this.shadowRoot.appendChild(styleSheet);

    // Initialize UI components
    this.profileUI = new ProfileUI();
    this.zapListUI = new ZapListUI(this.shadowRoot, this.profileUI, this.viewId, config);

    subscriptionManager.setZapListUI(this.zapListUI);

    // After initializing UI components, fetch the correct events by viewId
    const zapEvents = cacheManager.getZapEvents(this.viewId);

    if (!zapEvents?.length) {
      this.zapListUI.showNoZapsMessage();
    } else {
      await this.zapListUI.renderZapListFromCache(zapEvents);
    }

  }

  static get observedAttributes() {
    return ["data-theme"];
  }

  #setupEventListeners() {
    const dialog = this.#getElement(".dialog");
    const closeButton = this.#getElement(".close-dialog-button");

    closeButton.addEventListener("click", () => this.closeDialog());
    dialog.addEventListener("click", (e) => {
      if (e.target === dialog) this.closeDialog();
    });

    dialog.addEventListener("cancel", (e) => {
      e.preventDefault();
      this.closeDialog();
    });

    // Add scroll control for the Space key
    document.addEventListener("keydown", (e) => {
      if (dialog?.open) {
        if (e.key === "Escape") {
          this.closeDialog();
        } else if (e.key === " ") {
          e.preventDefault();
          const zapList = this.#getElement(".dialog-zap-list");
          if (zapList) {
            zapList.scrollTop += zapList.clientHeight * 0.8;
          }
        }
      }
    });
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue) return;

    switch (name) {
      case "data-theme":
        this.#updateTheme(newValue);
        break;
    }
  }

  #updateTheme(theme) {
    const state = cacheManager.updateThemeState(this.viewId, { theme });
    if (state.isInitialized) {
      this.#applyTheme();
    }
  }

  #applyTheme() {
    const state = cacheManager.getThemeState(this.viewId);
    const themeClass = state.theme === "dark" ? "dark-theme" : "light-theme";
    this.shadowRoot.host.classList.add(themeClass);
  }

  // Public API methods
  async showDialog() {
    await this.#initializationPromise; // Wait for basic initialization
    const dialog = this.#getElement(".dialog");
    if (!dialog || dialog.open || !this.#state.isInitialized) {
      console.warn("Cannot show dialog - not properly initialized");
      return;
    }

    window.addEventListener("popstate", this.popStateHandler);

    dialog.showModal();
    queueMicrotask(() => {
      if (document.activeElement) {
        document.activeElement.blur();
      }
    });
    this.#updateDialogTitle();

    // If the target is a note/nevent, render a small post preview at the top.
    // This is intentionally non-blocking (we don't want to delay opening the dialog).
    this.#maybeRenderTargetNotePreview();
    
  }

  closeDialog() {
    const dialog = this.#getElement(".dialog");
    if (dialog?.open) {
      this.zapListUI?.destroy();
      // Only clean up UI; keep caches intact
      subscriptionManager.unsubscribe(this.viewId);
      dialog.close();
      this.remove();
      window.removeEventListener("popstate", this.popStateHandler);
    }
  }


  async #maybeRenderTargetNotePreview() {
    const previewEl = this.#getElement(".note-preview");
    if (!previewEl) return;

    const identifier = this.getAttribute("data-nzv-id") || "";
    if (!identifier) {
      previewEl.hidden = true;
      previewEl.innerHTML = "";
      return;
    }

    const decoded = safeNip19Decode(identifier);
    const isNoteTarget = decoded?.type === "note" || decoded?.type === "nevent";
    if (!isNoteTarget) {
      previewEl.hidden = true;
      previewEl.innerHTML = "";
      return;
    }

    const eventId = decoded.type === "note" ? decoded.data : decoded.data?.id;
    if (!eventId) {
      previewEl.hidden = true;
      previewEl.innerHTML = "";
      return;
    }

    const cfg = subscriptionManager.getViewConfig(this.viewId);
    const relays = Array.isArray(cfg?.relayUrls) ? cfg.relayUrls : [];
    if (!relays.length) {
      previewEl.hidden = true;
      previewEl.innerHTML = "";
      return;
    }

    previewEl.hidden = false;
    previewEl.innerHTML = `
      <div class="note-preview-card">
        <div class="note-preview-loading">Loading post…</div>
      </div>
    `;

    try {
      const ev = await eventPool.zapPool.get(relays, { ids: [eventId], limit: 1 });
      if (!ev || typeof ev.content !== "string") {
        previewEl.hidden = true;
        previewEl.innerHTML = "";
        return;
      }

      const pubkey = typeof ev.pubkey === "string" ? ev.pubkey : "";
      let profile = null;
      if (pubkey && pubkey.length === 64) {
        try {
          const results = await profilePool.fetchProfiles([pubkey]);
          profile = Array.isArray(results) ? results[0] : null;
        } catch (_e) {
          profile = null;
        }
      }

      const displayName = escapeHTML(getProfileDisplayName(profile) || "anonymous");
      const lnurlRaw = profile?.lud16 || profile?.lud06;
      let lnurl = lnurlRaw ? escapeHTML(String(lnurlRaw)) : "";
      // If it's a long lnurl (lud06), keep it compact.
      if (lnurl && lnurl.length > 42) {
        lnurl = `${lnurl.slice(0, 18)}…${lnurl.slice(-14)}`;
      }

      const pictureUrl = profile?.picture ? sanitizeImageUrl(profile.picture) : null;
      const avatarSrc = pictureUrl || defaultIcon;

      const media = this.#buildNoteMedia(ev.content || "");
      const contentHtml = this.#formatNoteContent(ev.content || "", media?.stripUrl);

      previewEl.hidden = false;
      previewEl.innerHTML = `
        <div class="note-preview-card">
          <div class="note-preview-header">
            <img class="note-preview-avatar" src="${avatarSrc}" alt="${displayName}" loading="lazy" />
            <div class="note-preview-author">
              <div class="note-preview-name" title="${displayName}">${displayName}</div>
              ${lnurl ? `<div class="note-preview-lnurl" title="lnurl">⚡ ${lnurl}</div>` : ""}
            </div>
          </div>

          ${media?.html ? `<div class="note-preview-media">${media.html}</div>` : ""}
          <div class="note-preview-content">${contentHtml}</div>
        </div>
      `;
    } catch (_e) {
      previewEl.hidden = true;
      previewEl.innerHTML = "";
    }
  }

  #sanitizeHttpUrl(url) {
    if (!url || typeof url !== "string") return null;
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) return null;
      return parsed.href;
    } catch {
      return null;
    }
  }

  #extractUrls(text) {
    if (!text || typeof text !== "string") return [];
    // Conservative URL matcher (good enough for Nostr note content).
    const matches = text.match(/https?:\/\/[^\s<>()\[\]"']+/g) || [];
    const unique = [];
    const seen = new Set();
    for (const raw of matches) {
      const sanitized = this.#sanitizeHttpUrl(raw);
      if (!sanitized) continue;
      if (seen.has(sanitized)) continue;
      seen.add(sanitized);
      unique.push(sanitized);
      if (unique.length >= 12) break;
    }
    return unique;
  }

  #getYoutubeId(url) {
    const safe = this.#sanitizeHttpUrl(url);
    if (!safe) return null;
    try {
      const u = new URL(safe);
      const host = u.hostname.replace(/^www\./, "").toLowerCase();

      if (host === "youtu.be") {
        const id = (u.pathname.split("/").filter(Boolean)[0] || "").trim();
        return id && id.length >= 8 ? id : null;
      }

      if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
        // watch?v=
        const v = u.searchParams.get("v");
        if (v) return v;

        // /shorts/<id>
        const parts = u.pathname.split("/").filter(Boolean);
        if (parts[0] === "shorts" && parts[1]) return parts[1];
        if (parts[0] === "embed" && parts[1]) return parts[1];
      }
    } catch {
      return null;
    }
    return null;
  }

  #buildNoteMedia(content) {
    const urls = this.#extractUrls(content);
    if (!urls.length) return null;

    // Priority: YouTube > video > image
    for (const url of urls) {
      const youtubeId = this.#getYoutubeId(url);
      if (youtubeId) {
        const safeId = escapeHTML(youtubeId);
        return {
          type: "youtube",
          stripUrl: url,
          html: `<iframe src="https://www.youtube-nocookie.com/embed/${safeId}" title="YouTube video" loading="lazy" referrerpolicy="no-referrer" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>`,
        };
      }
    }

    for (const url of urls) {
      const lower = url.toLowerCase();
      if (lower.match(/\.(mp4|webm)(\?|#|$)/)) {
        return {
          type: "video",
          stripUrl: url,
          html: `<video src="${escapeHTML(url)}" controls playsinline preload="metadata"></video>`,
        };
      }
    }

    for (const url of urls) {
      const lower = url.toLowerCase();
      if (lower.match(/\.(png|jpe?g|gif|webp|avif)(\?|#|$)/)) {
        return {
          type: "image",
          stripUrl: url,
          html: `<img src="${escapeHTML(url)}" alt="Post media" loading="lazy" />`,
        };
      }
    }

    return null;
  }

  #formatNoteContent(raw, stripUrl = null) {
    const text = typeof raw === "string" ? raw : "";
    let cleaned = text;

    if (stripUrl && typeof stripUrl === "string") {
      // Remove the first media url from content to reduce duplication.
      cleaned = cleaned.split(stripUrl).join("");
    }

    cleaned = cleaned.trim();
    if (!cleaned) return "<span class=\"note-preview-empty\">(no text)</span>";

    // Keep it compact: the preview should not dominate the modal.
    const max = 520;
    const clipped = cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
    return escapeHTML(clipped).replace(/\n/g, "<br>");
  }

  #getElement(selector) {
    return this.shadowRoot.querySelector(selector);
  }

  #updateDialogTitle() {
    const viewId = this.getAttribute("data-view-id");
    const fetchButton = document.querySelector(
      `button[data-zap-view-id="${viewId}"]`
    );
    if (!fetchButton) return;

    const titleContainer = this.#getElement(".dialog-title");
    const title = this.#getElement(".dialog-title a");
    if (!title || !titleContainer) return;

    const customTitle = fetchButton.getAttribute("data-title");
    const identifier = fetchButton.getAttribute("data-nzv-id");

    // Some integrators set data-title to the page hostname (e.g. "osats.money").
    // That looks odd as a dialog title, so ignore titles that match the current host.
    const host = (window.location?.hostname || "").replace(/^www\./i, "").toLowerCase();
    const normalizedCustomTitle = (customTitle || "")
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .replace(/\/.*/, "");
    const effectiveCustomTitle = (normalizedCustomTitle && host && normalizedCustomTitle === host)
      ? ""
      : (customTitle || "");

    // For note/nevent targets, avoid linking out to external clients.
    const decoded = identifier ? safeNip19Decode(identifier) : null;
    const isNoteTarget = decoded?.type === "note" || decoded?.type === "nevent";
    if (isNoteTarget) {
      title.href = "#";
      title.removeAttribute("target");
      title.removeAttribute("rel");
      title.style.cursor = "default";
    } else {
      title.href = identifier ? `https://njump.me/${identifier}` : "#";
      title.setAttribute("target", "_blank");
      title.setAttribute("rel", "noreferrer");
      title.style.cursor = "pointer";
    }
    
    if (effectiveCustomTitle?.trim()) {
      title.textContent = effectiveCustomTitle;
      titleContainer.classList.add("custom-title");
    } else {
      title.textContent = APP_CONFIG.DIALOG_CONFIG.DEFAULT_TITLE + formatIdentifier(identifier);
      titleContainer.classList.remove("custom-title");
    }
  }

  // UI operation methods
  getOperations() {
    // Basic initialization check
    if (!this.#state.isInitialized) {
      console.warn(`Basic initialization not complete for viewId: ${this.viewId}`);
      return null;
    }

    const operations = {
      closeDialog: () => this.closeDialog(),
      showDialog: () => this.showDialog(),
    };

    // Provide additional operations only when initialization is complete
    if (this.#state.isInitialized) {
      Object.assign(operations, {
        prependZap: (event) => this.zapListUI?.prependZap(event),
        showNoZapsMessage: () => this.zapListUI?.showNoZapsMessage(),
        showErrorMessage: (message) => this.zapListUI?.showErrorMessage(message),
      });
    }

    return operations;
  }

  // Wait for initialization to complete
  async waitForInitialization() {
    return this.#initializationPromise;
  }
}

customElements.define("nzv-dialog", NostrZapViewDialog);

// Helper functions for dialog operations
const dialogManager = {
  create: async (viewId, config) => {
    
    if (!viewId || !config) {
      console.error('Invalid viewId or config:', { viewId, config });
      return Promise.reject(new Error('Invalid viewId or config'));
    }

    // Set config first
    subscriptionManager.setViewConfig(viewId, config);

    const existingDialog = document.querySelector(`nzv-dialog[data-view-id="${viewId}"]`);
    if (existingDialog) return existingDialog;

    const dialog = document.createElement("nzv-dialog");
    dialog.setAttribute("data-view-id", viewId);
    dialog.setAttribute("data-config", JSON.stringify(config));

    const button = document.querySelector(`button[data-zap-view-id="${viewId}"]`);
    if (button?.getAttribute("data-nzv-id")) {
      dialog.setAttribute("data-nzv-id", button.getAttribute("data-nzv-id"));
    }

    document.body.appendChild(dialog);
    await dialog.waitForInitialization();
    
    return dialog;
  },

  get: (viewId) => document.querySelector(`nzv-dialog[data-view-id="${viewId}"]`),

  execute: (viewId, operation, ...args) => {
    const dialog = dialogManager.get(viewId);
    const operations = dialog?.getOperations();
    if (!operations) {
      console.warn(`Dialog operations not available for ${viewId}`);
      return null;
    }
    return operations[operation]?.(...args) ?? null;
  }
};

// Public API is async
export async function createDialog(viewId) {
  try {
    const config = subscriptionManager.getViewConfig(viewId);
    if (!config) {
      throw new Error(`View configuration not found for viewId: ${viewId}`);
    }

    // Set config first
    subscriptionManager.setViewConfig(viewId, config);

    const dialog = await dialogManager.create(viewId, config);

    return dialog;
  } catch (error) {
    console.error('[Dialog] Creation failed:', error);
    return null;
  }
}

export async function showDialog(viewId) {
  try {
    const dialog = dialogManager.get(viewId);
    if (!dialog) {
      throw new Error('Dialog not found');
    }

    // Only wait for basic initialization
    await dialog.waitForInitialization();
    const operations = dialog.getOperations();
    if (!operations?.showDialog) {
      throw new Error('Basic dialog operations not available');
    }

    operations.showDialog();
  } catch (error) {
    console.error('Failed to show dialog:', error);
  }
}

// Export helpers
export const closeDialog = (viewId) => {
  const dialog = dialogManager.get(viewId);
  if (dialog) {
    subscriptionManager.unsubscribe(viewId);
    dialog.closeDialog();
  }
};
export const replacePlaceholderWithZap = (event, index, viewId) => 
  dialogManager.execute(viewId, 'replacePlaceholderWithZap', event, index);
export const prependZap = (event, viewId) => dialogManager.execute(viewId, 'prependZap', event);
export const showNoZapsMessage = (viewId) => {
  const dialog = dialogManager.get(viewId);
  const operations = dialog?.getOperations();
  if (!operations?.showNoZapsMessage) return;
  operations.showNoZapsMessage();
};

// Used by src/index.js to surface friendly validation / runtime errors.
export const showErrorMessage = (message, viewId) => {
  const dialog = dialogManager.get(viewId);
  const operations = dialog?.getOperations();
  if (!operations?.showErrorMessage) return;
  operations.showErrorMessage(message);
};
