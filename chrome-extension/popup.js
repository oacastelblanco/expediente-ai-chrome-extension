const $ = (id) => document.getElementById(id);

const loginView = $("loginView");
const registerView = $("registerView");
const appView = $("appView");
const loginUsername = $("loginUsername");
const loginPassword = $("loginPassword");
const loginButton = $("loginButton");
const loginMessage = $("loginMessage");
const registerUsername = $("registerUsername");
const registerPassword = $("registerPassword");
const registerConfirmPassword = $("registerConfirmPassword");
const registerLawyerPrefix = $("registerLawyerPrefix");
const registerLawyerName = $("registerLawyerName");
const registerLawyerBarNumber = $("registerLawyerBarNumber");
const registerLawyerEmail = $("registerLawyerEmail");
const registerLawyerJudicialBox = $("registerLawyerJudicialBox");
const registerMessage = $("registerMessage");
const backendUrl = $("backendUrl");
const documentType = $("documentType");
const instruction = $("instruction");
const capturedText = $("capturedText");
const result = $("result");
const message = $("message");
const charCount = $("charCount");
const statusDot = $("statusDot");
const caseInfoCard = $("caseInfoCard");
const representationCard = $("representationCard");
const representationOptions = $("representationOptions");
const configPanel = $("configPanel");
const capturedTextCard = $("capturedTextCard");
const showCapturedText = $("showCapturedText");
const lawyerName = $("lawyerName");
const lawyerPrefix = $("lawyerPrefix");
const lawyerBarNumber = $("lawyerBarNumber");
const lawyerEmail = $("lawyerEmail");
const lawyerJudicialBox = $("lawyerJudicialBox");
const activeLawyerName = $("activeLawyerName");
const activeLawyerBarNumber = $("activeLawyerBarNumber");
const enableNotifications = $("enableNotifications");
const notificationFields = $("notificationFields");
const notificationEmail = $("notificationEmail");
const notificationJudicialBox = $("notificationJudicialBox");
const currentPassword = $("currentPassword");
const currentUsername = $("currentUsername");
const newUsername = $("newUsername");
const newPassword = $("newPassword");
const confirmPassword = $("confirmPassword");

const DEFAULT_LOCAL_PASSWORD = "1234";
const DEFAULT_LOCAL_USERNAME = "admin";
let currentPageData = null;
let selectedRepresentation = null;
let activeProfile = {
  lawyerPrefix: "Ab.",
  lawyerName: "",
  lawyerBarNumber: "",
  lawyerEmail: "",
  lawyerJudicialBox: ""
};

function setMessage(text, type = "neutral") {
  message.textContent = text || "";
  statusDot.className = "dot";
  if (type === "ok") statusDot.classList.add("ok");
  if (type === "error") statusDot.classList.add("error");
}

function setLoginMessage(text) {
  loginMessage.textContent = text || "";
}

function setRegisterMessage(text) {
  registerMessage.textContent = text || "";
}

function showLoginView() {
  registerView.classList.add("hidden");
  appView.classList.add("hidden");
  loginView.classList.remove("hidden");
  setLoginMessage("");
}

function showRegisterView() {
  loginView.classList.add("hidden");
  appView.classList.add("hidden");
  registerView.classList.remove("hidden");
  setRegisterMessage("");
}

async function getStoredAuth() {
  const response = await sendMessage({ type: "GET_AUTH_CONFIG" });
  return {
    username: response?.username || DEFAULT_LOCAL_USERNAME,
    password: response?.password || DEFAULT_LOCAL_PASSWORD
  };
}

async function unlockApp() {
  loginView.classList.add("hidden");
  registerView.classList.add("hidden");
  appView.classList.remove("hidden");
  await loadConfig();
}

async function login() {
  const storedAuth = await getStoredAuth();

  if (loginUsername.value.trim() !== storedAuth.username || loginPassword.value !== storedAuth.password) {
    setLoginMessage("Usuario o clave incorrectos.");
    return;
  }

  loginUsername.value = "";
  loginPassword.value = "";
  setLoginMessage("");
  await unlockApp();
}

async function registerAccount() {
  const username = registerUsername.value.trim();
  const password = registerPassword.value;
  const profile = {
    lawyerPrefix: registerLawyerPrefix.value,
    lawyerName: registerLawyerName.value.trim(),
    lawyerBarNumber: registerLawyerBarNumber.value.trim(),
    lawyerEmail: registerLawyerEmail.value.trim(),
    lawyerJudicialBox: registerLawyerJudicialBox.value.trim()
  };

  if (!username) {
    setRegisterMessage("Ingresa un usuario.");
    return;
  }

  if (!password || password.length < 4) {
    setRegisterMessage("La clave debe tener al menos 4 caracteres.");
    return;
  }

  if (password !== registerConfirmPassword.value) {
    setRegisterMessage("La confirmación de clave no coincide.");
    return;
  }

  if (!profile.lawyerName) {
    setRegisterMessage("Ingresa el nombre completo del abogado.");
    return;
  }

  if (!profile.lawyerBarNumber) {
    setRegisterMessage("Ingresa el número de matrícula.");
    return;
  }

  const response = await sendMessage({
    type: "SAVE_AUTH_CONFIG",
    username,
    password
  });

  if (!response?.ok) {
    setRegisterMessage(response?.error || "No se pudo crear la cuenta.");
    return;
  }

  const profileResponse = await sendMessage({
    type: "SAVE_PROFILE",
    profile
  });

  if (!profileResponse?.ok) {
    setRegisterMessage(profileResponse?.error || "No se pudo guardar el perfil.");
    return;
  }

  registerUsername.value = "";
  registerPassword.value = "";
  registerConfirmPassword.value = "";
  registerLawyerPrefix.value = "Ab.";
  registerLawyerName.value = "";
  registerLawyerBarNumber.value = "";
  registerLawyerEmail.value = "";
  registerLawyerJudicialBox.value = "";
  loginUsername.value = username;
  showLoginView();
  setLoginMessage("Cuenta creada. Ingresa tu clave para continuar.");
}

function setBusy(isBusy) {
  $("readPage").disabled = isBusy;
  $("generate").disabled = isBusy;
  $("saveConfig").disabled = isBusy;
}

function updateCount() {
  charCount.textContent = `${capturedText.value.length.toLocaleString("es-EC")} caracteres`;
}

function setText(id, value) {
  $(id).textContent = value || "-";
}

function splitPartyNames(value) {
  return (value || "")
    .split(/\s*;\s*|\s+\|\s+|\n+/)
    .flatMap((part) => part.split(/\s*,\s*(?=[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s|$))/))
    .map((part) => part.trim())
    .filter(Boolean);
}

function selectRepresentation(party) {
  selectedRepresentation = party;

  document.querySelectorAll(".party-chip.selectable").forEach((chip) => {
    chip.classList.toggle("selected", chip.dataset.role === party.role && chip.dataset.name === party.name);
  });

  if (currentPageData) {
    currentPageData.representation = party;
    currentPageData.metadata = {
      ...(currentPageData.metadata || {}),
      representacion: `${party.role}: ${party.name}`
    };
  }
}

function createPartyChip(party, { selectable = false } = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `party-chip${selectable ? " selectable" : ""}`;
  button.textContent = party.name;
  button.dataset.role = party.role;
  button.dataset.name = party.name;

  if (selectable) {
    button.addEventListener("click", () => selectRepresentation(party));
  }

  return button;
}

function renderPartyList(containerId, parties) {
  const container = $(containerId);
  container.textContent = "";

  if (!parties.length) {
    container.textContent = "-";
    return;
  }

  for (const party of parties) {
    container.appendChild(createPartyChip(party));
  }
}

function renderRepresentationOptions(parties) {
  representationOptions.textContent = "";
  representationCard.classList.toggle("hidden", !parties.length);
  selectedRepresentation = null;

  for (const party of parties) {
    representationOptions.appendChild(createPartyChip(party, { selectable: true }));
  }
}

function renderCaseInfo(metadata = {}) {
  const actorParties = splitPartyNames(metadata.actor).map((name) => ({ role: "Actor", name }));
  const demandadoParties = splitPartyNames(metadata.demandado).map((name) => ({ role: "Demandado", name }));
  const selectableParties = [...actorParties, ...demandadoParties];
  const hasData = [
    metadata.judicatura,
    metadata.numeroProceso,
    metadata.procedimiento,
    metadata.actor,
    metadata.demandado
  ].some(Boolean);

  caseInfoCard.classList.toggle("hidden", !hasData);
  setText("caseJudicatura", metadata.judicatura);
  setText("caseNumeroProceso", metadata.numeroProceso);
  setText("caseProcedimiento", metadata.procedimiento);
  renderPartyList("caseActor", actorParties);
  renderPartyList("caseDemandado", demandadoParties);
  renderRepresentationOptions(selectableParties);
}

function sendMessage(payload) {
  return chrome.runtime.sendMessage(payload);
}

function applyCapturedTextVisibility(isVisible) {
  capturedTextCard.classList.toggle("hidden", !isVisible);
}

function renderActiveProfile(profile = activeProfile) {
  activeLawyerName.textContent = profile.lawyerName ? `${profile.lawyerPrefix || "Ab."} ${profile.lawyerName}` : "Sin configurar";
  activeLawyerBarNumber.textContent = profile.lawyerBarNumber || "Sin configurar";
}

function setNotificationsEnabled(isEnabled) {
  notificationFields.classList.toggle("hidden", !isEnabled);

  if (isEnabled) {
    if (!notificationEmail.value) notificationEmail.value = activeProfile.lawyerEmail || "";
    if (!notificationJudicialBox.value) notificationJudicialBox.value = activeProfile.lawyerJudicialBox || "";
  }
}

function getNotificationSettings() {
  return {
    enabled: enableNotifications.checked,
    email: notificationEmail.value.trim(),
    judicialBox: notificationJudicialBox.value.trim()
  };
}

async function loadConfig() {
  const response = await sendMessage({ type: "GET_CONFIG" });
  if (response?.ok) {
    backendUrl.value = response.backendUrl;
    showCapturedText.checked = response.showCapturedText !== false;
    applyCapturedTextVisibility(showCapturedText.checked);
    activeProfile = {
      lawyerPrefix: response.profile?.lawyerPrefix || "Ab.",
      lawyerName: response.profile?.lawyerName || "",
      lawyerBarNumber: response.profile?.lawyerBarNumber || "",
      lawyerEmail: response.profile?.lawyerEmail || "",
      lawyerJudicialBox: response.profile?.lawyerJudicialBox || ""
    };
    lawyerPrefix.value = activeProfile.lawyerPrefix;
    lawyerName.value = activeProfile.lawyerName;
    lawyerBarNumber.value = activeProfile.lawyerBarNumber;
    lawyerEmail.value = activeProfile.lawyerEmail;
    lawyerJudicialBox.value = activeProfile.lawyerJudicialBox;
    renderActiveProfile();
    setNotificationsEnabled(enableNotifications.checked);
  }
}

async function saveConfig() {
  const url = backendUrl.value.trim();
  if (!url) {
    setMessage("Ingresa la URL del backend.", "error");
    return;
  }

  const response = await sendMessage({ type: "SAVE_CONFIG", backendUrl: url });
  if (!response?.ok) {
    setMessage(response?.error || "No se pudo guardar la configuración.", "error");
    return;
  }

  setMessage("Configuración guardada.", "ok");
}

async function saveUiConfig() {
  const response = await sendMessage({
    type: "SAVE_UI_CONFIG",
    showCapturedText: showCapturedText.checked
  });

  if (!response?.ok) {
    setMessage(response?.error || "No se pudo guardar la configuración visual.", "error");
  }
}

async function saveProfile() {
  activeProfile = {
    lawyerPrefix: lawyerPrefix.value,
    lawyerName: lawyerName.value.trim(),
    lawyerBarNumber: lawyerBarNumber.value.trim(),
    lawyerEmail: lawyerEmail.value.trim(),
    lawyerJudicialBox: lawyerJudicialBox.value.trim()
  };

  const response = await sendMessage({
    type: "SAVE_PROFILE",
    profile: activeProfile
  });

  if (!response?.ok) {
    setMessage(response?.error || "No se pudo guardar el perfil.", "error");
    return;
  }

  renderActiveProfile();
  setMessage("Perfil guardado.", "ok");
}

async function changePassword() {
  const storedAuth = await getStoredAuth();

  if (currentUsername.value.trim() !== storedAuth.username || currentPassword.value !== storedAuth.password) {
    setMessage("El usuario actual o la clave actual no son correctos.", "error");
    return;
  }

  if (!newUsername.value.trim()) {
    setMessage("Ingresa el nuevo usuario.", "error");
    return;
  }

  if (!newPassword.value || newPassword.value.length < 4) {
    setMessage("La nueva clave debe tener al menos 4 caracteres.", "error");
    return;
  }

  if (newPassword.value !== confirmPassword.value) {
    setMessage("La confirmación de clave no coincide.", "error");
    return;
  }

  const response = await sendMessage({
    type: "SAVE_AUTH_CONFIG",
    username: newUsername.value.trim(),
    password: newPassword.value
  });

  if (!response?.ok) {
    setMessage(response?.error || "No se pudo cambiar la clave.", "error");
    return;
  }

  currentUsername.value = "";
  currentPassword.value = "";
  newUsername.value = "";
  newPassword.value = "";
  confirmPassword.value = "";
  setMessage("Clave actualizada.", "ok");
}

async function readCurrentPage() {
  setBusy(true);
  setMessage("Leyendo expediente e intentando exportar PDF...");

  try {
    const response = await sendMessage({ type: "READ_PAGE" });
    if (!response?.ok) throw new Error(response?.error);

    currentPageData = response.data;
    capturedText.value = currentPageData.text || "";
    updateCount();
    renderCaseInfo(currentPageData.metadata || {});

    const notes = [];
    if (currentPageData.pdf?.status === "captured") {
      notes.push(currentPageData.pdf.textLength
        ? `PDF exportado procesado (${currentPageData.pdf.textLength.toLocaleString("es-EC")} caracteres).`
        : (currentPageData.pdf.error || "PDF exportado capturado, pero no se pudo extraer texto."));

      if (currentPageData.pdf.cleanup?.fileRemoved) {
        notes.push("Archivo PDF descargado eliminado del dispositivo.");
      } else if (currentPageData.pdf.cleanup?.error) {
        notes.push(`No se pudo eliminar el PDF descargado: ${currentPageData.pdf.cleanup.error}`);
      }
    } else if (currentPageData.pdf?.error) {
      notes.push(currentPageData.pdf.error);
    }

    if (currentPageData.originalLength > currentPageData.text.length) {
      notes.push("Texto recortado por limite de seguridad.");
    }

    setMessage(`Expediente leido correctamente. ${notes.join(" ")}`.trim(), "ok");
  } catch (error) {
    setMessage(error.message || "No se pudo leer la página.", "error");
  } finally {
    setBusy(false);
  }
}

async function generateDraft() {
  const userInstruction = instruction.value.trim();
  const pageText = capturedText.value.trim();

  if (!pageText) {
    setMessage("Primero lee el expediente o pega el texto relevante.", "error");
    return;
  }

  if (!documentType.value) {
    setMessage("Selecciona el tipo de escrito.", "error");
    return;
  }

  if (!userInstruction) {
    setMessage("Ingresa una instrucción concreta para el escrito.", "error");
    return;
  }

  if (!representationCard.classList.contains("hidden") && !selectedRepresentation) {
    setMessage("Selecciona en representación de quién se presentará el escrito.", "error");
    return;
  }

  setBusy(true);
  setMessage("Generando borrador...");

  try {
    const response = await sendMessage({
      type: "GENERATE_DRAFT",
      payload: {
        documentType: documentType.value,
        instruction: userInstruction,
        pageText,
        representation: selectedRepresentation,
        profile: activeProfile,
        notifications: getNotificationSettings(),
        page: currentPageData ? {
          title: currentPageData.title,
          url: currentPageData.url,
          capturedAt: currentPageData.capturedAt,
          metadata: currentPageData.metadata
        } : null
      }
    });

    if (!response?.ok) throw new Error(response?.error);

    result.value = response.data.draft || "";
    setMessage("Borrador generado. Revisa hechos, citas y estrategia antes de usarlo.", "ok");
  } catch (error) {
    setMessage(error.message || "No se pudo generar el escrito.", "error");
  } finally {
    setBusy(false);
  }
}

async function copyResult() {
  if (!result.value.trim()) return;
  await navigator.clipboard.writeText(result.value);
  setMessage("Borrador copiado al portapapeles.", "ok");
}

function getDraftFilename(extension) {
  const processNumber = currentPageData?.metadata?.numeroProceso || "expediente";
  const safeProcessNumber = processNumber.replace(/[^\w-]+/g, "_");
  return `borrador_${safeProcessNumber}.${extension}`;
}

function escapeHtml(value) {
  return (value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function parseBoldSegments(value) {
  const segments = [];
  const regex = /\*\*(.+?)\*\*/gs;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(value)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ text: value.slice(lastIndex, match.index), bold: false });
    }
    segments.push({ text: match[1], bold: true });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < value.length) {
    segments.push({ text: value.slice(lastIndex), bold: false });
  }

  return segments;
}

function stripBoldMarkers(value) {
  return (value || "").replace(/\*\*(.+?)\*\*/gs, "$1");
}

function isSignatureParagraph(paragraph, index, total) {
  const plain = stripBoldMarkers(paragraph).toLowerCase();
  return index >= total - 3 && (
    plain.includes("matricula") ||
    plain.includes("matrícula") ||
    plain.includes("ab.") ||
    plain.includes("dr.") ||
    plain.includes("abogado")
  );
}

function isSectionLabelParagraph(paragraph) {
  const plain = stripBoldMarkers(paragraph)
    .replace(/[.:;-]+$/g, "")
    .trim()
    .toUpperCase();
  const labels = [
    "ANTECEDENTES",
    "SOLICITUD EXPRESA",
    "NOTIFICACIONES",
    "FIRMA"
  ];

  return labels.includes(plain) || plain.startsWith("SEÑOR JUEZ DE") || plain.startsWith("SENOR JUEZ DE") || plain.startsWith("PROCESO NO");
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function crc32(value) {
  const table = crc32.table || (crc32.table = Array.from({ length: 256 }, (_item, index) => {
    let crc = index;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    return crc >>> 0;
  }));

  let crc = 0xffffffff;
  for (const byte of value) {
    crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function uint16(value) {
  return [value & 0xff, (value >>> 8) & 0xff];
}

function uint32(value) {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function createZip(files) {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const dataBytes = encoder.encode(file.content);
    const crc = crc32(dataBytes);

    const localHeader = new Uint8Array([
      ...uint32(0x04034b50),
      ...uint16(20),
      ...uint16(0),
      ...uint16(0),
      ...uint16(0),
      ...uint16(0),
      ...uint32(crc),
      ...uint32(dataBytes.length),
      ...uint32(dataBytes.length),
      ...uint16(nameBytes.length),
      ...uint16(0)
    ]);

    localParts.push(localHeader, nameBytes, dataBytes);

    const centralHeader = new Uint8Array([
      ...uint32(0x02014b50),
      ...uint16(20),
      ...uint16(20),
      ...uint16(0),
      ...uint16(0),
      ...uint16(0),
      ...uint16(0),
      ...uint32(crc),
      ...uint32(dataBytes.length),
      ...uint32(dataBytes.length),
      ...uint16(nameBytes.length),
      ...uint16(0),
      ...uint16(0),
      ...uint16(0),
      ...uint16(0),
      ...uint32(0),
      ...uint32(offset)
    ]);

    centralParts.push(centralHeader, nameBytes);
    offset += localHeader.length + nameBytes.length + dataBytes.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const endRecord = new Uint8Array([
    ...uint32(0x06054b50),
    ...uint16(0),
    ...uint16(0),
    ...uint16(files.length),
    ...uint16(files.length),
    ...uint32(centralSize),
    ...uint32(offset),
    ...uint16(0)
  ]);

  return new Blob([...localParts, ...centralParts, endRecord], {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  });
}

function docxTextRuns(text) {
  const lines = text.split("\n");
  return lines.map((line, index) => {
    const breakTag = index === 0 ? "" : "<w:br/>";
    return parseBoldSegments(line).map((segment, segmentIndex) => {
      const prefix = segmentIndex === 0 ? breakTag : "";
      const bold = segment.bold ? "<w:rPr><w:b/></w:rPr>" : "";
      return `<w:r>${bold}${prefix}<w:t xml:space="preserve">${escapeHtml(segment.text)}</w:t></w:r>`;
    }).join("");
  }).join("");
}

function docxParagraph(text, options = {}) {
  const alignment = options.center ? "center" : options.left ? "left" : "both";
  return `<w:p><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/><w:jc w:val="${alignment}"/></w:pPr>${docxTextRuns(text)}</w:p>`;
}

function createDocx(text) {
  const paragraphTexts = text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const paragraphs = paragraphTexts
    .map((paragraph, index) => docxParagraph(paragraph, {
      center: isSignatureParagraph(paragraph, index, paragraphTexts.length),
      left: isSectionLabelParagraph(paragraph)
    }))
    .join("");

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${paragraphs}
    <w:sectPr>
      <w:pgSz w:w="12240" w:h="15840"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/>
    </w:sectPr>
  </w:body>
</w:document>`;

  return createZip([
    {
      name: "[Content_Types].xml",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`
    },
    {
      name: "_rels/.rels",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`
    },
    {
      name: "word/document.xml",
      content: documentXml
    }
  ]);
}

function requireDraftText() {
  const text = result.value.trim();
  if (!text) {
    setMessage("Primero genera un borrador.", "error");
    return "";
  }
  return text;
}

function downloadWord() {
  const text = requireDraftText();
  if (!text) return;

  downloadBlob(createDocx(text), getDraftFilename("docx"));
  setMessage("Borrador descargado como DOCX.", "ok");
}

function downloadPdf() {
  const text = requireDraftText();
  if (!text) return;

  const printWindow = window.open("", "_blank", "width=900,height=700");
  if (!printWindow) {
    setMessage("Chrome bloqueó la ventana de impresión. Permite ventanas emergentes para descargar PDF.", "error");
    return;
  }

  const paragraphTexts = text.split(/\n{2,}/).map((paragraph) => paragraph.trim()).filter(Boolean);
  const htmlParagraphs = paragraphTexts.map((paragraph, index) => {
    const html = parseBoldSegments(paragraph)
      .map((segment) => segment.bold ? `<strong>${escapeHtml(segment.text)}</strong>` : escapeHtml(segment.text))
      .join("")
      .replace(/\n/g, "<br>");
    const className = [
      isSignatureParagraph(paragraph, index, paragraphTexts.length) ? "signature" : "",
      isSectionLabelParagraph(paragraph) ? "section-label" : ""
    ].filter(Boolean).join(" ");
    const classAttribute = className ? ` class="${className}"` : "";
    return `<p${classAttribute}>${html}</p>`;
  }).join("");

  printWindow.document.write(`
<!doctype html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${escapeHtml(getDraftFilename("pdf"))}</title>
  <style>
    @page { margin: 24mm 20mm; }
    body { font-family: Arial, sans-serif; font-size: 12pt; line-height: 1.45; color: #111827; }
    p { margin: 0 0 10pt; white-space: pre-wrap; }
    .section-label { text-align: left; font-weight: 700; margin-top: 14pt; margin-bottom: 8pt; }
    .signature { text-align: center; font-weight: 700; margin-top: 28pt; }
  </style>
</head>
<body>
  ${htmlParagraphs}
  <script>
    window.onload = () => {
      window.focus();
      window.print();
    };
  </script>
</body>
</html>`);
  printWindow.document.close();
  setMessage("Se abrió la ventana de impresión para guardar como PDF.", "ok");
}

$("loginButton").addEventListener("click", () => {
  login().catch(() => setLoginMessage("No se pudo iniciar sesión."));
});
$("showRegister").addEventListener("click", showRegisterView);
$("backToLogin").addEventListener("click", showLoginView);
$("registerButton").addEventListener("click", () => {
  registerAccount().catch(() => setRegisterMessage("No se pudo crear la cuenta."));
});
loginPassword.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    login().catch(() => setLoginMessage("No se pudo iniciar sesión."));
  }
});
registerConfirmPassword.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    registerAccount().catch(() => setRegisterMessage("No se pudo crear la cuenta."));
  }
});
$("saveConfig").addEventListener("click", saveConfig);
$("saveProfile").addEventListener("click", saveProfile);
$("changePassword").addEventListener("click", changePassword);
$("toggleConfig").addEventListener("click", () => {
  configPanel.classList.toggle("hidden");
});
showCapturedText.addEventListener("change", () => {
  applyCapturedTextVisibility(showCapturedText.checked);
  saveUiConfig();
});
enableNotifications.addEventListener("change", () => {
  setNotificationsEnabled(enableNotifications.checked);
});
$("readPage").addEventListener("click", readCurrentPage);
$("generate").addEventListener("click", generateDraft);
$("copyResult").addEventListener("click", copyResult);
$("downloadWord").addEventListener("click", downloadWord);
$("downloadPdf").addEventListener("click", downloadPdf);
capturedText.addEventListener("input", updateCount);


