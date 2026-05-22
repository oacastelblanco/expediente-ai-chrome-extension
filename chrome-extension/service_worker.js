const DEFAULT_BACKEND_URL = "http://localhost:3001/api/draft";
const SERVICE_WORKER_PATH = new URL(import.meta.url).pathname;
const CONTENT_SCRIPT_FILE = SERVICE_WORKER_PATH.includes("/chrome-extension/")
  ? "chrome-extension/contentScript.js"
  : "contentScript.js";

function installPdfDownloadInterceptor() {
  if (window.__expedienteAiPdfInterceptorInstalled) return;
  window.__expedienteAiPdfInterceptorInstalled = true;
  window.__expedienteAiCapturePdfUntil = 0;

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.data?.source !== "EXPEDIENTE_AI_ARM_PDF_CAPTURE") return;

    window.__expedienteAiCapturePdfUntil = Date.now() + Number(event.data.timeoutMs || 20000);
  });

  const shouldCapture = (source, value, meta = {}) => {
    const contentType = String(meta.contentType || value?.type || "").toLowerCase();
    const url = String(meta.url || "").toLowerCase();
    const isPdfLike = contentType.includes("pdf") || url.includes(".pdf");
    const isArmed = Date.now() < window.__expedienteAiCapturePdfUntil;
    const size = value?.size || value?.byteLength || value?.length || 0;

    return isPdfLike || (isArmed && size > 1000 && source !== "tiny-value");
  };

  const postPdf = async (source, value, filename = "expediente.pdf", meta = {}) => {
    try {
      let blob = null;

      if (value instanceof Blob) {
        blob = value;
      } else if (value instanceof ArrayBuffer) {
        blob = new Blob([value], { type: "application/pdf" });
      } else if (value?.buffer instanceof ArrayBuffer) {
        blob = new Blob([value.buffer], { type: "application/pdf" });
      }

      if (!blob) return;
      if (!shouldCapture(source, blob, meta)) return;

      window.__expedienteAiCapturePdfUntil = 0;

      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });

      window.postMessage({
        source: "EXPEDIENTE_AI_PDF_CAPTURE",
        pdfBase64: dataUrl.split(",")[1] || "",
        filename,
        captureSource: source,
        byteLength: blob.size
      }, "*");
    } catch (error) {
      window.postMessage({
        source: "EXPEDIENTE_AI_PDF_CAPTURE_ERROR",
        error: error?.message || "No se pudo capturar el PDF."
      }, "*");
    }
  };

  const originalCreateObjectURL = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (object) => {
    const objectUrl = originalCreateObjectURL(object);
    if (object instanceof Blob) {
      postPdf("blob-url", object, "expediente.pdf", { url: objectUrl, contentType: object.type });
    }
    return objectUrl;
  };

  const originalFetch = window.fetch?.bind(window);
  if (originalFetch) {
    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
      const contentType = response.headers?.get("content-type") || "";

      if (shouldCapture("fetch", { size: Number(response.headers?.get("content-length") || 2000) }, { url, contentType })) {
        response.clone().blob().then((blob) => {
          postPdf("fetch", blob, "expediente.pdf", { url, contentType });
        }).catch(() => {});
      }

      return response;
    };
  }

  const OriginalXHR = window.XMLHttpRequest;
  if (OriginalXHR) {
    window.XMLHttpRequest = function PatchedXMLHttpRequest() {
      const xhr = new OriginalXHR();
      xhr.addEventListener("load", () => {
        try {
          const contentType = xhr.getResponseHeader("content-type") || "";
          const url = xhr.responseURL || "";

          if (xhr.response instanceof Blob || xhr.response instanceof ArrayBuffer) {
            postPdf("xhr", xhr.response, "expediente.pdf", { url, contentType });
            return;
          }

          if (typeof xhr.response === "string" && shouldCapture("xhr-text", xhr.response, { url, contentType })) {
            const text = xhr.response;
            if (text.startsWith("%PDF") || contentType.toLowerCase().includes("pdf")) {
              postPdf("xhr-text", new TextEncoder().encode(text), "expediente.pdf", { url, contentType });
            }
          }
        } catch (_error) {
          // The visible page text remains available if PDF capture fails.
        }
      });
      return xhr;
    };
  }
}

async function enableSidePanelOnActionClick() {
  if (!chrome.sidePanel?.setPanelBehavior) return;

  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (error) {
    console.warn("No se pudo configurar la barra lateral.", error);
  }
}

enableSidePanelOnActionClick();
chrome.runtime.onInstalled.addListener(enableSidePanelOnActionClick);
chrome.runtime.onStartup.addListener(enableSidePanelOnActionClick);

chrome.action.onClicked.addListener(async (tab) => {
  if (!chrome.sidePanel?.open || !tab?.windowId) return;

  try {
    await chrome.sidePanel.open({ windowId: tab.windowId });
  } catch (error) {
    console.warn("No se pudo abrir la barra lateral.", error);
  }
});

async function getBackendUrl() {
  const stored = await chrome.storage.sync.get(["backendUrl"]);
  return stored.backendUrl || DEFAULT_BACKEND_URL;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No se encontro una pestana activa.");
  return tab;
}

function assertReadableTab(tab) {
  const url = tab.url || "";
  const restrictedProtocols = [
    "chrome://",
    "chrome-extension://",
    "edge://",
    "about:",
    "devtools://"
  ];

  if (restrictedProtocols.some((protocol) => url.startsWith(protocol))) {
    throw new Error("Chrome no permite leer paginas internas como chrome://extensions. Abre una pagina web normal o el sistema de expediente y vuelve a presionar Leer expediente.");
  }
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "PING" });
  } catch (_error) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [CONTENT_SCRIPT_FILE]
    });
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: installPdfDownloadInterceptor
  });
}

function getPdfTextUrl(backendUrl) {
  if (backendUrl.endsWith("/api/draft")) {
    return backendUrl.replace(/\/api\/draft$/, "/api/pdf-text");
  }

  return new URL("/api/pdf-text", backendUrl).toString();
}

function normalizeSpaces(value) {
  return (value || "").replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim();
}

function valueBetween(text, startPattern, endPatterns) {
  const startMatch = text.match(startPattern);
  if (!startMatch) return "";

  const startIndex = startMatch.index + startMatch[0].length;
  const rest = text.slice(startIndex);
  let endIndex = rest.length;

  for (const pattern of endPatterns) {
    const match = rest.match(pattern);
    if (match?.index >= 0 && match.index < endIndex) {
      endIndex = match.index;
    }
  }

  return normalizeSpaces(rest.slice(0, endIndex).replace(/^[:\s]+/, ""));
}

function extractCaseMetadata(text) {
  const normalized = normalizeSpaces(text);
  const lines = normalized.split("\n").map((line) => line.trim()).filter(Boolean);
  const judicatura = lines.find((line) => /UNIDAD JUDICIAL|JUZGADO|TRIBUNAL|SALA/i.test(line)) || "";

  return {
    judicatura,
    numeroProceso: valueBetween(normalized, /No\.\s*proceso\s*:?\s*/i, [
      /\nNo\.\s*de\s*ingreso\s*:?\s*/i,
      /\nTipo\s+de\s+materia\s*:?\s*/i
    ]),
    procedimiento: valueBetween(normalized, /Tipo\s+acci[oó]n\/procedimiento\s*:?\s*/i, [
      /\nTipo\s+asunto\/delito\s*:?\s*/i,
      /\nActor\(es\)\/Ofendido\(s\)\s*:?\s*/i
    ]),
    actor: valueBetween(normalized, /Actor\(es\)\/Ofendido\(s\)\s*:?\s*/i, [
      /\nDemandado\(s\)\s*\/\s*\n?\s*Procesado\(s\)\s*:?\s*/i,
      /\nDemandado\(s\)\/Procesado\(s\)\s*:?\s*/i
    ]),
    demandado: valueBetween(normalized, /Demandado\(s\)\s*\/\s*\n?\s*Procesado\(s\)\s*:?\s*/i, [
      /\n\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}/,
      /\n\d{2}\/\d{2}\/\d{4}/,
      /\nFecha\s+de\s+ingreso\s*/i,
      /\nACTUACIONES\s*/i,
      /\nDetalle\s*/i
    ])
  };
}

async function requestPdfText(pdf) {
  const backendUrl = await getBackendUrl();
  let response;

  try {
    response = await fetch(getPdfTextUrl(backendUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pdfBase64: pdf.base64,
        filename: pdf.filename
      })
    });
  } catch (error) {
    throw new Error(`No se pudo conectar con /api/pdf-text. Revisa CORS, URL de Vercel o variables de entorno. Detalle: ${error.message}`);
  }

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error("El backend local no encontro /api/pdf-text. Reinicia el backend para cargar la version actualizada.");
    }

    throw new Error(data.error || `Error al leer el PDF: ${response.status}`);
  }

  return data;
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

async function fetchPdfFromDownload(downloadItem) {
  const url = downloadItem.finalUrl || downloadItem.url;
  if (!url || url.startsWith("blob:") || url.startsWith("filesystem:")) {
    throw new Error("La descarga no expuso una URL reutilizable para leer el PDF.");
  }

  const response = await fetch(url, {
    credentials: "include",
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`Chrome descargo el PDF, pero la URL temporal ya no permite leerlo desde la extension (${response.status}).`);
  }

  const buffer = await response.arrayBuffer();
  return {
    status: "captured",
    downloadId: downloadItem.id,
    base64: arrayBufferToBase64(buffer),
    filename: downloadItem.filename?.split(/[\\/]/).pop() || "expediente.pdf",
    captureSource: "chrome-downloads",
    byteLength: buffer.byteLength,
    downloadUrl: url
  };
}

async function cleanupDownload(downloadId) {
  if (!downloadId || !chrome.downloads) return null;

  const result = {
    fileRemoved: false,
    historyErased: false,
    error: null
  };

  try {
    if (chrome.downloads.removeFile) {
      await chrome.downloads.removeFile(downloadId);
      result.fileRemoved = true;
    }
  } catch (error) {
    result.error = error.message || "No se pudo borrar el archivo descargado.";
  }

  try {
    if (chrome.downloads.erase) {
      await chrome.downloads.erase({ id: downloadId });
      result.historyErased = true;
    }
  } catch (error) {
    result.error = result.error || error.message || "No se pudo borrar el historial de descarga.";
  }

  return result;
}

function waitForChromeDownload(timeoutMs = 12000) {
  if (!chrome.downloads?.onCreated) return Promise.resolve(null);

  return new Promise((resolve) => {
    let downloadId = null;
    let latestItem = null;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      chrome.downloads.onCreated.removeListener(onCreated);
      chrome.downloads.onChanged.removeListener(onChanged);
    };

    const finish = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const readDownload = async (id) => {
      const [item] = await chrome.downloads.search({ id });
      if (!item) return null;
      return fetchPdfFromDownload(item);
    };

    const onCreated = (item) => {
      if (settled || downloadId) return;
      downloadId = item.id;
      latestItem = item;

      fetchPdfFromDownload(item)
        .then(finish)
        .catch(() => {
          // Some generated downloads are not reusable until Chrome finishes them.
        });
    };

    const onChanged = (delta) => {
      if (settled || !downloadId || delta.id !== downloadId) return;

      if (delta.state?.current === "complete") {
        readDownload(downloadId)
          .then(finish)
          .catch((error) => finish({
            status: "error",
            error: error.message || "No se pudo leer la descarga del PDF."
          }));
      }

      if (delta.error?.current) {
        finish({
          status: "error",
          error: `Chrome no pudo descargar el PDF: ${delta.error.current}`
        });
      }
    };

    const timer = setTimeout(() => {
      if (downloadId && latestItem) {
        fetchPdfFromDownload(latestItem)
          .then(finish)
          .catch(() => finish(null));
        return;
      }

      finish(null);
    }, timeoutMs);

    chrome.downloads.onCreated.addListener(onCreated);
    chrome.downloads.onChanged.addListener(onChanged);
  });
}

async function extractFromActivePage() {
  const tab = await getActiveTab();
  assertReadableTab(tab);
  await ensureContentScript(tab.id);

  const downloadPromise = waitForChromeDownload();
  const response = await chrome.tabs.sendMessage(tab.id, { type: "EXTRACT_EXPEDIENTE" });
  if (!response?.ok) {
    throw new Error(response?.error || "No se pudo extraer texto de la pagina.");
  }

  const pageData = response.data;
  const downloadPdf = await downloadPromise;

  if (!pageData.pdf?.base64 && downloadPdf) {
    pageData.pdf = downloadPdf;
  }
  if (!pageData.pdf?.base64 && downloadPdf?.error) {
    pageData.pdf = downloadPdf;
  }

  if (pageData.pdf?.base64) {
    try {
      const pdfTextData = await requestPdfText(pageData.pdf);
      const pdfText = pdfTextData.text || "";

      if (pdfText) {
        const pdfMetadata = extractCaseMetadata(pdfText);
        pageData.pdf.textLength = pdfText.length;
        pageData.pdf.pages = pdfTextData.pages || null;
        pageData.pdf.extractionMethod = pdfTextData.method || null;
        pageData.pdf.cleanup = await cleanupDownload(pageData.pdf.downloadId);
        pageData.metadata = {
          ...(pageData.metadata || {}),
          ...Object.fromEntries(Object.entries(pdfMetadata).filter(([_key, value]) => value))
        };
        pageData.text = [
          `TEXTO EXTRAIDO DEL PDF EXPORTADO (${pageData.pdf.filename || "expediente.pdf"}):\n${pdfText}`,
          pageData.text ? `TEXTO VISIBLE DE LA PAGINA:\n${pageData.text}` : ""
        ].filter(Boolean).join("\n\n").slice(0, 120000);
      } else {
        pageData.pdf.error = `El PDF fue capturado, pero los extractores locales no encontraron texto. Metodo: ${pdfTextData.method || "sin texto"}.`;
      }
    } catch (error) {
      pageData.pdf.error = error.message || "No se pudo procesar el PDF exportado.";
    }
  }

  return pageData;
}

async function requestDraft(payload) {
  const backendUrl = await getBackendUrl();

  let response;

  try {
    response = await fetch(backendUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch (error) {
    throw new Error(`No se pudo conectar con el backend. Revisa la URL configurada o CORS en Vercel. Detalle: ${error.message}`);
  }

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || `Error del backend: ${response.status}`);
  }

  return data;
}

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  (async () => {
    if (request?.type === "READ_PAGE") {
      const pageData = await extractFromActivePage();
      sendResponse({ ok: true, data: pageData });
      return;
    }

    if (request?.type === "GENERATE_DRAFT") {
      const result = await requestDraft(request.payload);
      sendResponse({ ok: true, data: result });
      return;
    }

    if (request?.type === "SAVE_CONFIG") {
      await chrome.storage.sync.set({ backendUrl: request.backendUrl });
      sendResponse({ ok: true });
      return;
    }

    if (request?.type === "SAVE_UI_CONFIG") {
      await chrome.storage.sync.set({ showCapturedText: request.showCapturedText !== false });
      sendResponse({ ok: true });
      return;
    }

    if (request?.type === "SAVE_PROFILE") {
      await chrome.storage.sync.set({
        profile: {
          lawyerPrefix: request.profile?.lawyerPrefix || "Ab.",
          lawyerName: request.profile?.lawyerName || "",
          lawyerBarNumber: request.profile?.lawyerBarNumber || "",
          lawyerEmail: request.profile?.lawyerEmail || "",
          lawyerJudicialBox: request.profile?.lawyerJudicialBox || ""
        }
      });
      sendResponse({ ok: true });
      return;
    }

    if (request?.type === "GET_AUTH_CONFIG") {
      const stored = await chrome.storage.sync.get(["localUsername", "localPassword"]);
      sendResponse({
        ok: true,
        username: stored.localUsername || "admin",
        password: stored.localPassword || "1234"
      });
      return;
    }

    if (request?.type === "SAVE_AUTH_CONFIG") {
      await chrome.storage.sync.set({
        localUsername: request.username || "admin",
        localPassword: request.password || "1234"
      });
      sendResponse({ ok: true });
      return;
    }

    if (request?.type === "GET_CONFIG") {
      const backendUrl = await getBackendUrl();
      const stored = await chrome.storage.sync.get(["showCapturedText", "profile"]);
      sendResponse({
        ok: true,
        backendUrl,
        showCapturedText: stored.showCapturedText !== false,
        profile: stored.profile || {
          lawyerPrefix: "Ab.",
          lawyerName: "",
          lawyerBarNumber: "",
          lawyerEmail: "",
          lawyerJudicialBox: ""
        }
      });
      return;
    }
  })().catch((error) => {
    sendResponse({ ok: false, error: error.message || "Error interno de la extension." });
  });

  return true;
});
