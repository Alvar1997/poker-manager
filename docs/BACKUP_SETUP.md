# Despliegue de respaldos (Módulo 15)

Guía para dejar operativos los respaldos diarios y las pruebas de restauración. **Ningún secreto va en este documento ni en el repositorio.** Hasta completar estos pasos, el panel muestra la automatización como `NOT_CONFIGURED`.

## 1. Dónde corre

Los respaldos **no** corren en la app web: los ejecuta un proceso con acceso a la base y al destino (`npm run backup:daily`). Requisitos del equipo que los ejecute:

- Node.js 22 y el repositorio con `npm ci` (incluye `tsx` y `prisma`).
- Conexión a Neon (`DIRECT_URL`, conexión directa sin pooler).
- Un destino privado con espacio suficiente.
- No hace falta `pg_dump` (Neon corre PostgreSQL 18; el respaldo es lógico y no usa binarios).

## 2. Destino

1. Elige una carpeta **fuera del equipo operativo**: disco externo cifrado, NAS o carpeta sincronizada con un servicio privado. Un destino en el mismo disco no protege ante la pérdida del equipo.
2. Créala con permisos solo para el usuario que corre el respaldo: `mkdir -p <ruta> && chmod 700 <ruta>`.
3. No compartas esa carpeta públicamente; los archivos están cifrados, pero el control de acceso sigue siendo necesario.

## 3. Clave de cifrado

1. Genera una clave de 32 bytes: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
2. Guárdala en un gestor de contraseñas **y** en un lugar físico seguro, separado del destino de respaldos. Sin esta clave los respaldos no se pueden restaurar.
3. Debe ser distinta de `SETTINGS_ENCRYPTION_KEY`.

## 4. Variables (en un archivo privado del equipo de respaldos, p. ej. `~/.poker-manager-backup.env` con `chmod 600`)

```
DATABASE_URL=<cadena de Neon (pooler)>
DIRECT_URL=<cadena directa de Neon>
AUTH_SECRET=<el mismo de la app; lo exige la validación de entorno>
AUTH_URL=<URL de la app>
SETTINGS_ENCRYPTION_KEY=<la de la app>
BACKUP_STORAGE_DIR=<ruta del destino>
BACKUP_ENCRYPTION_KEY=<clave del paso 3>
BACKUP_RETENTION_DAILY_DAYS=30
BACKUP_RETENTION_MONTHLY_MONTHS=6
RESTORE_TEST_DATABASE_URL=<base AISLADA, p. ej. una rama de Neon llamada …restore_test>
```

## 5. Primera ejecución manual

```
set -a; source ~/.poker-manager-backup.env; set +a
npm run ops -- status          # debe decir configured: true
npm run backup:run             # respaldo manual; resultado JSON real
npm run restore:test           # prueba aislada (requiere RESTORE_TEST_DATABASE_URL)
```

Revisa en `/dashboard/administracion/respaldos` el respaldo, su verificación y la prueba de restauración.

## 6. Programación diaria (elige una)

**macOS (launchd)** — `~/Library/LaunchAgents/com.pokermanager.backup.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.pokermanager.backup</string>
  <key>ProgramArguments</key><array>
    <string>/bin/zsh</string><string>-lc</string>
    <string>cd <ruta-del-repo> &amp;&amp; set -a &amp;&amp; source ~/.poker-manager-backup.env &amp;&amp; set +a &amp;&amp; npm run -s backup:daily</string>
  </array>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>6</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>/tmp/pokermanager-backup.log</string>
  <key>StandardErrorPath</key><string>/tmp/pokermanager-backup.err</string>
</dict></plist>
```

`launchctl load ~/Library/LaunchAgents/com.pokermanager.backup.plist`. El equipo debe estar encendido a esa hora (launchd ejecuta al despertar si estaba dormido).

**Linux (cron)**: `0 6 * * * cd <repo> && set -a && . ~/.poker-manager-backup.env && set +a && npm run -s backup:daily >> /var/log/pokermanager-backup.log 2>&1`

Prueba de restauración mensual: la misma programación con `npm run -s restore:monthly` el día 1.

## 7. Comprobación

Al día siguiente, el panel debe mostrar la automatización `ACTIVE` (respaldo SCHEDULED exitoso en las últimas 26 h). Si muestra `STALE` o `FAILING`, revisa el log y la incidencia crítica que se abre automáticamente.

## 8. Precauciones

- Nunca apuntes `RESTORE_TEST_DATABASE_URL` ni `RECOVERY_TARGET_DATABASE_URL` a la base de producción (el sistema lo rechaza, pero no lo intentes).
- No borres archivos del destino a mano: la retención lo hace y lo registra.
- Rota la clave solo si es necesario y conserva la anterior mientras existan respaldos cifrados con ella (el panel muestra la huella de cada uno).
