const $ = (id) => document.getElementById(id);

const tokenKey = "expediente_ai_admin_token";
const loginCard = $("loginCard");
const adminCard = $("adminCard");
const statusPill = $("statusPill");
const loginMessage = $("loginMessage");
const adminMessage = $("adminMessage");
const adminPassword = $("adminPassword");
const openaiModel = $("openaiModel");
const authMode = $("authMode");

function setMessage(element, text, type = "") {
  element.textContent = text || "";
  element.className = `message ${type}`.trim();
}

function getToken() {
  return sessionStorage.getItem(tokenKey) || "";
}

function setToken(token) {
  sessionStorage.setItem(tokenKey, token);
}

async function api(path, options = {}) {
  const headers = {
    ...(options.headers || {})
  };

  if (options.body) {
    headers["Content-Type"] = "application/json";
  }

  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(path, {
    ...options,
    headers
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || `Error ${response.status}`);
  }

  return data;
}

function renderStatus(data) {
  const config = data.config || {};
  $("openaiStatus").textContent = config.openaiConfigured ? `Configurado (${config.openaiModel})` : "Falta OPENAI_API_KEY";
  $("supabaseStatus").textContent = config.supabaseConfigured ? "Configurado" : "Faltan SUPABASE_URL o SUPABASE_ANON_KEY";
  $("authRequiredStatus").textContent = config.authRequiredNow ? `Si (${config.authMode})` : `No (${config.authMode})`;
  $("originStatus").textContent = config.allowedExtensionOrigin || "*";
  openaiModel.value = config.openaiModel || "";
  authMode.value = config.authMode || "auto";
  statusPill.textContent = "Admin activo";
  statusPill.className = "pill ok";
}

async function loadStatus() {
  const data = await api("/admin/api/status");
  renderStatus(data);
}

async function login() {
  setMessage(loginMessage, "");
  const data = await api("/admin/api/login", {
    method: "POST",
    headers: {
      "x-admin-password": adminPassword.value
    }
  });
  setToken(data.token);
  adminPassword.value = "";
  loginCard.classList.add("hidden");
  adminCard.classList.remove("hidden");
  await loadStatus();
}

async function saveConfig() {
  setMessage(adminMessage, "");
  const data = await api("/admin/api/config", {
    method: "PUT",
    body: JSON.stringify({
      openaiModel: openaiModel.value.trim(),
      authMode: authMode.value
    })
  });
  renderStatus(data);
  setMessage(adminMessage, "Configuracion runtime guardada.", "ok");
}

$("loginButton").addEventListener("click", () => {
  login().catch((error) => setMessage(loginMessage, error.message, "error"));
});

adminPassword.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    login().catch((error) => setMessage(loginMessage, error.message, "error"));
  }
});

$("refreshButton").addEventListener("click", () => {
  loadStatus().catch((error) => setMessage(adminMessage, error.message, "error"));
});

$("saveButton").addEventListener("click", () => {
  saveConfig().catch((error) => setMessage(adminMessage, error.message, "error"));
});

if (getToken()) {
  loginCard.classList.add("hidden");
  adminCard.classList.remove("hidden");
  loadStatus().catch(() => {
    sessionStorage.removeItem(tokenKey);
    loginCard.classList.remove("hidden");
    adminCard.classList.add("hidden");
    statusPill.textContent = "Sin sesion";
    statusPill.className = "pill";
  });
}
