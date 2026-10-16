# CamiloRey

Predicciones de la Liga Pro Checa de tenis de mesa, marcador en vivo y resultados verificados.
Funciona 100 % gratis y en la nube: no necesita servidor, base de datos de pago ni el PC prendido.

## Cómo funciona

| Pieza | Dónde corre | Costo |
|---|---|---|
| Página (`site/`) | GitHub Pages | Gratis |
| Partidos, picks y resultados (`scripts/update.js`) | GitHub Actions cada ~10 min | Gratis (repo público) |
| Marcador en vivo (`site/js/live.js`) | El navegador de cada visitante lee Rushbet/Kambi cada 2 s | Gratis |
| Login y contador de visitas (`site/js/firebase.js`) | Firebase, plan Spark | Gratis, sin tarjeta |

- **Fuentes:** tt.league-pro.com (torneos, jugadores, resultados) y Rushbet/Kambi (cuotas y en vivo).
- **Modelo:** `scripts/lib/confidence.js` (fórmula con rating, racha, H2H, alternancia, cuota y forma del día).
  Con 40 o más picks resueltos, `scripts/lib/ml-model.js` reentrena solo y decide favorito y confianza.
- **Estado:** vive en la rama `state` (JSON), que se sobrescribe en cada corrida para que el repo no crezca.

## Tareas

- `Actualizar picks y publicar`: corre sola cada 10 min. También con *Run workflow*.
- `Cargar historial (manual)`: carga N días hacia atrás (sin generar picks). Útil una vez al inicio.

## Activar el login y el contador

1. Crea un proyecto en https://console.firebase.google.com (plan Spark, gratis).
2. **Authentication** → Comenzar → activa **Google** y **Correo electrónico/contraseña**.
3. **Authentication → Settings → Authorized domains** → agrega `cash3y3-star.github.io`.
4. **Firestore Database** → Crear base de datos → modo producción → pestaña **Reglas** → pega `FIRESTORE_RULES.txt` → Publicar.
5. **Configuración del proyecto → Tus apps → Web (</>)** → copia el objeto `firebaseConfig` y pégalo en `site/js/config.js` en lugar de `null`.

## Probar en local

```
node scripts/update.js --site-only     # regenera site/data con el estado guardado
python -m http.server 8765 --directory site
```
