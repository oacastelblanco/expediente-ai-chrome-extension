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

app.post("/api/draft", verifySupabaseUser, handleDraft);
app.post("/draft", verifySupabaseUser, handleDraft);

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  app.listen(PORT, () => {
    console.log(`Expediente AI backend activo en http://localhost:${PORT}`);
  });
}

export default app;
