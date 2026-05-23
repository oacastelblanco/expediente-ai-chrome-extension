const $ = (id) => document.getElementById(id);

const tokenKey = "expediente_ai_admin_token";
const loginCard = $("loginCard");
const adminCard = $("adminCard");
const statusPill = $("statusPill");
const loginMessage = $("loginMessage");
const adminMessage = $("adminMessage");
const usersCard = $("usersCard");
const usersList = $("usersList");
const usersMessage = $("usersMessage");
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
    "Content-Type": "application/json",
    ...(options.headers || {})
  };
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
  $("supabaseStatus").textContent = config.supabaseConfigured
    ? (config.supabaseAdminConfigured ? "Configurado con administracion" : "Falta SUPABASE_SERVICE_ROLE_KEY")
    : "Faltan SUPABASE_URL o SUPABASE_ANON_KEY";
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

function renderUsers(users = []) {
  usersList.textContent = "";

  if (!users.length) {
    usersList.textContent = "No hay usuarios registrados.";
    return;
  }

  for (const user of users) {
    const row = document.createElement("div");
    row.className = "user-row";

    const info = document.createElement("div");
    const name = document.createElement("div");
    name.className = "user-name";
    name.textContent = user.nombre_completo || user.email || "Usuario sin nombre";

    const meta = document.createElement("div");
    meta.className = "user-meta";
    meta.textContent = [
      user.email,
      user.prefijo,
      user.matricula_abogado ? `Matricula: ${user.matricula_abogado}` : ""
    ].filter(Boolean).join(" | ");

    const toggleLabel = document.createElement("label");
    toggleLabel.className = "user-toggle";
    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.checked = Boolean(user.is_enabled);
    const text = document.createElement("span");
    text.textContent = toggle.checked ? "Habilitado" : "Deshabilitado";

    toggle.addEventListener("change", async () => {
      toggle.disabled = true;
      try {
        const data = await api(`/admin/api/users/${encodeURIComponent(user.id)}`, {
          method: "PATCH",
          body: JSON.stringify({ is_enabled: toggle.checked })
        });
        user.is_enabled = Boolean(data.user?.is_enabled);
        toggle.checked = user.is_enabled;
        text.textContent = user.is_enabled ? "Habilitado" : "Deshabilitado";
        setMessage(usersMessage, "Usuario actualizado.", "ok");
      } catch (error) {
        toggle.checked = !toggle.checked;
        setMessage(usersMessage, error.message, "error");
      } finally {
        toggle.disabled = false;
      }
    });

    info.append(name, meta);
    toggleLabel.append(toggle, text);
    row.append(info, toggleLabel);
    usersList.appendChild(row);
  }
}

async function loadUsers() {
  setMessage(usersMessage, "");
  const data = await api("/admin/api/users");
  renderUsers(data.users || []);
}

async function login() {
  setMessage(loginMessage, "");
  const data = await api("/admin/api/login", {
    method: "POST",
    body: JSON.stringify({ password: adminPassword.value })
  });
  setToken(data.token);
  adminPassword.value = "";
  loginCard.classList.add("hidden");
  adminCard.classList.remove("hidden");
  usersCard.classList.remove("hidden");
  await loadStatus();
  await loadUsers();
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

$("refreshUsersButton").addEventListener("click", () => {
  loadUsers().catch((error) => setMessage(usersMessage, error.message, "error"));
});

$("saveButton").addEventListener("click", () => {
  saveConfig().catch((error) => setMessage(adminMessage, error.message, "error"));
});

if (getToken()) {
  loginCard.classList.add("hidden");
  adminCard.classList.remove("hidden");
  usersCard.classList.remove("hidden");
  loadStatus().catch(() => {
    sessionStorage.removeItem(tokenKey);
    loginCard.classList.remove("hidden");
    adminCard.classList.add("hidden");
    usersCard.classList.add("hidden");
    statusPill.textContent = "Sin sesion";
    statusPill.className = "pill";
  });
  loadUsers().catch((error) => setMessage(usersMessage, error.message, "error"));
}
