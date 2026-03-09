# SCPI to LLM

Extensión de Chrome para descargar un artifact de SAP Cloud Integration y convertirlo a un bundle más cómodo para una LLM.

## Enfoque

La extensión usa dos vías:

1. Descarga directa desde el tenant activo mediante el endpoint de design-time `IntegrationDesigntimeArtifacts(...)/$value`, lanzado desde la propia página para reutilizar la sesión abierta.
2. Fallback manual importando un ZIP exportado desde SCPI si SAP cambia el endpoint, el DOM o la sesión no deja hacer la llamada directa.

La salida es un ZIP `*-llm-ready.zip` con:

- `README.md` con resumen funcional del flow.
- `summary/flow.json` con metadatos, parámetros, adapters y pasos BPMN.
- `source/...` con los ficheros textuales del artifact normalizados y, cuando aplica, formateados.

## Desarrollo

```bash
npm install
npm run build
```

El build genera la extensión en `dist/`.

## Cargar en Chrome

1. Abre `chrome://extensions`.
2. Activa `Developer mode`.
3. Pulsa `Load unpacked`.
4. Selecciona `/Users/serpean/m/scpi-to-llm/dist`.

## Uso

1. Abre tu tenant de SAP Integration Suite en Chrome.
2. Sitúate en la vista de artifacts del content package.
3. Abre el popup de la extensión.
4. Selecciona el Integration Flow detectado.
5. Pulsa `Download for LLM`.

Si la descarga directa falla, usa `Fallback manual` con el ZIP exportado desde SAP.

## Test local

Con el ZIP de ejemplo presente en `example/`:

```bash
npm test
```

## Limitaciones actuales

- La detección de artifacts en la tabla de SAP se basa en el DOM visible; si SAP cambia mucho la UI puede dejar de listar bien los rows.
- La descarga directa asume que el tenant permite `GET /api/v1/IntegrationDesigntimeArtifacts(Id='...',Version='...')/$value` con la sesión ya abierta.
- El parser resume BPMN, adapters, mappings y scripts, pero no interpreta semánticamente el contenido interno de cada `.mmap`.
