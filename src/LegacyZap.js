import QRCode from "easyqrcodejs";
import {
  nip19,
  nip57,
  generateSecretKey,
  finalizeEvent,
} from "nostr-tools";
import { SimplePool } from "nostr-tools/pool";

// ---------------------------------------------------------------------------
// Storage (localStorage cache)
// ---------------------------------------------------------------------------

const CACHE_PREFIX = "nostrZap.";
const LIGHTNING_URI_KEY = "lightningUri";

const isLocalStorageAvailable = () => typeof localStorage !== "undefined";

const getCachedValue = (key) => {
  if (!isLocalStorageAvailable()) return;
  return localStorage.getItem(`${CACHE_PREFIX}${key}`);
};

const setCachedValue = (key, value) => {
  if (!isLocalStorageAvailable()) return;
  localStorage.setItem(`${CACHE_PREFIX}${key}`, value);
};

const getCachedLightningUri = () => getCachedValue(LIGHTNING_URI_KEY);

const cacheLightningUri = (value) => setCachedValue(LIGHTNING_URI_KEY, value);

// ---------------------------------------------------------------------------
// Nostr helpers (nip19 + nip57)
// ---------------------------------------------------------------------------

export const decodeNpub = (npub) => nip19.decode(npub).data;

const decodeNip19Entity = (nip19Entity) => nip19.decode(nip19Entity).data;

let cachedProfileMetadata = {};

export const getProfileMetadata = async (authorId) => {
  if (cachedProfileMetadata[authorId]) {
    return cachedProfileMetadata[authorId];
  }

  const pool = new SimplePool();
  const relays = [
    "wss://relay.nostr.band",
    "wss://purplepag.es",
    "wss://relay.damus.io",
    "wss://nostr.wine",
  ];

  try {
    const ev = await pool.get(relays, {
      authors: [authorId],
      kinds: [0],
    });

    if (ev) cachedProfileMetadata[authorId] = ev;
    return ev;
  } catch (_error) {
    throw new Error("failed to fetch user profile :(");
  } finally {
    pool.close(relays);
  }
};

export const extractProfileMetadataContent = (profileMetadata) =>
  JSON.parse(profileMetadata.content);

export const getZapEndpoint = async (profileMetadata) => {
  const zapEndpoint = await nip57.getZapEndpoint(profileMetadata);

  if (!zapEndpoint) {
    throw new Error("failed to retrieve zap endpoint :(");
  }

  return zapEndpoint;
};

export const isNipO7ExtAvailable = () => {
  return typeof window !== "undefined" && window.nostr !== undefined;
};

const signEvent = async (zapEvent, anon) => {
  if (isNipO7ExtAvailable() && !anon) {
    try {
      return await window.nostr.signEvent(zapEvent);
    } catch (_e) {
      // fail silently and sign event as an anonymous user
    }
  }

  return finalizeEvent(zapEvent, generateSecretKey());
};

const makeZapEvent = async ({
  profile,
  nip19Target,
  amount,
  relays,
  comment,
  anon,
}) => {
  const eventTarget =
    nip19Target && (nip19Target.startsWith("note") || nip19Target.startsWith("nevent"))
      ? decodeNip19Entity(nip19Target)
      : undefined;

  const zapEvent = nip57.makeZapRequest({
    profile,
    event:
      typeof eventTarget === "string"
        ? eventTarget
        : eventTarget && typeof eventTarget === "object" && typeof eventTarget.id === "string"
          ? eventTarget.id
          : undefined,
    amount,
    relays,
    comment,
  });

  const naddrData =
    nip19Target && nip19Target.startsWith("naddr")
      ? decodeNip19Entity(nip19Target)
      : undefined;
  if (naddrData) {
    const relaysStr = naddrData.relays
      ? naddrData.relays.reduce((acc, r) => `${r},${acc}`, "")
      : "";
    zapEvent.tags.push([
      "a",
      `${naddrData.kind}:${naddrData.pubkey}:${naddrData.identifier}`,
      relaysStr,
    ]);
  }

  // add anon tag so apps like damus display zap as anonymous
  if (!isNipO7ExtAvailable() || anon) {
    zapEvent.tags.push(["anon"]);
  }

  return signEvent(zapEvent, anon);
};

export const fetchInvoice = async ({
  zapEndpoint,
  amount,
  comment,
  authorId,
  nip19Target,
  normalizedRelays,
  anon,
}) => {
  const zapEvent = await makeZapEvent({
    profile: authorId,
    nip19Target,
    amount,
    relays: normalizedRelays,
    comment,
    anon,
  });

  let url = `${zapEndpoint}?amount=${amount}&nostr=${encodeURIComponent(
    JSON.stringify(zapEvent)
  )}`;

  if (comment) {
    url = `${url}&comment=${encodeURIComponent(comment)}`;
  }

  const res = await fetch(url);
  const { pr: invoice, reason, status } = await res.json();

  if (invoice) {
    return invoice;
  } else if (status === "ERROR") {
    throw new Error(reason ?? "Unable to fetch invoice");
  } else {
    throw new Error("Unable to fetch invoice");
  }
};

export const listenForZapReceipt = ({ relays, invoice, onSuccess }) => {
  const pool = new SimplePool();
  const normalizedRelays = Array.from(
    new Set([...(relays || []), "wss://relay.nostr.band"])
  );
  const since = Math.round(Date.now() / 1000);

  const subcloser = pool.subscribeMany(
    normalizedRelays,
    [
      {
        kinds: [9735],
        since,
      },
    ],
    {
      onevent: (event) => {
        try {
          if (
            event?.tags?.find(
              (t) => t?.[0] === "bolt11" && t?.[1] === invoice
            )
          ) {
            onSuccess();
            subcloser.close();
            pool.close(normalizedRelays);
          }
        } catch (_e) {
          // ignore receipt parsing errors
        }
      },
      onclose: () => {},
    }
  );

  return () => {
    try {
      subcloser.close();
    } finally {
      pool.close(normalizedRelays);
    }
  };
};

// ---------------------------------------------------------------------------
// Legacy embedded zap dialog (UI)
// ---------------------------------------------------------------------------

let shadow = null;

const hexToRgb = (hex) => {
  hex = hex.replace(/^#/, "");

  if (hex.length === 3) {
    hex = hex
      .split("")
      .map((char) => char + char)
      .join("");
  }

  const bigint = parseInt(hex, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;

  return { r, g, b };
};
const getBrightness = ({ r, g, b }) => {
  return (r * 299 + g * 587 + b * 114) / 1000;
};

const getContrastingTextColor = (hex) => {
  const rgb = hexToRgb(hex);
  const brightness = getBrightness(rgb);
  return brightness < 128 ? "#fff" : "#000";
};

const renderDialog = (htmlStrTemplate) => {
  const dialog = document.createElement("dialog");

  dialog.classList.add("nostr-zap-dialog");
  dialog.innerHTML = htmlStrTemplate;

  // close dialog on backdrop click
  dialog.addEventListener("click", function ({ clientX, clientY }) {
    const { left, right, top, bottom } = dialog.getBoundingClientRect();

    if (clientX === 0 && clientY === 0) {
      return;
    }

    if (
      clientX < left ||
      clientX > right ||
      clientY < top ||
      clientY > bottom
    ) {
      dialog.close();
    }
  });

  shadow.appendChild(dialog);

  return dialog;
};

const showSuccessAndClose = (dialog, message = "Payment successful") => {
  try {
    if (!dialog) return;
    // Avoid double overlays
    if (dialog.querySelector(".success-overlay")) return;

    const overlay = document.createElement("div");
    overlay.className = "success-overlay";
    overlay.innerHTML = `
      <div class="success-card" role="status" aria-live="polite">
        <div class="success-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path class="success-check" d="M20 6L9 17l-5-5" />
          </svg>
        </div>
        <div class="success-title">${message}</div>
        <div class="success-sub">Closing in 3 seconds…</div>
      </div>
    `;

    dialog.appendChild(overlay);

    // Trigger CSS transition
    requestAnimationFrame(() => {
      overlay.classList.add("show");
    });

    setTimeout(() => {
      try {
        dialog.close();
      } catch {
        // ignore
      }
    }, 3000);
  } catch {
    // If anything goes wrong, fall back to closing.
    try {
      dialog.close();
    } catch {
      // ignore
    }
  }
};

const renderInvoiceDialog = ({ dialogHeader, invoice, relays, buttonColor }) => {
  const cachedLightningUri = getCachedLightningUri();
  const options = [
    { label: "Default Wallet", value: "lightning:" },
    { label: "Strike", value: "strike:lightning:" },
    { label: "Cash App", value: "https://cash.app/launch/lightning/" },
    { label: "Muun", value: "muun:" },
    { label: "Blue Wallet", value: "bluewallet:lightning:" },
    { label: "Wallet of Satoshi", value: "walletofsatoshi:lightning:" },
    { label: "Zebedee", value: "zebedee:lightning:" },
    { label: "Zeus LN", value: "zeusln:lightning:" },
    { label: "Phoenix", value: "phoenix://" },
    { label: "Breez", value: "breez:" },
    { label: "Bitcoin Beach", value: "bitcoinbeach://" },
    { label: "Blixt", value: "blixtwallet:lightning:" },
    { label: "River", value: "river://" },
  ];

  const invoiceDialog = renderDialog(`
        <button class="close-button" type="button" aria-label="Close">
          <svg class="close-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M6 6L18 18" />
            <path d="M18 6L6 18" />
          </svg>
        </button>
        ${dialogHeader}
        <div class="qrcode">
          <div class="overlay">copied invoice to clipboard</div>
        </div>
        <p>click QR code to copy invoice</p>
        <select name="lightning-wallet">
          ${options
            .map(
              ({ label, value }) =>
                `<option value="${value}" ${
                  cachedLightningUri === value ? "selected" : ""
                }>${label}</option>`
            )
            .join("")}
        </select>
        <button class="cta-button"
          ${
            buttonColor
              ? `style="background-color: ${buttonColor}; color: ${getContrastingTextColor(
                  buttonColor
                )}"`
              : ""
          } 
        >Open Wallet</button>
      `);

  const qrCodeEl = invoiceDialog.querySelector(".qrcode");
  const lightningWalletEl = invoiceDialog.querySelector(
    'select[name="lightning-wallet"]'
  );
  const ctaButtonEl = invoiceDialog.querySelector(".cta-button");
  const overlayEl = qrCodeEl.querySelector(".overlay");
  const closePool = listenForZapReceipt({
    relays,
    invoice,
    onSuccess: () => {
      showSuccessAndClose(invoiceDialog, "Zap received");
    },
  });

  // eslint-disable-next-line no-new
  new QRCode(qrCodeEl, { text: invoice, quietZone: 10 });

  qrCodeEl.addEventListener("click", function () {
    navigator.clipboard.writeText(invoice);
    overlayEl.classList.add("show");
    setTimeout(() => overlayEl.classList.remove("show"), 2000);
  });

  ctaButtonEl.addEventListener("click", function () {
    cacheLightningUri(lightningWalletEl.value);
    window.location.href = `${lightningWalletEl.value}${invoice}`;
  });

  invoiceDialog.addEventListener("close", function () {
    closePool();
    invoiceDialog.remove();
  });

  invoiceDialog
    .querySelector(".close-button")
    .addEventListener("click", function () {
      invoiceDialog.close();
    });

  return invoiceDialog;
};

const renderErrorDialog = (message, npub) => {
  const errorDialog = renderDialog(`
    <button class="close-button" type="button" aria-label="Close">
      <svg class="close-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M6 6L18 18" />
        <path d="M18 6L6 18" />
      </svg>
    </button>
    <p class="error-message">${message}</p>
    <a href="https://nosta.me/${npub}" target="_blank" rel="noreferrer">
      <button class="cta-button">View Nostr Profile</button>
    </a>
  `);

  errorDialog.addEventListener("close", function () {
    errorDialog.remove();
  });

  errorDialog
    .querySelector(".close-button")
    .addEventListener("click", function () {
      errorDialog.close();
    });

  return errorDialog;
};

const renderAmountDialog = async ({
  npub,
  nip19Target,
  relays,
  buttonColor,
  anon,
}) => {
  const truncateNip19Entity = (hex) =>
    `${hex.substring(0, 12)}...${hex.substring(hex.length - 12)}`;

  const normalizedRelays = relays
    ? relays.split(",")
    : ["wss://relay.nostr.band", "wss://relay.damus.io", "wss://nos.lol"];

  const authorId = decodeNpub(npub);
  const metadataPromise = getProfileMetadata(authorId);
  const nostrichAvatar =
    "https://pbs.twimg.com/profile_images/1604195803748306944/LxHDoJ7P_400x400.jpg";

  const getDialogHeader = async () => {
    const meta = await metadataPromise;
    const { picture, display_name, name } = extractProfileMetadataContent(meta);
    const userAvatar = picture || nostrichAvatar;

    return `
      <h2>${display_name || name}</h2>
        <img
          src="${userAvatar}"
          width="80"
          height="80"
          alt="nostr user avatar"
        />
      <p>${
        nip19Target
          ? truncateNip19Entity(nip19Target)
          : truncateNip19Entity(npub)
      }</p>
    `;
  };

  const amountDialog = renderDialog(`
      <button class="close-button" type="button" aria-label="Close">
        <svg class="close-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M6 6L18 18" />
          <path d="M18 6L6 18" />
        </svg>
      </button>
      <div class="dialog-header-container">
        <h2 class="skeleton-placeholder"></h2>
          <img
            src="${nostrichAvatar}"
            width="80"
            height="80"
            alt="placeholder avatar"
          />
        <p class="skeleton-placeholder"></p>
      </div>
      <div class="preset-zap-options-container">
        <button data-value="21">🌱 21 ⚡️</button>
        <button data-value="69">😎 69 ⚡️</button>
        <button data-value="210">✨ 210 ⚡️</button>
        <button data-value="420">🔥 420 ⚡️</button>
        <button data-value="1337">🚀 1337 ⚡️</button>
        <button data-value="5000">💎 5k ⚡️</button>
        <button data-value="10000">🐋 10k ⚡️</button>
        <button data-value="21000">🏆 21k ⚡️</button>
        <button data-value="1000000">👑 1M ⚡️</button>
      </div>
      <form>
        <input name="amount" type="number" placeholder="amount in sats" required />
        <input name="comment" placeholder="optional comment" />
        <div class="form-actions">
          <button class="cancel-button" type="button">Cancel</button>
          <button class="cta-button" 
            ${
              buttonColor
                ? `style="background-color: ${buttonColor}; color: ${getContrastingTextColor(
                    buttonColor
                  )}"`
                : ""
            } 
            type="submit" disabled>Zap</button>
        </div>
      </form>
    `);

  const presetButtonsContainer = amountDialog.querySelector(
    ".preset-zap-options-container"
  );
  const form = amountDialog.querySelector("form");
  const amountInput = amountDialog.querySelector('input[name="amount"]');
  const commentInput = amountDialog.querySelector('input[name="comment"]');
  const zapButtton = amountDialog.querySelector('button[type="submit"]');
  const cancelButton = amountDialog.querySelector('.cancel-button');
  const dialogHeaderContainer = amountDialog.querySelector(
    ".dialog-header-container"
  );

  const handleError = (error) => {
    amountDialog.close();
    const errorDialog = renderErrorDialog(error, npub);
    errorDialog.showModal();
  };

  getDialogHeader()
    .then((htmlString) => {
      dialogHeaderContainer.innerHTML = htmlString;
      zapButtton.disabled = false;
    })
    .catch(handleError);

  const setZapButtonToLoadingState = () => {
    zapButtton.disabled = true;
    zapButtton.innerHTML = `<div class="spinner">Loading</div>`;
  };
  const setZapButtonToDefaultState = () => {
    zapButtton.disabled = false;
    zapButtton.innerHTML = "Zap";
  };
  const setAmountValue = (value) => {
    amountInput.value = value;
  };

  amountDialog.addEventListener("close", function () {
    setZapButtonToDefaultState();
    form.reset();
  });

  amountDialog
    .querySelector(".close-button")
    .addEventListener("click", function () {
      amountDialog.close();
    });

  cancelButton?.addEventListener("click", function () {
    amountDialog.close();
  });

  presetButtonsContainer.addEventListener("click", function (event) {
    if (event.target.matches("button")) {
      setAmountValue(event.target.getAttribute("data-value"));
      amountInput.focus();
    }
  });

  const zapEndpoint = metadataPromise.then(getZapEndpoint);

  form.addEventListener("submit", async function (event) {
    event.preventDefault();
    setZapButtonToLoadingState();

    const amount = Number(amountInput.value) * 1000;
    const comment = commentInput.value;

    try {
      const invoice = await fetchInvoice({
        zapEndpoint: await zapEndpoint,
        amount,
        comment,
        authorId,
        nip19Target,
        normalizedRelays,
        anon,
      });

      const showInvoiceDialog = async () => {
        const invoiceDialog = renderInvoiceDialog({
          dialogHeader: await getDialogHeader(),
          invoice,
          relays: normalizedRelays,
          buttonColor,
        });
        const openWalletButton = invoiceDialog.querySelector(".cta-button");

        amountDialog.close();
        invoiceDialog.showModal();
        openWalletButton.focus();
      };

      if (window.webln) {
        try {
          await window.webln.enable();
          await window.webln.sendPayment(invoice);
          // WebLN paid successfully: show feedback before closing.
          setZapButtonToDefaultState();
          showSuccessAndClose(amountDialog, "Zap sent");
        } catch (_e) {
          showInvoiceDialog();
        }
      } else {
        showInvoiceDialog();
      }
    } catch (error) {
      handleError(error);
    }
  });

  return amountDialog;
};

export const init = async ({
  npub,
  noteId,
  naddr,
  relays,
  cachedAmountDialog,
  buttonColor,
  anon,
}) => {
  let amountDialog = cachedAmountDialog;

  try {
    if (!amountDialog) {
      amountDialog = await renderAmountDialog({
        npub,
        nip19Target: naddr ? naddr : noteId,
        relays,
        buttonColor,
        anon,
      });
    }

    amountDialog.showModal();

    if (!window.matchMedia("(max-height: 932px)").matches) {
      amountDialog.querySelector('input[name="amount"]').focus();
    }

    return amountDialog;
  } catch (error) {
    if (amountDialog) {
      amountDialog.close();
    }
    const errorDialog = renderErrorDialog(error, npub);
    errorDialog.showModal();
  }
};

export const initTarget = (targetEl) => {
  let cachedAmountDialog = null;
  let cachedParams = null;

  targetEl.addEventListener("click", async function () {
    const npub = targetEl.getAttribute("data-npub");
    const noteId = targetEl.getAttribute("data-note-id");
    const naddr = targetEl.getAttribute("data-naddr");
    const relays = targetEl.getAttribute("data-relays");
    const buttonColor = targetEl.getAttribute("data-button-color");
    const anon = targetEl.getAttribute("data-anon") === "true";

    if (cachedParams) {
      if (
        cachedParams.npub !== npub ||
        cachedParams.noteId !== noteId ||
        cachedParams.naddr !== naddr ||
        cachedParams.relays !== relays ||
        cachedParams.buttonColor !== buttonColor ||
        cachedParams.anon !== anon
      ) {
        cachedAmountDialog = null;
      }
    }

    cachedParams = { npub, noteId, naddr, relays, buttonColor, anon };

    cachedAmountDialog = await init({
      npub,
      noteId,
      naddr,
      relays,
      cachedAmountDialog,
      buttonColor,
      anon,
    });
  });
};

export const initTargets = (selector) => {
  document.querySelectorAll(selector || "[data-npub]").forEach(initTarget);
};

export const injectCSS = () => {
  if (typeof document === "undefined") return;
  if (shadow) return; // already injected

  const styleElement = document.createElement("style");

  styleElement.innerHTML = `
      .nostr-zap-dialog {
        width: 360px;
        max-width: calc(100vw - 24px);
        margin: auto;
        box-sizing: content-box;
        border: none;
        border-radius: 10px;
        padding: 22px;
        text-align: center;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
          Oxygen, Ubuntu, Cantarell, "Open Sans", "Helvetica Neue", sans-serif;
        background-color: white;
        position: relative;
        box-shadow: 0 10px 40px rgba(0, 0, 0, 0.18);
      }

      .nostr-zap-dialog::backdrop {
        background: rgba(0, 0, 0, 0.35);
        backdrop-filter: blur(2px);
      }
      .nostr-zap-dialog[open],
      .nostr-zap-dialog form {
        display: block;
        max-width: fit-content;
      }
      .nostr-zap-dialog form {
        padding: 0;
        width: 100%;
      }
      .nostr-zap-dialog img {
        display: inline;
        border-radius: 50%;
      }
      .nostr-zap-dialog h2 {
        font-size: 1.5em;
        font-weight: bold;
        color: black;
      }
      .nostr-zap-dialog p {
        font-size: 1em;
        font-weight: normal;
        color: black;
      }
      .nostr-zap-dialog h2,
      .nostr-zap-dialog p,
      .nostr-zap-dialog .skeleton-placeholder {
        margin: 4px;
        word-wrap: break-word;
      }
      .nostr-zap-dialog button {
        background-color: inherit;
        padding: 12px 0;
        border-radius: 5px;
        border: none;
        font-size: 16px;
        cursor: pointer;
        border: 1px solid rgb(226, 232, 240);
        width: 100px;
        max-width: 100px;
        max-height: 52px;
        white-space: nowrap;
        color: black;
        box-sizing: border-box;
      }
      .nostr-zap-dialog button:hover {
        background-color: #edf2f7;
      }
      .nostr-zap-dialog button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .nostr-zap-dialog .cta-button {
        background-color: #7f00ff;
        color: #fff;
        width: 100%;
        max-width: 100%;
        margin-top: 16px;
      }
      .nostr-zap-dialog .cta-button:hover {
        background-color: indigo;
      }

      .nostr-zap-dialog .form-actions {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 10px;
        margin-top: 12px;
      }

      .nostr-zap-dialog .form-actions button {
        width: 100%;
        max-width: none;
        min-width: 0;
      }

      .nostr-zap-dialog .form-actions .cta-button {
        margin-top: 0;
      }

      .nostr-zap-dialog .cancel-button {
        background: rgba(255, 255, 255, 0.85);
      }

      @media only screen and (max-width: 360px) {
        .nostr-zap-dialog .form-actions {
          grid-template-columns: 1fr;
        }
      }
      .nostr-zap-dialog .close-button {
        position: absolute;
        top: 6px;
        right: 6px;
        width: 36px;
        height: 36px;
        border: 1px solid rgb(226, 232, 240);
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.85);
        padding: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 1px 8px rgba(0, 0, 0, 0.06);
        -webkit-tap-highlight-color: transparent;
      }

      .nostr-zap-dialog .close-button:hover {
        background-color: #edf2f7;
      }

      .nostr-zap-dialog .close-button:active {
        transform: translateY(0.5px);
      }

      .nostr-zap-dialog .close-button:focus-visible {
        outline: none;
        box-shadow: 0 0 0 3px rgba(0, 0, 0, 0.12);
      }

      .nostr-zap-dialog .close-button .close-icon {
        width: 18px;
        height: 18px;
      }

      .nostr-zap-dialog .close-button .close-icon path {
        stroke: #555;
        stroke-width: 2.25;
        stroke-linecap: round;
      }
      .nostr-zap-dialog .preset-zap-options-container {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 10px;
        margin: 18px 0 10px 0;
        height: auto;
      }

      /* Make preset buttons fluid so the grid never breaks */
      .nostr-zap-dialog .preset-zap-options-container button {
        width: 100%;
        max-width: none;
        min-width: 0;
      }

      /* Comfortable tap targets */
      .nostr-zap-dialog .preset-zap-options-container button {
        height: 44px;
        padding: 10px 0;
      }
      .nostr-zap-dialog input {
        padding: 12px;
        border-radius: 5px;
        border: none;
        font-size: 16px;
        width: 100%;
        max-width: 100%;
        background-color: #f7fafc;
        color: #1a202c;
        box-shadow: none;
        box-sizing: border-box;
        margin-bottom: 16px;
        border: 1px solid lightgray;
      }
      .nostr-zap-dialog .spinner {
        display: flex;
        justify-content: center;
        align-items: center;
      }
      .nostr-zap-dialog .spinner:after {
        content: " ";
        display: block;
        width: 12px;
        height: 12px;
        border-radius: 50%;
        border: 4px solid #fff;
        border-color: #fff transparent #fff transparent;
        animation: nostr-zap-dialog-spinner 1.2s linear infinite;
        margin-left: 8px;
      }
      .nostr-zap-dialog .error-message {
        text-align: left;
        color: red;
        margin-top: 8px;
      }
      .nostr-zap-dialog .qrcode {
        position: relative;
        display: inline-block;
        margin-top: 24px;
      }
      .nostr-zap-dialog .qrcode .overlay {
        position: absolute;
        color: white;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background-color: rgba(127, 17, 224, 0.8);
        display: flex;
        justify-content: center;
        align-items: center;
        opacity: 0;
      }
      .nostr-zap-dialog .qrcode .overlay.show {
        opacity: 1;
      }

      /* Payment success overlay */
      .nostr-zap-dialog .success-overlay {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 18px;
        background: rgba(255, 255, 255, 0.72);
        backdrop-filter: blur(4px);
        opacity: 0;
        transform: scale(0.98);
        transition: opacity 180ms ease, transform 180ms ease;
      }

      .nostr-zap-dialog .success-overlay.show {
        opacity: 1;
        transform: scale(1);
      }

      .nostr-zap-dialog .success-card {
        width: 100%;
        max-width: 320px;
        border: 1px solid rgb(226, 232, 240);
        border-radius: 14px;
        background: rgba(255, 255, 255, 0.95);
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.14);
        padding: 18px 16px;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 10px;
      }

      .nostr-zap-dialog .success-icon {
        width: 56px;
        height: 56px;
        border-radius: 999px;
        background: rgba(34, 197, 94, 0.12);
        border: 1px solid rgba(34, 197, 94, 0.25);
        display: grid;
        place-items: center;
        animation: success-pop 520ms cubic-bezier(0.2, 0.8, 0.2, 1);
      }

      .nostr-zap-dialog .success-icon svg {
        width: 30px;
        height: 30px;
      }

      .nostr-zap-dialog .success-check {
        fill: none;
        stroke: #16a34a;
        stroke-width: 3;
        stroke-linecap: round;
        stroke-linejoin: round;
        stroke-dasharray: 40;
        stroke-dashoffset: 40;
        animation: success-draw 700ms 120ms ease forwards;
      }

      .nostr-zap-dialog .success-title {
        font-size: 1.05rem;
        font-weight: 700;
        color: #111;
      }

      .nostr-zap-dialog .success-sub {
        font-size: 0.9rem;
        color: #555;
      }

      @keyframes success-pop {
        0% { transform: scale(0.86); opacity: 0.2; }
        60% { transform: scale(1.06); opacity: 1; }
        100% { transform: scale(1); }
      }

      @keyframes success-draw {
        to { stroke-dashoffset: 0; }
      }
      @keyframes nostr-zap-dialog-spinner {
        0% {
          transform: rotate(0deg);
        }
        100% {
          transform: rotate(360deg);
        }
      }
      @keyframes nostr-zap-dialog-skeleton-pulse {
        0% {
          opacity: 0.6;
        }
        50% {
          opacity: 0.8;
        }
        100% {
          opacity: 0.6;
        }
      }
      .nostr-zap-dialog .skeleton-placeholder {
        animation-name: nostr-zap-dialog-skeleton-pulse;
        animation-duration: 1.5s;
        animation-iteration-count: infinite;
        animation-timing-function: ease-in-out;
        background-color: #e8e8e8;
        border-radius: 4px;
        margin: 4px auto;
      }
      .nostr-zap-dialog p.skeleton-placeholder {
        height: 20px;
        width: 200px;
      }
      .nostr-zap-dialog h2.skeleton-placeholder {
        height: 28px;
        width: 300px;
      }
      .nostr-zap-dialog select[name="lightning-wallet"] {
        appearance: none;
        background-color: white;
        background-image: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" fill="%232D3748" width="24" height="24" viewBox="0 0 24 24"><path d="M16.59 8.59L12 13.17 7.41 8.59 6 10l6 6 6-6z" /></svg>');
        background-repeat: no-repeat;
        background-position: right 0.7rem center;
        background-size: 16px;
        border: 1px solid #CBD5E0;
        padding: 0.5rem 1rem;
        font-size: 1rem;
        border-radius: 0.25rem;
        width: 100%;
        margin-top: 24px;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
        cursor: pointer;
      }
      .nostr-zap-dialog select[name="lightning-wallet"]:focus {
        outline: none;
        border-color: #4FD1C5;
        box-shadow: 0 0 0 2px #4FD1C5;
      }
      @media only screen and (max-width: 480px) {
        .nostr-zap-dialog {
          padding: 18px;
        }

        /* On small screens keep a clean grid */
        .nostr-zap-dialog .preset-zap-options-container {
          gap: 8px;
        }
      }
      @media only screen and (max-width: 413px) {
        .nostr-zap-dialog {
          width: calc(100vw - 18px);
        }

        /* Very narrow screens: 2 columns so labels never collide */
        .nostr-zap-dialog .preset-zap-options-container {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }
  `;

  const host = document.createElement("div");
  document.body.appendChild(host);
  shadow = host.attachShadow({ mode: "open" });
  shadow.appendChild(styleElement);
};

export const autoInitializeZapButtons = () => {
  if (typeof document === "undefined") return;

  const run = () => {
    injectCSS();
    initTargets();
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run, { once: true });
  } else {
    run();
  }
};

// Convenience for apps that want to skip the dialog in NIP-07 environments.
export const canUseNip07 = () => isNipO7ExtAvailable();

// ---------------------------------------------------------------------------
// Back-compat exports (old "nostr-zap" surface)
// ---------------------------------------------------------------------------

export {
  init as zapInit,
  initTarget as zapInitTarget,
  initTargets as zapInitTargets,
  injectCSS as zapInjectCSS,
};

// Back-compat object shape (similar to the original nostr-zap package)
export const nostrZap = {
  init,
  initTarget,
  initTargets,
  injectCSS,
  autoInitializeZapButtons,
  canUseNip07,
};

export const attachNostrZapToWindow = () => {
  if (typeof window === "undefined") return;
  window.nostrZap = nostrZap;
};

export const autoInitialize = () => {
  attachNostrZapToWindow();
  autoInitializeZapButtons();
};
