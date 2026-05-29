# Kukora — Deployment Guide

## Opción A: Railway (recomendado, más fácil)

1. Sube el código a GitHub (repo público o privado)
2. Entra a [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**
3. Selecciona tu repo → Railway detecta automáticamente `railway.json`
4. En **Variables**, agrega:
   - `NODE_ENV` = `production`
   - `PORT` = `5000` (o déjalo vacío, Railway asigna el puerto automáticamente via `$PORT`)
   - `MONGODB_URI` = tu URI de MongoDB Atlas (opcional)
5. Click **Deploy** — listo en ~2 min

> **Nota:** Railway inyecta `$PORT` automáticamente. El servidor ya lo lee con `process.env.PORT || 5000`.

---

## Opción B: Render

1. Sube a GitHub
2. Entra a [render.com](https://render.com) → **New Web Service** → conecta repo
3. Render detecta `render.yaml` automáticamente
4. Agrega `MONGODB_URI` en Environment si la necesitas
5. Deploy

---

## Opción C: VPS / Fly.io / cualquier servidor

```bash
git clone <tu-repo>
cd kukora
npm install
npm run build          # genera dist/
NODE_ENV=production npm start
```

---

## Problema EADDRINUSE en desarrollo local

Si ves `Error: listen EADDRINUSE :::5000`, tienes dos terminales corriendo el servidor. Solución:

```bash
# Opción 1 — matar el proceso en el puerto y relanzar
npm run dev:kill

# Opción 2 — matar manualmente
npx kill-port 5000
npm run dev
```

**Regla:** Nunca corras `npm start` y `npm run dev` al mismo tiempo — `npm start` ya levanta el servidor en :5000, y `npm run dev` intenta levantarlo de nuevo.
