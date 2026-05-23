import "dotenv/config";
import { config } from "dotenv";
import express from "express";
import cors from "cors";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const backendDir = dirname(fileURLToPath(import.meta.url));
config({ path: join(backendDir, ".env"), override: false });

const adminAssets = {
  html: readFileSync(join(backendDir, "admin.html"), "utf8"),
  css: readFileSync(join(backendDir, "admin.css"), "utf8"),
  js: readFileSync(join(backendDir, "admin.js"), "utf8")
};

const app = express();

const PORT = Number(process.env.PORT || 3001);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY?.trim();
const DEFAULT_OPENAI_MODEL = process.env.OPENAI_MODEL?.trim() || "gpt-5-mini";
const SUPABASE_URL = process.env.SUPABASE_URL?.trim().replace(/\/+$/, "") || "";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY?.trim() || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD?.trim() || "";
const ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET?.trim() || crypto.randomBytes(32).toString("hex");
const ALLOWED_EXTENSION_ORIGIN = process.env.ALLOWED_EXTENSION_ORIGIN || "*";
const allowedOrigins = ALLOWED_EXTENSION_ORIGIN
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const adminConfig = {
  openaiModel: DEFAULT_OPENAI_MODEL,
  authMode: process.env.AUTH_MODE?.trim() || "auto"
};

function getAllowedOrigin(origin) {
  if (allowedOrigins.includes("*")) return "*";
  if (!origin) return "*";
  if (origin.startsWith("chrome-extension://")) return origin;
  if (allowedOrigins.includes(origin)) return origin;
  return "";
}

app.use((req, res, next) => {
  const allowedOrigin = getAllowedOrigin(req.headers.origin);

  if (allowedOrigin) {
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  next();
});

app.use(cors({
  origin(origin, callback) {
    const allowedOrigin = getAllowedOrigin(origin);
    if (allowedOrigin) {
      callback(null, allowedOrigin);
      return;
    }

    callback(null, false);
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(express.json({ limit: "25mb" }));

function isSupabaseConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

function isSupabaseAdminConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

function shouldRequireAuth() {
  if (adminConfig.authMode === "on") return true;
  if (adminConfig.authMode === "off") return false;
  return isSupabaseConfigured();
}

function getBearerToken(req) {
  const authorization = req.headers.authorization || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || "";
}

async function verifySupabaseUser(req, res, next) {
  if (!shouldRequireAuth()) {
    next();
    return;
  }

  if (!isSupabaseConfigured()) {
    res.status(500).json({
      error: "El backend requiere autenticacion, pero faltan SUPABASE_URL o SUPABASE_ANON_KEY."
    });
    return;
  }

  const token = getBearerToken(req);
  if (!token) {
    res.status(401).json({
      error: "Sesion requerida. Inicia sesion en la extension antes de usar el backend."
    });
    return;
  }

  try {
    const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token}`
      }
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok || !data?.id) {
      res.status(401).json({
        error: "Sesion invalida o expirada. Vuelve a iniciar sesion."
      });
      return;
    }

    req.user = {
      id: data.id,
      email: data.email || ""
    };
    next();
  } catch (_error) {
    res.status(502).json({
      error: "No se pudo validar la sesion con Supabase."
    });
  }
}

async function supabaseAdminFetch(path, options = {}) {
  if (!isSupabaseAdminConfigured()) {
    throw new Error("Falta configurar SUPABASE_SERVICE_ROLE_KEY en el backend.");
  }

  const response = await fetch(`${SUPABASE_URL}${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(data?.message || data?.error || `Error Supabase Admin: ${response.status}`);
  }

  return data;
}

async function requireEnabledUser(req, res, next) {
  if (!shouldRequireAuth()) {
    next();
    return;
  }

  if (!req.user?.id) {
    res.status(401).json({ error: "Sesion requerida. Inicia sesion nuevamente." });
    return;
  }

  try {
    const access = await getUserGenerationAccess(req.user.id);

    if (!access.isEnabled) {
      res.status(403).json({
        error: "Tu usuario aun no esta habilitado para generar escritos. Solicita activacion al administrador."
      });
      return;
    }

    if (!access.canGenerate) {
      res.status(403).json({
        error: `Alcanzaste el maximo de escritos generados permitido (${access.totalDrafts}/${access.maxGenerations}). Solicita ampliacion al administrador.`
      });
      return;
    }

    next();
  } catch (error) {
    res.status(500).json({
      error: error.message || "No se pudo verificar si el usuario esta habilitado."
    });
  }
}

async function getUserGenerationAccess(userId) {
  const rows = await supabaseAdminFetch(`/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=id,is_enabled,max_generations`, {
    method: "GET"
  });
  const profile = Array.isArray(rows) ? rows[0] : null;
  const usageStats = await getUsageStatsByUser();
  const totalDrafts = usageStats.get(userId)?.totalDrafts || 0;
  const maxGenerations = Number(profile?.max_generations || 0);

  return {
    isEnabled: Boolean(profile?.is_enabled),
    maxGenerations,
    totalDrafts,
    canGenerate: Boolean(profile?.is_enabled) && maxGenerations > totalDrafts
  };
}

async function logUsageEvent(req, draft) {
  if (!req.user?.id || !isSupabaseAdminConfigured()) return;

  const metadata = req.body?.page?.metadata || {};
  const payload = {
    user_id: req.user.id,
    document_type: req.body?.documentType || "otro",
    process_number: metadata.numeroProceso || null,
    page_text_length: typeof req.body?.pageText === "string" ? req.body.pageText.length : 0,
    draft_length: typeof draft === "string" ? draft.length : 0
  };

  try {
    await supabaseAdminFetch("/rest/v1/usage_events", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(payload)
    });
  } catch (error) {
    console.warn("No se pudo registrar el uso.", error.message || error);
  }
}

async function getUsageStatsByUser() {
  try {
    const events = await supabaseAdminFetch("/rest/v1/usage_events?select=user_id,document_type,page_text_length,draft_length,created_at&order=created_at.desc&limit=10000", {
      method: "GET"
    });
    const stats = new Map();

    for (const event of Array.isArray(events) ? events : []) {
      const userId = event.user_id;
      if (!userId) continue;

      const current = stats.get(userId) || {
        totalDrafts: 0,
        totalPageTextLength: 0,
        totalDraftLength: 0,
        lastUsedAt: null,
        documentTypes: {}
      };

      current.totalDrafts += 1;
      current.totalPageTextLength += Number(event.page_text_length || 0);
      current.totalDraftLength += Number(event.draft_length || 0);
      current.lastUsedAt = current.lastUsedAt || event.created_at || null;

      const documentType = event.document_type || "otro";
      current.documentTypes[documentType] = (current.documentTypes[documentType] || 0) + 1;
      stats.set(userId, current);
    }

    return stats;
  } catch (error) {
    console.warn("No se pudieron cargar metricas de uso.", error.message || error);
    return new Map();
  }
}

function signAdminToken(payload) {
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto
    .createHmac("sha256", ADMIN_SESSION_SECRET)
    .update(encodedPayload)
    .digest("base64url");
  return `${encodedPayload}.${signature}`;
}

function verifyAdminToken(token) {
  const [encodedPayload, signature] = String(token || "").split(".");
  if (!encodedPayload || !signature) return null;

  const expected = crypto
    .createHmac("sha256", ADMIN_SESSION_SECRET)
    .update(encodedPayload)
    .digest("base64url");

  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (signatureBuffer.length !== expectedBuffer.length) return null;
  if (!crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) return null;

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch (_error) {
    return null;
  }
}

function requireAdmin(req, res, next) {
  const token = getBearerToken(req);
  const payload = verifyAdminToken(token);
  if (!payload) {
    res.status(401).json({ error: "Sesion de administrador requerida." });
    return;
  }

  next();
}

function getAdminStatus() {
  return {
    ok: true,
    service: "expediente-ai-backend",
    config: {
      openaiConfigured: Boolean(OPENAI_API_KEY && OPENAI_API_KEY !== "pega_aqui_tu_api_key"),
      openaiModel: adminConfig.openaiModel,
      supabaseConfigured: isSupabaseConfigured(),
      supabaseAdminConfigured: isSupabaseAdminConfigured(),
      authMode: adminConfig.authMode,
      authRequiredNow: shouldRequireAuth(),
      allowedExtensionOrigin: ALLOWED_EXTENSION_ORIGIN
    }
  };
}

function validateDraftPayload(body) {
  if (!body?.instruction || typeof body.instruction !== "string") {
    throw new Error("Falta la instruccion para generar el escrito.");
  }

  if (!body?.pageText || typeof body.pageText !== "string") {
    throw new Error("Falta el texto del expediente.");
  }

  if (body.pageText.length > 90000) {
    throw new Error("El texto capturado es demasiado extenso. Reduce el texto relevante.");
  }
}

function buildPrompt({ documentType, instruction, pageText, page, representation, profile, notifications }) {
  const metadata = page?.metadata ? JSON.stringify(page.metadata, null, 2) : "{}";
  const representedParty = representation?.name
    ? `${representation.role || "Parte"}: ${representation.name}`
    : page?.metadata?.representacion || "[dato pendiente]";
  const lawyerDisplayName = profile?.lawyerName
    ? `${profile.lawyerPrefix || "Ab."} ${profile.lawyerName}`
    : "";
  const lawyerProfile = lawyerDisplayName
    ? `${lawyerDisplayName}${profile.lawyerBarNumber ? ` - Matricula: ${profile.lawyerBarNumber}` : ""}`
    : "[dato pendiente]";
  const notificationInstructions = notifications?.enabled
    ? [
      "Incluye apartado **NOTIFICACIONES**.",
      `Correo electronico para notificaciones: ${notifications.email || "[dato pendiente]"}.`,
      `Casillero judicial: ${notifications.judicialBox || "[dato pendiente]"}.`
    ].join("\n")
    : "No incluyas apartado de NOTIFICACIONES ni menciones correo o casillero judicial, salvo que la instruccion del abogado lo pida expresamente.";
  const documentInstructions = {
    peticion_simple: [
      "Este es un escrito sencillo. Debe ser lo mas concreto y directo posible.",
      "No redactes antecedentes extensos. Incluye solo los hechos indispensables para entender la solicitud expresa.",
      "Debe poder leerse rapidamente: idealmente 4 a 7 parrafos breves, salvo que la instruccion exija mas.",
      "Evita desarrollar fundamentos juridicos largos si no fueron pedidos expresamente.",
      "Prioriza: referencia minima al proceso, **SOLICITUD EXPRESA** puntual y firma. Agrega notificaciones solo si estan activadas."
    ].join("\n"),
    contestacion: [
      "Organiza la respuesta por puntos claros y contesta los hechos relevantes sin divagar.",
      "Distingue antecedentes, posicion de la parte, excepciones o argumentos y **SOLICITUD EXPRESA** final."
    ].join("\n"),
    impulso_procesal: [
      "Debe ser muy breve y orientado unicamente a obtener despacho o continuidad procesal.",
      "Usa solo dos secciones de contenido, aparte del encabezado y pie de firma: **ANTECEDENTES** y **SOLICITUD EXPRESA**.",
      "En antecedentes incluye maximo 1 o 2 parrafos cortos con la actuacion pendiente indispensable.",
      "En solicitud expresa formula una peticion directa en maximo 1 o 2 parrafos cortos.",
      "No incluyas secciones de fundamentos, solicitud concreta separada ni desarrollo juridico extenso."
    ].join("\n"),
    solicitud_medida: [
      "Explica con claridad la medida solicitada, su necesidad, proporcionalidad y datos que la sustentan.",
      "No inventes presupuestos facticos que no consten en el expediente."
    ].join("\n"),
    recurso: [
      "Estructura el recurso con decision impugnada, oportunidad, agravios concretos y **SOLICITUD EXPRESA**.",
      "Evita argumentos genericos; cada agravio debe conectarse con una actuacion o hecho del expediente."
    ].join("\n"),
    alegato: [
      "Presenta una sintesis ordenada de hechos relevantes, prueba o actuaciones y conclusion.",
      "Mantén tono persuasivo, sobrio y sin extenderte en informacion irrelevante."
    ].join("\n"),
    otro: "Adapta la extension y estructura a la instruccion del abogado, evitando texto innecesario."
  };
  const specificInstructions = documentInstructions[documentType] || documentInstructions.otro;

  return `
Eres un asistente juridico para abogados litigantes en Ecuador.
Tu funcion es preparar un BORRADOR editable de escrito judicial. No presentes conclusiones como definitivas.

Reglas:
1. Usa solo la informacion proporcionada en el texto del expediente y en la instruccion del abogado.
2. Si falta un dato procesal relevante, coloca [dato pendiente] en lugar de inventarlo.
3. No inventes articulos, fechas, providencias, nombres, numeros de proceso ni actuaciones.
4. Redacta en espanol juridico ecuatoriano, con tono formal, claro y sobrio.
5. No incluyas apartado **COMPARECENCIA**. El encabezado ya cumple esa funcion.
6. Usa **SOLICITUD EXPRESA** como unico rotulo para la peticion, solicitud concreta o solicitud final. No uses los rotulos FUNDAMENTOS O PETICION, SOLICITUD CONCRETA ni PETICION.
7. Evita frases genericas extensas y repeticiones.
8. Si el escrito depende de validar un hecho no visible en el expediente, deja una nota breve entre corchetes.
9. No agregues jurisprudencia o normas especificas salvo que aparezcan en el expediente o sean pedidas expresamente.
10. Redacta el borrador listo para copiar a Word e imprimir: usa titulos claros en mayusculas, parrafos breves, saltos de linea entre secciones, formato sobrio y espaciado visual agradable.
11. No uses tablas ni viñetas decorativas. El texto debe abrirse bien como documento formal en Word.
12. Marca en negrita todos los datos particulares insertados en el escrito usando exactamente doble asterisco: **dato**. Esto incluye judicatura, numero de proceso, procedimiento, actor, demandado, parte representada, nombre del abogado, matricula, fechas, valores y cualquier dato especifico del expediente.
13. Cuando corresponda, deja la firma al final centrada conceptualmente, con el nombre del abogado y su matricula si fueron proporcionados. Marca toda la firma en negrita usando **...**.
14. El encabezado del escrito debe seguir siempre esta estructura, adaptando los datos disponibles y marcando los datos particulares en negrita:
**SEÑOR JUEZ DE** **[JUDICATURA]**. -
**Proceso No.:** **[NUMERO DE PROCESO]**
**[PREFIJO Y NOMBRE DEL ABOGADO]**, en calidad de abogado autorizado de **[PARTE REPRESENTADA]**, dentro del juicio **[PROCEDIMIENTO]** No. **[NUMERO DE PROCESO]**, ante usted comparezco y expongo lo siguiente:
15. Si falta algun dato del encabezado, usa **[dato pendiente]**, pero no cambies la estructura del encabezado.
16. Estos rotulos pueden usarse si corresponden al tipo de escrito y a la instruccion: **ANTECEDENTES**, **SOLICITUD EXPRESA**, **FIRMA**. Usa **NOTIFICACIONES** solo si las instrucciones de notificaciones lo activan.
17. No agregues apartados vacios ni apartados cuyo contenido sea solo **[dato pendiente]**. Si no hay contenido real para un apartado opcional, omite ese apartado.
18. No pongas texto de contenido en la misma linea de esos rotulos. Despues de cada rotulo, deja el contenido en parrafos separados.

Tipo de escrito solicitado: ${documentType || "otro"}

Instrucciones particulares para este tipo de escrito:
${specificInstructions}

Parte representada para este escrito:
${representedParty}

Abogado que utiliza la herramienta:
${lawyerProfile}

Instrucciones de notificaciones:
${notificationInstructions}

Instruccion del abogado:
${instruction}

Metadatos detectados:
${metadata}

Fuente:
Titulo: ${page?.title || "[dato pendiente]"}
URL: ${page?.url || "[dato pendiente]"}
Capturado: ${page?.capturedAt || "[dato pendiente]"}

Texto visible del expediente:
${pageText}
`.trim();
}

function extractDraftFromResponse(data) {
  if (typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text;
  }

  const textParts = data.output
    ?.flatMap((item) => item.content || [])
    ?.filter((content) => content.type === "output_text" && content.text)
    ?.map((content) => content.text);

  return textParts?.join("\n\n").trim() || "";
}

function cleanPdfText(value) {
  return (value || "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodePdfString(value) {
  return value
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\\(/g, "(")
    .replace(/\\\)/g, ")")
    .replace(/\\\\/g, "\\")
    .replace(/\\([0-7]{1,3})/g, (_match, octal) => String.fromCharCode(parseInt(octal, 8)));
}

function decodePdfHexString(hex) {
  const normalized = hex.replace(/\s+/g, "");
  const bytes = [];

  for (let index = 0; index < normalized.length - 1; index += 2) {
    bytes.push(parseInt(normalized.slice(index, index + 2), 16));
  }

  const buffer = Buffer.from(bytes);
  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    const codeUnits = [];
    for (let index = 2; index < buffer.length - 1; index += 2) {
      codeUnits.push(buffer.readUInt16BE(index));
    }
    return String.fromCharCode(...codeUnits);
  }

  if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString("utf16le");

  return buffer.toString("latin1");
}

function extractTextFromPdfSyntax(buffer) {
  const raw = buffer.toString("latin1");
  const parts = [];
  const textBlocks = raw.match(/BT[\s\S]*?ET/g) || [];

  for (const block of textBlocks) {
    for (const match of block.matchAll(/\((?:\\.|[^\\)])*\)\s*T[jJ]/g)) {
      parts.push(decodePdfString(match[0].replace(/\)\s*T[jJ]$/, "").slice(1)));
    }

    for (const match of block.matchAll(/<([0-9a-fA-F\s]+)>\s*T[jJ]/g)) {
      parts.push(decodePdfHexString(match[1]));
    }

    for (const arrayMatch of block.matchAll(/\[((?:.|\n|\r)*?)\]\s*TJ/g)) {
      const arrayContent = arrayMatch[1];

      for (const stringMatch of arrayContent.matchAll(/\((?:\\.|[^\\)])*\)/g)) {
        parts.push(decodePdfString(stringMatch[0].slice(1, -1)));
      }

      for (const hexMatch of arrayContent.matchAll(/<([0-9a-fA-F\s]+)>/g)) {
        parts.push(decodePdfHexString(hexMatch[1]));
      }
    }
  }

  return cleanPdfText(parts.join(" "));
}

async function extractPdfText(buffer) {
  const attempts = [];

  try {
    const { default: pdfParse } = await import("pdf-parse");
    const parsed = await pdfParse(buffer);
    const text = cleanPdfText(parsed.text);

    attempts.push({
      method: "pdf-parse",
      pages: parsed.numpages || null,
      length: text.length
    });

    if (text.length >= 30) {
      return {
        text,
        pages: parsed.numpages || null,
        method: "pdf-parse",
        attempts
      };
    }
  } catch (error) {
    attempts.push({
      method: "pdf-parse",
      error: error.message || "pdf-parse failed"
    });
  }

  const syntaxText = extractTextFromPdfSyntax(buffer);
  attempts.push({
    method: "pdf-syntax",
    length: syntaxText.length
  });

  return {
    text: syntaxText,
    pages: null,
    method: syntaxText ? "pdf-syntax" : null,
    attempts
  };
}

function handleHealth(_req, res) {
  res.json({
    ok: true,
    service: "expediente-ai-backend",
    authRequired: shouldRequireAuth()
  });
}

app.get("/health", handleHealth);
app.get("/api/health", handleHealth);

app.get("/api/client-config", (_req, res) => {
  res.json({
    ok: true,
    supabase: {
      url: SUPABASE_URL,
      anonKey: SUPABASE_ANON_KEY
    }
  });
});

app.get("/api/me/permissions", verifySupabaseUser, async (req, res) => {
  try {
    const access = await getUserGenerationAccess(req.user.id);
    res.json({
      ok: true,
      user: req.user,
      permissions: {
        canGenerate: access.canGenerate,
        isEnabled: access.isEnabled,
        maxGenerations: access.maxGenerations,
        totalDrafts: access.totalDrafts
      }
    });
  } catch (error) {
    res.status(500).json({
      error: error.message || "No se pudieron verificar los permisos del usuario."
    });
  }
});

app.get("/admin", (_req, res) => {
  res.type("html").send(adminAssets.html);
});

app.get("/admin/admin.css", (_req, res) => {
  res.type("css").send(adminAssets.css);
});

app.get("/admin/admin.js", (_req, res) => {
  res.type("js").send(adminAssets.js);
});

app.post("/admin/api/login", (req, res) => {
  if (!ADMIN_PASSWORD) {
    res.status(503).json({
      error: "Falta configurar ADMIN_PASSWORD en Vercel Environment Variables para Production y hacer redeploy."
    });
    return;
  }

  if (req.body?.password !== ADMIN_PASSWORD) {
    res.status(401).json({ error: "Clave de administrador incorrecta." });
    return;
  }

  const token = signAdminToken({
    role: "admin",
    exp: Date.now() + 1000 * 60 * 60 * 8
  });

  res.json({ ok: true, token });
});

app.get("/admin/api/status", requireAdmin, (_req, res) => {
  res.json(getAdminStatus());
});

app.get("/admin/api/users", requireAdmin, async (_req, res) => {
  try {
    const users = await supabaseAdminFetch("/rest/v1/profiles?select=id,email,prefijo,nombre_completo,matricula_abogado,is_enabled,max_generations,created_at&order=created_at.desc", {
      method: "GET"
    });
    const usageStats = await getUsageStatsByUser();
    const usersWithUsage = (Array.isArray(users) ? users : []).map((user) => ({
      ...user,
      usage: usageStats.get(user.id) || {
        totalDrafts: 0,
        totalPageTextLength: 0,
        totalDraftLength: 0,
        lastUsedAt: null,
        documentTypes: {}
      }
    }));

    res.json({ ok: true, users: usersWithUsage });
  } catch (error) {
    res.status(500).json({
      error: error.message || "No se pudieron cargar los usuarios."
    });
  }
});

app.patch("/admin/api/users/:id", requireAdmin, async (req, res) => {
  try {
    if (req.body?.is_enabled !== undefined && typeof req.body.is_enabled !== "boolean") {
      res.status(400).json({ error: "is_enabled debe ser booleano." });
      return;
    }

    const updates = {};
    if (typeof req.body?.is_enabled === "boolean") {
      updates.is_enabled = req.body.is_enabled;
    }
    if (req.body?.max_generations !== undefined) {
      const maxGenerations = Number(req.body.max_generations);
      if (!Number.isInteger(maxGenerations) || maxGenerations < 0) {
        res.status(400).json({ error: "max_generations debe ser un entero mayor o igual a 0." });
        return;
      }
      updates.max_generations = maxGenerations;
    }

    if (!Object.keys(updates).length) {
      res.status(400).json({ error: "No hay cambios para actualizar." });
      return;
    }

    const rows = await supabaseAdminFetch(`/rest/v1/profiles?id=eq.${encodeURIComponent(req.params.id)}&select=id,email,prefijo,nombre_completo,matricula_abogado,is_enabled,max_generations,created_at`, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(updates)
    });

    res.json({ ok: true, user: Array.isArray(rows) ? rows[0] : null });
  } catch (error) {
    res.status(500).json({
      error: error.message || "No se pudo actualizar el usuario."
    });
  }
});

app.put("/admin/api/config", requireAdmin, (req, res) => {
  const nextModel = String(req.body?.openaiModel || "").trim();
  const nextAuthMode = String(req.body?.authMode || "").trim();

  if (!nextModel) {
    res.status(400).json({ error: "El modelo no puede estar vacio." });
    return;
  }

  if (!["auto", "on", "off"].includes(nextAuthMode)) {
    res.status(400).json({ error: "Modo de autenticacion invalido." });
    return;
  }

  adminConfig.openaiModel = nextModel;
  adminConfig.authMode = nextAuthMode;

  res.json(getAdminStatus());
});

async function handlePdfText(req, res) {
  try {
    const { pdfBase64, filename } = req.body || {};

    if (!pdfBase64 || typeof pdfBase64 !== "string") {
      res.status(400).json({ error: "Falta el PDF en base64." });
      return;
    }

    const pdfBuffer = Buffer.from(pdfBase64, "base64");
    const header = pdfBuffer.subarray(0, 5).toString("latin1");

    if (header !== "%PDF-") {
      res.status(400).json({
        error: `El archivo capturado no parece ser un PDF valido. Encabezado detectado: ${JSON.stringify(header)}.`
      });
      return;
    }

    const extracted = await extractPdfText(pdfBuffer);

    res.json({
      ok: true,
      filename: filename || "expediente.pdf",
      pages: extracted.pages,
      text: extracted.text,
      originalLength: extracted.text.length,
      method: extracted.method,
      attempts: extracted.attempts
    });
  } catch (error) {
    if (error.code === "ERR_MODULE_NOT_FOUND") {
      res.status(500).json({
        error: "Falta instalar la dependencia pdf-parse. Ejecuta npm install en la carpeta backend."
      });
      return;
    }

    res.status(400).json({
      error: error.message || "No se pudo extraer texto del PDF."
    });
  }
}

app.post("/api/pdf-text", verifySupabaseUser, handlePdfText);
app.post("/pdf-text", verifySupabaseUser, handlePdfText);

async function handleDraft(req, res) {
  try {
    validateDraftPayload(req.body);

    if (!OPENAI_API_KEY || OPENAI_API_KEY === "pega_aqui_tu_api_key") {
      res.status(500).json({
        error: "Falta configurar OPENAI_API_KEY en backend/.env."
      });
      return;
    }

    const prompt = buildPrompt(req.body);

    const aiResponse = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: adminConfig.openaiModel,
        input: [
          {
            role: "system",
            content: "Eres un asistente juridico experto para abogados litigantes en Ecuador."
          },
          {
            role: "user",
            content: prompt
          }
        ]
      })
    });

    const data = await aiResponse.json().catch(() => ({}));

    if (!aiResponse.ok) {
      res.status(aiResponse.status).json({
        error: data.error?.message || "Error al llamar a OpenAI."
      });
      return;
    }

    const draft = extractDraftFromResponse(data);
    await logUsageEvent(req, draft);

    res.json({
      ok: true,
      draft
    });
  } catch (error) {
    res.status(400).json({
      error: error.message || "Solicitud invalida."
    });
  }
}

app.post("/api/draft", verifySupabaseUser, requireEnabledUser, handleDraft);
app.post("/draft", verifySupabaseUser, requireEnabledUser, handleDraft);

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  app.listen(PORT, () => {
    console.log(`Expediente AI backend activo en http://localhost:${PORT}`);
  });
}

export default app;
