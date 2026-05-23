const DEFAULT_BACKEND_URL = "https://expediente-ai-chrome-extension.vercel.app/api/draft";
const SERVICE_WORKER_PATH = new URL(import.meta.url).pathname;
const CONTENT_SCRIPT_FILE = SERVICE_WORKER_PATH.includes("/chrome-extension/")
  ? "chrome-extension/contentScript.js"
  : "contentScript.js";

function normalizeSupabaseUrl(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

async function getSupabaseConfig() {
  const stored = await chrome.storage.sync.get(["supabaseUrl", "supabaseAnonKey"]);
  const storedConfig = {
    url: normalizeSupabaseUrl(stored.supabaseUrl),
    anonKey: String(stored.supabaseAnonKey || "").trim()
  };

  if (storedConfig.url && storedConfig.anonKey) return storedConfig;

  try {
    const backendUrl = await getBackendUrl();
    const response = await fetch(new URL("/api/client-config", backendUrl).toString(), {
      cache: "no-store"
    });
    const data = await response.json().catch(() => ({}));

    return {
      url: normalizeSupabaseUrl(data.supabase?.url),
      anonKey: String(data.supabase?.anonKey || "").trim()
    };
  } catch (_error) {
    return storedConfig;
  }
}

function assertSupabaseConfig(config) {
  if (!config.url || !config.anonKey) {
    throw new Error("No se pudo cargar la configuracion de Supabase desde el backend.");
  }
}

function profileToSupabase(profile = {}) {
  return {
    prefijo: profile.lawyerPrefix || "Ab.",
    nombre_completo: profile.lawyerName || "",
    matricula_abogado: profile.lawyerBarNumber || "",
    correo_notificaciones: profile.lawyerEmail || "",
    casillero_judicial: profile.lawyerJudicialBox || ""
  };
}

function profileFromSupabase(profile = {}) {
  return {
    lawyerPrefix: profile.prefijo || "Ab.",
    lawyerName: profile.nombre_completo || "",
    lawyerBarNumber: profile.matricula_abogado || "",
    lawyerEmail: profile.correo_notificaciones || "",
    lawyerJudicialBox: profile.casillero_judicial || ""
  };
}

async function supabaseFetch(path, options = {}) {
  const config = await getSupabaseConfig();
  assertSupabaseConfig(config);

  const session = options.useSession === false
    ? null
    : (await chrome.storage.local.get(["supabaseSession"])).supabaseSession;
  const headers = {
    apikey: config.anonKey,
    "Content-Type": "application/json",
    ...(options.headers || {})
  };

  if (session?.access_token) {
    headers.Authorization = `Bearer ${session.access_token}`;
  }

  const response = await fetch(`${config.url}${path}`, {
    ...options,
    headers
  });
  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(data?.msg || data?.message || data?.error_description || data?.error || `Error Supabase: ${response.status}`);
  }

  return data;
}

async function saveSupabaseSession(session) {
  if (!session?.access_token) return;
  await chrome.storage.local.set({ supabaseSession: session });
}

async function getBackendAuthHeaders() {
  const stored = await chrome.storage.local.get(["supabaseSession"]);
  const token = stored.supabaseSession?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function loadSupabaseProfile(userId) {
  const rows = await supabaseFetch(`/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=*`, {
    method: "GET",
    headers: { Accept: "application/json" }
  });
  const profile = Array.isArray(rows) ? rows[0] : null;
  if (!profile) return null;

  const normalized = profileFromSupabase(profile);
  await chrome.storage.sync.set({ profile: normalized });
  return normalized;
}

async function updateSupabaseProfile(profile) {
  const stored = await chrome.storage.local.get(["supabaseSession"]);
  const userId = stored.supabaseSession?.user?.id;
  if (!userId) throw new Error("Inicia sesion nuevamente para guardar el perfil.");

  const rows = await supabaseFetch(`/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=*`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(profileToSupabase(profile))
  });
  const normalized = profileFromSupabase(Array.isArray(rows) ? rows[0] : {});
  await chrome.storage.sync.set({ profile: normalized });
  return normalized;
}

async function supabaseLogin(email, password) {
  const data = await supabaseFetch("/auth/v1/token?grant_type=password", {
    method: "POST",
    useSession: false,
    body: JSON.stringify({ email, password })
  });

  await saveSupabaseSession(data);
  if (data.user?.id) await loadSupabaseProfile(data.user.id);
  return data;
}

async function supabaseRegister(email, password, profile) {
  const data = await supabaseFetch("/auth/v1/signup", {
    method: "POST",
    useSession: false,
    body: JSON.stringify({
      email,
      password,
      data: profileToSupabase(profile)
    })
  });

  const session = data.session || (data.access_token ? data : null);
  if (session) {
    await saveSupabaseSession(session);
    if (data.user?.id) await loadSupabaseProfile(data.user.id);
  }

  await chrome.storage.sync.set({ profile });
  return data;
}

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
  return DEFAULT_BACKEND_URL;
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
  const pdfSizeMb = ((pdf.base64?.length || 0) * 0.75) / (1024 * 1024);
  const isLikelyVercel = /vercel\.app/i.test(backendUrl);

  if (isLikelyVercel && pdfSizeMb > 4) {
    throw new Error(`El PDF capturado pesa aproximadamente ${pdfSizeMb.toFixed(1)} MB. Vercel suele rechazar requests grandes antes de llegar al backend. Para leer PDFs de este tamaño en producción conviene usar Render/Railway/Fly.io o enviar el PDF vía Supabase Storage.`);
  }

  let response;

  try {
    const authHeaders = await getBackendAuthHeaders();
    response = await fetch(getPdfTextUrl(backendUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({
        pdfBase64: pdf.base64,
        filename: pdf.filename
      })
    });
  } catch (error) {
    throw new Error(`No se pudo conectar con /api/pdf-text. PDF aproximado: ${pdfSizeMb.toFixed(1)} MB. Si usas Vercel, puede ser limite de tamaño de request o CORS/preflight. Detalle: ${error.message}`);
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
    const authHeaders = await getBackendAuthHeaders();
    response = await fetch(backendUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
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

    if (request?.type === "GET_SUPABASE_CONFIG") {
      const config = await getSupabaseConfig();
      sendResponse({ ok: true, config });
      return;
    }

    if (request?.type === "SAVE_UI_CONFIG") {
      await chrome.storage.sync.set({ showCapturedText: request.showCapturedText !== false });
      sendResponse({ ok: true });
      return;
    }

    if (request?.type === "SAVE_PROFILE") {
      const supabaseConfig = await getSupabaseConfig();
      const storedSession = await chrome.storage.local.get(["supabaseSession"]);
      if (supabaseConfig.url && supabaseConfig.anonKey && storedSession.supabaseSession?.access_token) {
        const profile = await updateSupabaseProfile(request.profile);
        sendResponse({ ok: true, profile });
        return;
      }

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

    if (request?.type === "SUPABASE_LOGIN") {
      const data = await supabaseLogin(request.email, request.password);
      sendResponse({ ok: true, user: data.user });
      return;
    }

    if (request?.type === "SUPABASE_REGISTER") {
      const data = await supabaseRegister(request.email, request.password, request.profile);
      sendResponse({ ok: true, user: data.user, needsConfirmation: !data.access_token && !data.session?.access_token });
      return;
    }

    if (request?.type === "SUPABASE_CHANGE_PASSWORD") {
      await supabaseFetch("/auth/v1/user", {
        method: "PUT",
        body: JSON.stringify({ password: request.password })
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
      const stored = await chrome.storage.sync.get(["showCapturedText", "profile"]);
      sendResponse({
        ok: true,
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
