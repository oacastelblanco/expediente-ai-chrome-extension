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
