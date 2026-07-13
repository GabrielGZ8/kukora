# Kukora — Resumen de arreglos aplicados

## ✅ Todo completado

1. **Reporte con error "Authentication required" / NO_TOKEN**
   - Archivo: `src/components/common/SystemStatusBar.jsx`
   - Causa: el botón "Report" era un `<a href="/api/arbitrage/report/html">` — una navegación de link normal nunca envía el header `Authorization`, que es donde vive tu token (no está en una cookie).
   - Fix: ahora es un botón que hace `fetch` con `Authorization: Bearer <token>`, descarga el HTML como blob y lo abre en pestaña nueva. Muestra "… Generando" mientras carga.

2. **Banner "SYSTEM READY5/5 exchanges live..." pegado y feo**
   - Archivos: `src/components/common/EngineReadyBanner.jsx`, `src/styles/global.css`
   - Causa: la clase `.status-banner` no tenía NINGÚN CSS definido en todo el proyecto — por eso los `<span>` internos no tenían espacio ni separación entre sí.
   - Fix: se agregó la clase con `display:flex`, `gap`, `padding` y separadores visuales "·" entre cada dato. Además traducido: "SISTEMA LISTO", "CALENTANDO MOTORES", "CONECTANDO".

3. **Campana de notificaciones no hace nada al hacer clic**
   - Archivo: `src/components/layout/NotificationBell.jsx`
   - Causa real: el `<header>` del layout tiene `overflow: hidden` (para recortar la animación de pájaros de fondo). El dropdown de notificaciones era `position: absolute` DENTRO de ese header, así que quedaba recortado/invisible aunque el clic sí abría el estado — por eso "no pasaba nada" visualmente.
   - Fix: el dropdown ahora es `position: fixed`, anclado a la posición real del botón vía `getBoundingClientRect()`, así ya no lo recorta el header.
   - De paso, traducido: "Notificaciones", "Marcar todas leídas", "Aún no hay notificaciones.", "hace Xm/h/d".

4. **Perfil muestra "Sin nombre", "—", "—" (parece que se borra tu info)**
   - Archivo: `src/pages/ProfilePage.jsx`
   - Causa real (nada se borra en el backend): `GET /api/auth/me` responde `{ ok:true, data:{ user:{...} } }`. El helper interno `get()` de `api.js` ya desempaca `.data`, así que `api.profile.get()` resuelve a `{ user:{...} }` — pero el código guardaba ESE objeto completo como si fuera el usuario (`setProfileData(d)`), en vez de `setProfileData(d.user)`. Por eso `profileData.name` siempre daba `undefined` y cae al placeholder.
   - Fix: se desempaca `d?.user` correctamente tanto al cargar el perfil como al guardar un nombre editado.

5. **Traducción al español — Onboarding / User Guide**
   - `src/components/common/Onboarding.jsx` (el tour del producto, activado por el botón "Guía del Usuario" o la tecla `?`): las 7 pantallas completas traducidas — títulos, subtítulos, descripciones, diagrama de arbitraje, botones de navegación ("← Atrás", "Paso X de Y", "navegar · cerrar").
   - `src/components/common/OnboardingWizard.jsx` (wizard post-registro: nombre, tema, pares de trading, paper vs live): totalmente traducido.
   - `src/components/layout/Layout.jsx`: botón "User Guide" → "Guía del Usuario", "Live · {time}" → "En vivo · {time}", tooltips del header/sidebar (Colapsar menú, Ver perfil, Configuración, Cerrar sesión, Cambiar a modo oscuro/claro).
   - Nota: `src/pages/ProfilePage.jsx` usa el sistema de i18n (`t('profile.title')`, etc.) y esas llaves YA estaban traducidas en `src/i18n/dictionaries/es.js` — no hacía falta tocarlas.

## Verificación
Los 7 archivos modificados fueron validados con `esbuild` (parseo de sintaxis JSX) sin errores.

## Archivos modificados
- src/components/common/SystemStatusBar.jsx
- src/components/common/EngineReadyBanner.jsx
- src/styles/global.css
- src/components/layout/NotificationBell.jsx
- src/components/layout/Layout.jsx
- src/pages/ProfilePage.jsx
- src/components/common/Onboarding.jsx
- src/components/common/OnboardingWizard.jsx

## Cómo aplicar
Estos son los mismos archivos de tu proyecto con los fixes ya adentro — puedes reemplazar directamente esas rutas en tu repo (recuerda: tú ya tienes cambios propios en Dockerfile/i18n/server config que este zip no toca, así que solo copia estos 8 archivos, no todo el zip completo si no quieres pisar tus otros cambios).
