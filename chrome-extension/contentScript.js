function cleanText(value) {
  return (value || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function textFromTables() {
  const rows = [...document.querySelectorAll("table tr")];
  return rows.map((tr) => {
    return [...tr.querySelectorAll("th,td")]
      .map((cell) => cleanText(cell.innerText))
      .filter(Boolean)
      .join(" | ");
  }).filter(Boolean).join("\n");
}

function textFromInputs() {
  const fields = [...document.querySelectorAll("input, textarea, select")];

  return fields.map((el) => {
    const label =
      el.getAttribute("aria-label") ||
      (el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.innerText : "") ||
      el.name ||
      el.id ||
      el.placeholder ||
      el.type ||
      "campo";

    const value =
      el.tagName === "SELECT"
        ? el.options?.[el.selectedIndex]?.text
        : el.value;

    if (!value) return "";
    return `${cleanText(label)}: ${cleanText(value)}`;
  }).filter(Boolean).join("\n");
}

function getLikelyCaseMetadata(fullText) {
  const patterns = {
    numeroProceso: /(No\.?|Nro\.?|Numero|Proceso|Causa)\s*[:#-]?\s*([0-9]{5,}[-\w.]*)/i,
    actor: /(Actor|Accionante|Demandante|Ofendido)\s*[:#-]?\s*([^\n]{3,120})/i,
    demandado: /(Demandado|Accionado|Procesado)\s*[:#-]?\s*([^\n]{3,120})/i,
    judicatura: /(Unidad Judicial|Juzgado|Tribunal|Sala)\s*[:#-]?\s*([^\n]{3,160})/i
  };

  const metadata = {};
  for (const [key, regex] of Object.entries(patterns)) {
    const match = fullText.match(regex);
    if (match?.[2]) metadata[key] = cleanText(match[2]);
  }

  return metadata;
}

function findExportPdfButton() {
  const candidates = [
    ...document.querySelectorAll("button, a, [role='button']")
  ];

  return candidates.find((el) => {
    const text = cleanText([
      el.innerText,
      el.textContent,
      el.getAttribute("aria-label"),
      el.getAttribute("title")
    ].filter(Boolean).join(" "));

    return /exportar\s+pdf|exportar\s+actuaciones|pdf/i.test(text);
  }) || null;
}

function waitForPdfCapture(timeoutMs = 6000) {
  return new Promise((resolve) => {
    let done = false;

    const finish = (value) => {
      if (done) return;
      done = true;
      window.removeEventListener("message", onMessage);
      clearTimeout(timer);
      resolve(value);
    };

    const onMessage = (event) => {
      if (event.source !== window) return;
      const data = event.data || {};

      if (data.source === "EXPEDIENTE_AI_PDF_CAPTURE" && data.pdfBase64) {
        finish({
          base64: data.pdfBase64,
          filename: data.filename || "expediente.pdf",
          captureSource: data.captureSource || "unknown",
          byteLength: data.byteLength || null
        });
      }

      if (data.source === "EXPEDIENTE_AI_PDF_CAPTURE_ERROR") {
        finish({
          error: data.error || "No se pudo capturar el PDF exportado."
        });
      }
    };

    const timer = setTimeout(() => finish(null), timeoutMs);
    window.addEventListener("message", onMessage);
  });
}

async function exportPdfFromPage() {
  const button = findExportPdfButton();
  if (!button) {
    return {
      status: "not_found",
      error: "No se encontro el boton Exportar PDF."
    };
  }

  window.postMessage({
    source: "EXPEDIENTE_AI_ARM_PDF_CAPTURE",
    timeoutMs: 10000
  }, "*");

  const pdfPromise = waitForPdfCapture();
  button.click();
  const pdf = await pdfPromise;

  if (!pdf) {
    return {
      status: "timeout",
      error: "Se presiono Exportar PDF, pero no se pudo capturar el archivo antes de la descarga."
    };
  }

  if (pdf.error) {
    return {
      status: "error",
      error: pdf.error
    };
  }

  return {
    status: "captured",
    ...pdf
  };
}

async function extractPageData() {
  const title = document.title || "";
  const url = window.location.href;

  const headings = [...document.querySelectorAll("h1,h2,h3")]
    .map((h) => cleanText(h.innerText))
    .filter(Boolean)
    .join("\n");

  const mainText = cleanText(document.body?.innerText || "");
  const tableText = textFromTables();
  const inputText = textFromInputs();

  const fullText = cleanText([
    `TITULO DE LA PAGINA: ${title}`,
    `URL: ${url}`,
    headings ? `ENCABEZADOS:\n${headings}` : "",
    tableText ? `TABLAS:\n${tableText}` : "",
    inputText ? `CAMPOS:\n${inputText}` : "",
    `TEXTO VISIBLE:\n${mainText}`
  ].filter(Boolean).join("\n\n"));

  const pdf = await exportPdfFromPage();

  return {
    title,
    url,
    capturedAt: new Date().toISOString(),
    metadata: getLikelyCaseMetadata(fullText),
    pdf,
    text: fullText.slice(0, 70000),
    originalLength: fullText.length
  };
}

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request?.type === "PING") {
    sendResponse({ ok: true });
    return false;
  }

  if (request?.type === "EXTRACT_EXPEDIENTE") {
    extractPageData()
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => {
        sendResponse({ ok: false, error: error.message || "No se pudo leer la pagina." });
      });

    return true;
  }

  return false;
});
