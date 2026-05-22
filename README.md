# Expediente AI - Chrome Extension + Backend IA

MVP para una extension de Google Chrome que lee el texto visible de una pagina de expediente electronico y genera borradores de escritos judiciales con OpenAI a traves de un backend local.

## Estructura

```text
expediente-ai-chrome-extension/
  chrome-extension/
    manifest.json
    popup.html
    popup.css
    popup.js
    contentScript.js
    service_worker.js
    icons/
  backend/
    server.js
    package.json
    .env
  README.md
```

## Importante

No pongas la API key dentro de la extension. La extension se puede inspeccionar desde el navegador. La API key debe vivir solo en `backend/.env`.

## A. Backend

En una terminal, desde la raiz del proyecto:

```bash
cd backend
npm install
npm run dev
```

Antes de ejecutar `npm run dev`, edita `backend/.env` y reemplaza:

```env
OPENAI_API_KEY=pega_aqui_tu_api_key
```

por tu API key real.

## B. Probar Health

Abre en el navegador:

```text
http://localhost:3001/health
```

Debe responder algo como:

```json
{ "ok": true, "service": "expediente-ai-backend" }
```

## C. Extension

1. Abre `chrome://extensions`.
2. Activa `Modo desarrollador`.
3. Haz clic en `Cargar descomprimida`.
4. Selecciona la carpeta `chrome-extension`, no la carpeta raiz.
5. Abre una pagina de expediente electronico o una pagina con texto de prueba.
6. Haz clic en la extension. Se abrira como barra lateral y quedara abierta.

## D. Backend API En El Popup

Usa esta URL como `Backend API`:

```text
http://localhost:3001/api/draft
```

Si cambias la URL, presiona `Guardar configuracion`.

## D.1 Supabase

La extension puede iniciar sesion y registrar usuarios con Supabase Auth.

1. Crea el proyecto en Supabase.
2. Ejecuta el SQL de la tabla `profiles` y sus policies.
3. En Supabase copia:
   - `Project URL`
   - `anon public key`
4. Abre la extension.
5. En la pantalla de login abre `Configurar Supabase`.
6. Pega `Supabase URL` y `Supabase anon key`.
7. Presiona `Guardar Supabase`.
8. Usa `Registrarse` para crear el usuario con nombre, matricula, correo y casillero.

La `anon key` puede estar en la extension. La API key de OpenAI no debe ir nunca en la extension; debe quedar solo en el backend/Vercel.

## D.2 Proteger El Backend Con Supabase

Para que el backend solo acepte llamadas de usuarios autenticados, configura estas variables en `backend/.env` y tambien en Vercel:

```env
SUPABASE_URL=https://tu-proyecto.supabase.co
SUPABASE_ANON_KEY=tu_anon_public_key
AUTH_MODE=auto
```

Con `AUTH_MODE=auto`, el backend exige sesion cuando `SUPABASE_URL` y `SUPABASE_ANON_KEY` existen. La extension enviara automaticamente el token de Supabase al backend despues de iniciar sesion.

Opciones de `AUTH_MODE`:

- `auto`: exige sesion si Supabase esta configurado.
- `on`: exige sesion siempre.
- `off`: no exige sesion.

## D.3 Panel Administrador Del Backend

El backend expone una interfaz administrativa en:

```text
http://localhost:3001/admin
```

En Vercel:

```text
https://tu-proyecto.vercel.app/admin
```

Configura estas variables antes de usarlo:

```env
ADMIN_PASSWORD=una_clave_segura
ADMIN_SESSION_SECRET=un_texto_largo_aleatorio
```

Desde el panel puedes revisar si OpenAI y Supabase estan configurados, ver si la autenticacion esta activa y ajustar temporalmente el modelo OpenAI o el modo de autenticacion. En Vercel esos ajustes runtime pueden reiniciarse al redeplegar o al cambiar de instancia; para cambios permanentes usa Environment Variables.

## E. Flujo De Prueba

1. Presiona `Leer expediente`.
2. La extension intentara presionar `Exportar PDF`, capturar el PDF y extraer su texto en el backend.
3. Si no puede capturar el PDF, usara como respaldo el texto visible de la pagina.
4. Revisa o edita el texto capturado.
5. Escribe una instruccion concreta.
6. Presiona `Generar escrito`.
7. Revisa el borrador generado antes de usarlo.

## Produccion

Para produccion debes publicar el backend, cambiar la URL del backend en la extension, restringir CORS al origen real de tu extension y agregar autenticacion si sera una herramienta privada o comercial.
