# Módulo 03 — Gestión de jugadores

## 1. Objetivo

Directorio central de jugadores: registrar, consultar, buscar, editar y activar/desactivar jugadores; trazar sus cambios de teléfono; registrar su consentimiento para notificaciones de WhatsApp; y dejar preparado su perfil para el historial de sesiones, compras, créditos, abonos y liquidaciones.

> **Un jugador NO es un usuario del sistema.** No tiene correo, contraseña, cuenta de acceso ni rol. Vive en su propio modelo (`Player`); el modelo `User` no se tocó para almacenar jugadores.

> **Fuera de alcance:** compras, movimientos de fichas, deudas reales, saldos y envíos de WhatsApp. El perfil no muestra montos, ni siquiera ceros.

## 2. Reglas de negocio

| Regla     | Cómo se cumple                                                                                                                      |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| JUG-01    | `id` cuid, como el resto del proyecto.                                                                                              |
| JUG-02    | Nombre obligatorio (2–120 caracteres, espacios normalizados). `CHECK` en la base contra nombres en blanco.                          |
| JUG-03/04 | Teléfono obligatorio, guardado en **E.164** (`+528711234567`). `CHECK` en la base con el formato E.164.                             |
| JUG-05/06 | México (+52) es el país predeterminado; se aceptan números internacionales válidos (libphonenumber-js con metadatos completos).     |
| JUG-07/24 | `UNIQUE (phone)` sobre el valor **normalizado**: "871 123 4567", "+52 871-123-4567" y "0052 8711234567" son el mismo número.        |
| JUG-08    | Apodo opcional. Nombre y apodo pueden repetirse; nunca se fusionan jugadores por nombre.                                            |
| JUG-09    | Sin correo, contraseña ni rol.                                                                                                      |
| JUG-10…16 | Política de crédito (sección 6). Las relaciones con sesiones, compras y deudas se agregarán en sus módulos.                         |
| JUG-17    | No existen campos de deuda: el schema rechaza cualquier campo financiero (400).                                                     |
| JUG-18/19 | Sin borrado físico (no hay `DELETE`; las FK del historial son `RESTRICT`). Desactivar no toca nada más.                             |
| JUG-20/21 | El teléfono obligatorio **no** implica consentimiento; el consentimiento es un historial independiente.                             |
| JUG-22    | Los tres roles registran jugadores.                                                                                                 |
| JUG-23    | `createdById`/`updatedById` en el jugador, responsable y fecha en el historial de teléfonos y de consentimiento, y en la auditoría. |
| JUG-25    | Todo endpoint exige `players:read` o superior; el historial de teléfonos completo y la auditoría del jugador exigen `audit:read`.   |

## 3. Modelo Prisma

```prisma
model Player {
  id          String   @id @default(cuid())
  name        String
  nickname    String?
  phone       String   @unique   // E.164
  countryCode String             // ISO 3166-1 alfa-2 detectado ("MX", "US"…)
  isActive    Boolean  @default(true)
  notes       String?            // texto plano interno
  createdById String?  → User
  updatedById String?  → User
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}
```

- `countryCode` guarda el país **ISO** y no el prefijo, porque un prefijo se comparte entre países (+1 es EE. UU. y Canadá). El prefijo se deriva del número.
- Índices: `phone` (único), `(isActive, name)`, `name`, `nickname` y `createdAt`.
- **No existen** `currentDebt`, `totalCredit`, `creditLimit`, `totalPurchases` ni `currentBalance`. Una prueba de integración verifica en `information_schema` que esas columnas no existan.

Migración: `20261015120000_module03_players` (aditiva).

## 4. Historial de teléfonos (`PlayerPhoneHistory`)

`id`, `playerId`, `previousPhone`, `newPhone`, `reason?`, `changedById`, `changedAt`.

- El cambio de teléfono, su registro histórico y su auditoría ocurren en **una sola transacción**.
- El número nuevo se normaliza y se verifica como único antes de guardar. Si otro jugador ya lo tiene, se responde 409 y no se escribe nada.
- La tabla es **solo inserción**: un trigger rechaza `UPDATE`/`DELETE`. Los comprobantes futuros guardarán su propio teléfono y no se reescriben.
- **Acceso restringido:** `GET /api/players/:id/phone-history` exige `audit:read` (SUPERADMIN y PARTNER). La auditoría guarda los teléfonos **enmascarados** (`+52 •••• 4567`).
- **Conservación:** los historiales de teléfono y de consentimiento se conservan mientras el jugador tenga historial operativo, porque son evidencia de operaciones y del consentimiento. Su eliminación o anonimización ante una solicitud de derechos ARCO **queda pendiente de definir con asesoría legal** (LFPDPPP). No se borra nada automáticamente.

## 5. Consentimiento WhatsApp (`PlayerNotificationConsent`)

`id`, `playerId`, `channel` (WHATSAPP), `consentType` (TRANSACTIONAL), `action` (GRANTED/REVOKED), `phone`, `noticeVersion`, `source` (IN_PERSON/ADMIN_ENTRY), `evidenceReference?`, `notes?`, `recordedById`, `recordedAt`.

- **Historial de solo inserción** (trigger). El consentimiento **vigente** se **deriva** del registro más reciente del canal (índice `playerId, channel, recordedAt`), sin una columna duplicada que pueda desincronizarse.
- **Ligado al número:** cada registro guarda el teléfono al que aplica. Si el jugador cambia de número, el consentimiento anterior **deja de estar vigente** (`staleBecausePhoneChanged`) hasta que acepte de nuevo para el número nuevo.

| Regla    | Implementación                                                                                                                                        |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| WA-01/03 | El checkbox del alta inicia **desmarcado**; el teléfono es obligatorio y WhatsApp opcional.                                                           |
| WA-02/12 | Otorgar exige `confirmedByPlayer: true`: el operador confirma que el **jugador** aceptó expresamente. En la UI el botón se habilita solo al marcarlo. |
| WA-04    | Al crear solo se registra si se envía `whatsappConsent` explícitamente; nunca automático.                                                             |
| WA-05    | Se guardan fecha, usuario y `noticeVersion`. El servidor solo acepta la versión **vigente** del aviso.                                                |
| WA-06/07 | Revocar agrega un registro `REVOKED`. No se permite otorgar si ya hay consentimiento vigente ni revocar si no lo hay.                                 |
| WA-08/09 | Los envíos futuros (Módulo 13) deberán consultar `getConsentStatus(playerId).granted`.                                                                |
| WA-10/11 | No hay envíos, número emisor ni credenciales de Meta.                                                                                                 |
| WA-13    | Aviso en `src/modules/players/consent-notice.ts` (versión `2026-10-v1`). **Borrador sujeto a revisión legal y de las políticas de Meta.**             |

La falta de consentimiento o de configuración de WhatsApp **no impide** registrar jugadores ni (en el futuro) operar con ellos. Solo impide enviar mensajes por ese canal.

## 6. Política de crédito ilimitado

Definida en `src/config/credit-policy.ts` y en la regla operativa `NO_CREDIT_LIMIT` (Configuración → Reglas operativas):

- **CRED-01/02:** sin límite por jugador ni global (`individualLimit: null`, `globalLimit: null`). No hay campos de límite en el jugador ni en el formulario.
- **CRED-03…06:** SUPERADMIN, PARTNER y CASHIER otorgan crédito sin autorización adicional.
- **CRED-07/08:** cada compra a crédito irá ligada a un jugador y llevará firma.
- **CRED-09…12:** lo no pagado genera deuda, que persiste entre sesiones y se compensa por FIFO. Nunca se oculta ni se edita a mano, y desactivar a un jugador no cancela sus deudas.
- **CRED-13:** lo pendiente es una cuenta por cobrar, no dinero en caja.
- **CRED-14:** crédito ilimitado no significa sin auditoría.

Solo se documenta y se prepara: no existen `PlayerDebt` ni movimientos.

## 7. Permisos

| Permiso           | SUPERADMIN | PARTNER | CASHIER | Uso                                                                     |
| ----------------- | :--------: | :-----: | :-----: | ----------------------------------------------------------------------- |
| `players:read`    |     ✅     |   ✅    |   ✅    | Directorio, perfil (incluye teléfono y notas), estado de consentimiento |
| `players:create`  |     ✅     |   ✅    |   ✅    | Alta                                                                    |
| `players:update`  |     ✅     |   ✅    |   ✅    | Nombre, apodo, teléfono, notas                                          |
| `players:manage`  |     ✅     |   ✅    |   ✅    | Activar/desactivar                                                      |
| `players:consent` |     ✅     |   ✅    |   ✅    | Registrar/revocar consentimiento                                        |
| `audit:read`      |     ✅     |   ✅    |    —    | Historial de teléfonos completo y auditoría del jugador                 |

Decisión: el cajero edita los datos del jugador (nombre, apodo, contacto y notas) porque no hay campos financieros que proteger. Los datos personales históricos (números anteriores y auditoría) quedan reservados a quien consulta la auditoría. Todo se valida en el servidor con la matriz central y cada 403 se audita.

## 8. Endpoints

| Método | Ruta                                    | Permiso           | Notas                                                                                                              |
| ------ | --------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| GET    | `/api/players`                          | `players:read`    | `q` (nombre/apodo/teléfono), `status`, `sort` (name/createdAt/updatedAt), `order`, `page`, `pageSize` ≤ 50         |
| POST   | `/api/players`                          | `players:create`  | 201; 409 si el teléfono existe (con `existingPlayer {id, name}`). `whatsappConsent` exige además `players:consent` |
| GET    | `/api/players/:id`                      | `players:read`    |                                                                                                                    |
| PATCH  | `/api/players/:id`                      | `players:update`  | Nombre, apodo, teléfono (+ motivo), notas. Estado/consentimiento → 400                                             |
| PATCH  | `/api/players/:id/status`               | `players:manage`  | `{ isActive, reason? }`                                                                                            |
| GET    | `/api/players/:id/phone-history`        | `audit:read`      | Números completos                                                                                                  |
| GET    | `/api/players/:id/notification-consent` | `players:read`    | Estado vigente, historial (teléfono enmascarado) y aviso vigente                                                   |
| POST   | `/api/players/:id/notification-consent` | `players:consent` | `GRANTED` (con `confirmedByPlayer`, versión vigente) o `REVOKED`                                                   |
| GET    | `/api/players/:id/audit`                | `audit:read`      | Solo eventos del jugador, sanitizados                                                                              |

No se creó `/api/players/search`: `GET /api/players` ya busca en servidor y pagina. No hay `DELETE`.

**Auditoría:** `PLAYER_CREATED`, `PLAYER_UPDATED` (cambios de nombre/apodo; para notas solo registra `notesChanged`), `PLAYER_STATUS_CHANGED`, `PLAYER_PHONE_CHANGED`, `PLAYER_WHATSAPP_CONSENT_GRANTED` y `PLAYER_WHATSAPP_CONSENT_REVOKED`. Cada evento lleva actor, jugador, fecha, `requestId` y resultado, con teléfonos enmascarados y dentro de la misma transacción que el cambio.

## 9. Pantallas (Mobile First)

| Ruta                               | Contenido                                                                                                                                                                                                                                            |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/dashboard/jugadores`             | Directorio en tarjetas, búsqueda (nombre/apodo/teléfono), filtro de estado, orden, paginación de 20 en 20, estado vacío, skeleton (`loading.tsx`) y error (`error.tsx`)                                                                              |
| `/dashboard/jugadores/nuevo`       | Nombre, apodo, país (México por defecto), teléfono con vista previa normalizada, observaciones y consentimiento opcional desmarcado (muestra el aviso al marcarlo)                                                                                   |
| `/dashboard/jugadores/[id]`        | Datos, teléfono con `tel:`, estado (activar/desactivar con confirmación), consentimiento (aceptar/revocar), aviso de crédito sin límite y secciones de historial **informativas** (sin montos). Con `audit:read`: historial de teléfonos y auditoría |
| `/dashboard/jugadores/[id]/editar` | Nombre, apodo, teléfono (+ motivo si cambia), observaciones. Estado y consentimiento van en el perfil                                                                                                                                                |

Atajo: `/jugadores/*` redirige a `/dashboard/jugadores/*`, siguiendo la misma convención que `/configuracion`.

## 10. Validaciones

- **Teléfono** (`src/lib/phone.ts`): libphonenumber-js `max`. Convierte "00" a "+", respeta un prefijo ya escrito (nunca antepone +52 a ciegas) y descarta el antiguo "1" de celulares mexicanos. Se valida en el cliente (UX) y se **vuelve a normalizar en el servidor**.
- **Duplicados:** se verifica antes de crear dentro de la transacción, la restricción `UNIQUE` actúa como garantía y la violación concurrente (P2002) también se traduce a 409. Probado con 6 altas simultáneas: un 201 y cinco 409. El botón se desactiva mientras envía.
- **Notas:** texto plano de hasta 1000 caracteres, sin caracteres de control. Se muestran escapadas por React (nunca como HTML) y no se registran en la auditoría.
- **Schemas `strictObject`:** cualquier campo de crédito, deuda, estado o fechas se rechaza con 400.

## 11. Pruebas

- **Unitarias** (`src/lib/phone.test.ts`, `src/modules/players/player.schemas.test.ts`, matriz de permisos): los 16 casos pedidos (nombre, teléfono MX e internacional, inválido, E.164, +52 no duplicado, apodo opcional, consentimiento desmarcado y revocación, activo por defecto, inactivo no seleccionable, crédito sin límite y permisos).
- **Integración** (`tests/integration/players.int.test.ts`, Postgres real): los 17 casos pedidos, incluidos la unicidad en base de datos, el historial telefónico, la auditoría con responsable, la paginación, la búsqueda por teléfono y la creación simultánea.
- **E2E** (`tests/e2e/players.spec.ts`, Chrome + iPhone 14 táctil, teclado simulado con `pressSequentially`): directorio, alta con validación, búsqueda, perfil, edición de apodo y teléfono, duplicado, estado, consentimiento, privacidad del cajero y ausencia de scroll horizontal.
- Las pruebas usan teléfonos **sintéticos** (+52 871 000 xxxx o aleatorios) solo en la base de pruebas. No hay jugadores en los seeds.

## 12. Integraciones futuras

- **Sesiones/compras:** usar `assertPlayerSelectable(player)` (`src/modules/players/player.rules.ts`) para impedir operar con jugadores inactivos. Los cobros de deudas pendientes **no** usan esa verificación.
- **Deudas:** se calcularán desde operaciones confirmadas; nunca como campo del jugador.
- **WhatsApp (Módulo 13):** consultar `getConsentStatus(playerId).granted` antes de cada envío, y no enviar nunca las notas.
- **Comprobantes:** guardar su propia copia del teléfono y del nombre; los cambios posteriores del perfil no los reescriben.

## 13. Casos especiales

- **Número reciclado:** un número que dejó de usar un jugador puede registrarlo otro. El historial conserva a quién perteneció.
- **Jugador que cambia de número con consentimiento vigente:** el consentimiento queda no vigente y el perfil lo indica.
- **Dos personas que comparten teléfono:** no es posible (único). Se registra solo a una.
- **Formato validado ≠ titularidad:** el sistema no verifica por SMS que el número pertenezca al jugador.
- **Jugador inactivo con deuda:** sigue en el directorio y sus deudas seguirán vigentes cuando exista ese módulo.

## 14. Instrucciones de uso

1. **Jugadores → Nuevo jugador.** Captura el nombre y el teléfono a 10 dígitos (México ya está elegido); para un número extranjero elige el país o escribe `+código`. Revisa la vista previa "Se guardará como…".
2. Marca el consentimiento de WhatsApp **solo** si el jugador aceptó tras leer o escuchar el aviso.
3. Si el teléfono ya existe, usa el enlace "Ver jugador existente".
4. En el perfil: **Editar** para cambiar datos o teléfono, **Desactivar/Activar** para el estado, y **Registrar aceptación/Revocar** para WhatsApp.
5. SUPERADMIN y PARTNER ven además el historial de teléfonos y la auditoría del jugador.
