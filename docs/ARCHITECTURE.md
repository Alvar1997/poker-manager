# Arquitectura — Poker Manager

## Versiones (verificadas en npm registry al construir el Módulo 00)

| Paquete                                      | Versión              | Nota                                                          |
| -------------------------------------------- | -------------------- | ------------------------------------------------------------- |
| Next.js                                      | 16.4.0               | App Router, Turbopack                                         |
| React / React DOM                            | 19.3.0               |                                                               |
| TypeScript                                   | 5.x (`strict: true`) |                                                               |
| Tailwind CSS                                 | 4.x                  | config CSS-first, sin `tailwind.config.js`                    |
| shadcn/ui (CLI)                              | 4.21.4               | estilo `base-nova`, sobre `@base-ui/react` (no Radix)         |
| Prisma + @prisma/client + @prisma/adapter-pg | 7.10.0               | estable — se descartó `8.0.0-rc.22` por ser release candidate |
| next-auth (Auth.js)                          | 5.0.0-beta.32        | ver nota abajo                                                |
| @tanstack/react-query                        | 5.104.2              |                                                               |
| Zod                                          | 4.6.7                |                                                               |
| react-hook-form / @hookform/resolvers        | 7.90.0 / 5.9.1       |                                                               |
| date-fns                                     | 4.4.0                |                                                               |
| bcryptjs                                     | 3.0.3                | puro JS, sin bindings nativos                                 |
| pino                                         | 10.4.0               | logger estructurado                                           |
| Vitest / @testing-library/react              | 5.0.4 / 16.3.3       |                                                               |
| Playwright                                   | 1.64.0               |                                                               |

### Por qué Auth.js v5 (beta) y no v4

`next-auth@4` (última estable, 4.24.15) es la rama **Pages Router**; no tiene soporte real de Route Handlers de App Router. `next-auth@5` lleva ~2 años en beta pero es la línea diseñada para App Router y es la que recomienda la documentación oficial para este caso. Se usa deliberadamente, documentado aquí para que quede claro que no es un descuido.

### Por qué Prisma 7 cambió `schema.prisma`

En Prisma 7, `datasource.url`/`directUrl` **ya no se declaran en `schema.prisma`** (el motor de migraciones lo rechaza con `P1012`). La URL de runtime se pasa como `adapter` al construir `PrismaClient` (ver `src/lib/prisma.ts`, usa `DATABASE_URL` pooled); la URL para Migrate/Studio se configura en `prisma.config.ts` → `datasource.url` (usa `DIRECT_URL`, sin pooling — Neon lo requiere para DDL). Son dos mecanismos independientes.

### Por qué el cliente Prisma es perezoso (`src/lib/prisma.ts`)

Mientras no exista una base de Neon real, `next build` no debe fallar por falta de credenciales. `src/lib/prisma.ts` expone un `Proxy` que solo construye el `PrismaClient` real (y solo entonces valida `DATABASE_URL`) en el primer acceso a una propiedad — no al importar el módulo. Así:

- El build compila y tipa sin DB.
- `/api/health/ready` sí falla de verdad (503) si la DB no responde — no hay una ruta "falsa" de éxito.

### Por qué `src/lib/auth.ts` está partido en dos archivos

`src/proxy.ts` (el middleware/proxy de Next, protege `/dashboard`) corre en **Edge Runtime**. El cliente de Prisma generado y `bcryptjs` usan APIs de Node (`node:path`, etc.) que Edge Runtime no soporta — intentarlo rompe el build (`A Node.js module is loaded… not supported in the Edge Runtime`). Por eso:

- `src/lib/auth.config.ts`: la parte _edge-safe_ de la config de Auth.js (sesión JWT, páginas, callbacks) — **sin** el provider de Credentials.
- `src/lib/auth.ts`: la config completa, con el provider de Credentials (que sí usa Prisma + bcryptjs) — se usa solo en Route Handlers/Server Components (Node runtime).
- `src/proxy.ts` construye su propia instancia ligera de `auth()` a partir de `auth.config.ts`, sin tocar Prisma.

### Por qué `cacheComponents`/`partialPrefetching` están desactivados

`next.config.ts` generado por `create-next-app` 16 los activa por defecto. Son incompatibles con `export const dynamic = "force-dynamic"` en Route Handlers (como los health checks) y, en general, exigen anotar explícitamente qué se cachea. Esta aplicación es dinámica por naturaleza (auth, caja en tiempo real) — se desactivaron para mantener el modelo de renderizado simple, como pide el alcance del Módulo 00.

### Por qué no hay modelos `Account`/`Session`/`VerificationToken`

Auth.js con `Credentials` provider no es compatible con el adaptador de base de datos (la verificación de credenciales es responsabilidad de `authorize`, y Auth.js solo soporta sesión JWT en ese caso). No hacían falta esos modelos para el Módulo 00.

~~Limitación del Módulo 00: la desactivación solo surtía efecto al expirar el JWT.~~ **Resuelto en el Módulo 01:** cada request valida al usuario contra la base (`isActive` + `sessionVersion`), así que desactivar, cambiar el rol o cambiar/restablecer la contraseña invalida las sesiones existentes de inmediato. Ver `docs/AUTHENTICATION.md`.

### Por qué el `form` de shadcn se escribió a mano (`src/components/ui/form.tsx`)

El registry de shadcn para el estilo `base-nova` (el que usa este proyecto, sobre `@base-ui/react`) tiene el componente `form` como un _stub_ vacío — todavía no publican su implementación para ese estilo. Se escribió un equivalente basado en React Hook Form que evita la dependencia de `@radix-ui/react-slot` (no instalada en este proyecto): `FormControl` clona su hijo con `React.cloneElement` en vez de usar `<Slot>`.

### Por qué los botones usan `render` y no `asChild`

Los componentes de este proyecto están construidos sobre `@base-ui/react`, que usa la prop `render` (no `asChild`, que es la convención de Radix) para renderizado polimórfico. Ejemplo: `<Button render={<Link href="/">Texto</Link>} />`.

## Capas del backend

```
Route Handler  →  Autenticación/Autorización  →  Validación (Zod)  →  Servicio  →  Prisma
   route.ts        src/config/permissions.ts       src/lib/validation.ts  src/modules/*/*.service.ts
```

**Cambio en el Módulo 01:** la autorización va **antes** de la validación del body. Así un usuario sin sesión siempre recibe 401 (y uno sin permiso 403) sin importar lo que envíe, y no se revela la forma del contrato a quien no puede usarlo. Si un campo del body exige un permiso adicional (p. ej. `role` → `roles:manage`), se verifica justo después de validar.

- `src/lib/api-handler.ts`: envuelve cada Route Handler — genera `requestId`, loguea, captura errores y los traduce al formato de respuesta estándar.
- `src/lib/errors.ts`: `AppError` y subclases (`ValidationError`, `UnauthorizedError`, `ForbiddenError`, `NotFoundError`, `ConflictError`, `BusinessRuleError`) — cada una mapea a un código HTTP fijo.
- `src/lib/api-response.ts`: formato `{ success, data, message, requestId }` / `{ success: false, error: { code, message, details }, requestId }`.
- `src/config/permission-matrix.ts`: **única fuente de verdad** de roles → permisos (capacidades). Puro, lo usan servidor y navegación.
- `src/config/permissions.ts`: `getCurrentUser` (valida el JWT contra la base: usuario activo + `sessionVersion`), `requireUser`, `requirePermission`, `requirePagePermission`, `can`. Reemplaza a `requireRole`/`hasRole` del Módulo 00 (autorización por capacidad, no por rol). Ver `docs/ROLES_AND_PERMISSIONS.md` y `docs/AUTHENTICATION.md`.
- `src/lib/api-handler.ts`: además rechaza con 403 las mutaciones de otro origen (`assertSameOrigin`, defensa CSRF).
- `src/modules/audit/audit.service.ts`: `recordAudit` (dentro de transacciones) y `recordAuditSafe` (eventos que no deben bloquear la respuesta).

## Flujo de una request autenticada típica

1. El navegador llama a un Route Handler bajo `src/app/api/**`.
2. `withApiHandler` genera un `requestId` y arranca el log de la request.
3. El handler llama a `requirePermission(PERMISSIONS.X, { requestId })` (o `requireUser()`) — lanza `UnauthorizedError`/`ForbiddenError` si no corresponde; los 403 se auditan.
4. El handler valida el body/query con Zod (`parseJsonBody`/`parseQueryParams`); los schemas de entrada son `strictObject` (campos no previstos → 400).
5. El handler delega en un servicio de `src/modules/<dominio>/` (`users`, `auth`, `audit` desde el Módulo 01).
6. El servicio usa `prisma` (`src/lib/prisma.ts`) — en una `$transaction` si mueve dinero o fichas.
7. La respuesta se devuelve con `ok()`/`fail()`, con el mismo `requestId` en los logs y en la respuesta HTTP.

## Estructura de carpetas

Ver el árbol propuesto en el encargo original — se siguió sin cambios salvo los ya documentados arriba. Los directorios de módulos de negocio (`src/modules/sessions`, `tables`, `players`, `chips`, `cash`, `purchases`, `debts`, `settlements`, `notifications`, `reports`, `audit`) no se crearon vacíos — se documentan en `docs/MODULES.md` y se crean cuando se implementen.

## Decisiones del Módulo 01

- **Sin dependencias nuevas.** Se agregaron los componentes shadcn `dropdown-menu` y `alert-dialog` (código copiado al repo, sobre `@base-ui/react` ya instalado).
- **Modelo nuevo `LoginThrottle`** (justificación): el limitador de intentos debe compartirse entre instancias serverless; la memoria del proceso no sirve. No se crearon modelos de sesión (JWT) ni de tokens de recuperación (no hay recuperación por correo todavía).
- **`sessionVersion` en `User`** en vez de una tabla de sesiones: con JWT basta un contador para revocar todas las sesiones de un usuario, sin duplicar lo que Auth.js ya maneja.
- **Permisos derivados del rol**, no almacenados por usuario.
- **Credenciales temporales generadas por el servidor** y mostradas una sola vez (no se envían por correo).
- **Trigger de inmutabilidad en `audit_logs`** (en la migración): la auditoría no se puede alterar ni borrar ni por un bug.
- **`forbidden()` de Next no se usa**: sigue siendo experimental en 16.4 (`authInterrupts`); se redirige a `/dashboard/access-denied`.
- **Pruebas de integración contra Postgres real** (`prisma dev`, sin Docker) con salvaguarda que impide apuntar a una base remota.
- **Proxy en Node**: en Next 16 `proxy.ts` corre en Node.js; se mantiene ligero de todas formas (sin Prisma).

## Decisiones del Módulo 02

- **Rutas en español bajo `/dashboard`**: `/dashboard/configuracion/*` conserva la protección del proxy y el layout del Módulo 01. `/configuracion/*` redirige allí (`next.config.ts`).
- **Montos como string en la API, `Decimal` en la base** (`src/lib/money.ts`): ningún `number` de JS toca dinero. `positiveMoneySchema` es puro (sirve en cliente y servidor).
- **Singletons con `CHECK (id = 1)`** y caja única con `CHECK (code = 'MAIN')`: la unicidad la garantiza la base, no solo el código.
- **Reglas fijas como constantes tipadas** (`src/config/operational-rules.ts`), no como columnas editables. Solo las políticas de efectivo se persisten (`enum` de un valor). No hay motor genérico de reglas.
- **Cifrado de datos bancarios** con AES-256-GCM (`src/lib/crypto.ts`) y clave en `SETTINGS_ENCRYPTION_KEY`, con últimos 4 dígitos en claro para enmascarar. Sin la clave se puede usar todo el sistema, pero no capturar números.
- **Folios con `UPDATE … RETURNING`**: atómico sin locks explícitos; la edición del formato usa `updateMany` condicionado a `lastIssuedAt IS NULL`.
- **Permisos nuevos `settings:read` y `catalogs:read`** en la misma matriz del Módulo 01; secciones de configuración filtradas por capacidad (`src/config/settings-sections.ts`).
- **Enlaces con estilo de botón**: `<Link className={buttonVariants()}>`, no `<Button render={<Link/>}>`. Con `nativeButton={false}`, Base UI agrega `role="button"` y el enlace deja de anunciarse como enlace.
- **Sin dependencias nuevas.**

## Decisiones del Módulo 03

- **Dependencia nueva justificada: `libphonenumber-js` 1.13.14** (MIT, sin dependencias). Validar teléfonos internacionales con expresiones regulares no es confiable; se usan sus metadatos completos (`/max`) para validar estructura y longitud por país. Se fijó la versión más reciente con al menos dos semanas publicada (1.13.15 tenía 5 días).
- **E.164 como clave de unicidad** (`UNIQUE` + `CHECK` de formato en la base) y normalización en servidor siempre (`src/lib/phone.ts`, puro: también lo usa el formulario).
- **Consentimiento derivado, no proyectado**: el vigente se calcula del último registro del historial (índice compuesto). Así no hay columnas duplicadas que puedan desincronizarse. Queda ligado al número para el que se otorgó.
- **Historiales de solo inserción** (teléfonos y consentimiento) con trigger, como `audit_logs`.
- **Transacciones de jugadores con `maxWait` 10 s / `timeout` 15 s**: el predeterminado de Prisma (2 s) es corto ante el arranque en frío de Neon y ante altas simultáneas, que deben responder 409 y no agotar el tiempo.
- **Opciones de país calculadas en el servidor** y pasadas al formulario: `Intl.DisplayNames` puede diferir entre Node y el navegador y romper la hidratación.
- **Directorio con búsqueda y paginación en servidor** (formulario GET, estado en la URL), con `loading.tsx` (skeleton) y `error.tsx`.

## Decisiones del Módulo 04

- **Libro + proyección:** el libro de movimientos (inmutable) es la fuente auditable. `chip_inventory_balances` es una proyección actualizada en la misma transacción, porque recalcular el libro en cada lectura sería costoso. Las pruebas reconstruyen los saldos desde el libro.
- **Concurrencia por bloqueo pesimista del inventario** (`SELECT … FOR UPDATE` sobre `chip_set_inventory_states`), más simple y robusto que el control optimista con reintentos. Desde la corrección de inventario compartido hay un solo inventario activo, así que las operaciones de las dos mesas se serializan entre sí: nunca entregan las mismas fichas disponibles. La base respalda con `CHECK` y FK compuestas.
- **FK compuestas `(chipSetId, id)`** en denominaciones, ubicaciones, operaciones, arqueos y reservas: una existencia o movimiento no puede mezclar denominaciones de otro juego (p. ej. de los juegos históricos inactivos).
- **Idempotencia por operación:** clave única + huella del contenido; el reintento se detecta tras el bloqueo.
- **Motor de arqueos único** para inicial, control, apertura y cierre; los servicios exponen variantes `…InTx` para que compras, sesiones y liquidaciones compongan transacciones sin duplicar movimientos.
- **Sin endpoints de reservas**: son infraestructura interna hasta que exista el módulo de compras.
- **Pruebas de integración en PostgreSQL 16 real (Docker)**: PGlite no soporta varias sesiones simultáneas (error `08P01`) y no prueba bloqueos.
- **E2E y router de Next 16:** al navegar del lado cliente, Next puede conservar copias ocultas de rutas en el DOM; los localizadores E2E se limitan a elementos visibles. Además, la URL cambia antes que el contenido, así que las pruebas esperan el contenido y no `networkidle`.

## Decisiones del Módulo 05

- **Partida doble con cuentas técnicas** (`FinancialAccount`): cada movimiento tiene partidas que cuadran (débitos = créditos), verificado en código y por un trigger diferido al `COMMIT`. Así una compra mixta, un traslado o una liquidación se registran una vez, sin «doble suma» entre efectivo y banco. Las cuentas que no son dinero (aportaciones, retiros, cobros…) solo explican el origen o destino.
- **Efectivo por sesión, banco global**: la proyección `financial_account_balances` usa `scopeKey` (id de sesión para efectivo, `GLOBAL` para el resto). Una sesión nueva no tiene fila: su efectivo es $0.00 por construcción, sin fondo ni arrastre.
- **Bloqueo pesimista ordenado** de las proyecciones afectadas (`SELECT … FOR UPDATE` en orden determinista), igual que el inventario: dos retiros simultáneos se serializan y el segundo ve el saldo ya descontado. CHECK `nonNegative` como respaldo. La fila de saldo se crea con `INSERT … ON CONFLICT DO NOTHING` **sin destino**: con creaciones simultáneas el choque puede detectarse en la llave primaria y no en `(accountId, scopeKey)`; se encontró con una prueba de estrés y hay prueba de regresión.
- **`SessionGateway`** en vez de un modelo de sesión provisional: la caja no inventa sesiones. Hasta el Módulo 06 la implementación responde que no hay sesión, así que la API de efectivo devuelve 422; las pruebas inyectan un adaptador.
- **Transferencias como verificación separada** (`BankTransferVerification`): pendiente sin asiento; confirmar crea el asiento una vez (bloqueo + transición condicional + `UNIQUE transactionId`).
- **Sin gastos por diseño**: catálogo cerrado de tipos y destinos (enums de la base); la heurística de palabras es solo una defensa complementaria.
- **Contratos `…InTx`** para compras, abonos, liquidaciones y cierre: los módulos de origen los llaman dentro de su propia transacción, con índices únicos por operación de origen.

## Corrección: inventario de fichas compartido (previa al Módulo 06)

- **Se conservó `ChipSet`** (compatibilidad y futuras ampliaciones) en lugar de eliminarlo: hay un solo juego activo, `CHIPSET_MAIN`, garantizado por el índice único parcial `chip_sets_single_active ON chip_sets ((true)) WHERE "isActive"`. Así no cambian las FK compuestas ni el motor del Módulo 04, y el stock pasa a ser global por denominación.
- **Mesa como trazabilidad, no como dimensión de stock:** `tableId`/`sessionId`/`playerId` opcionales en operaciones, movimientos y reservas. Filtrar por mesa nunca parte existencias.
- **Migración con guarda:** consolidar inventarios reales con fichas posiblemente contadas dos veces no es automatizable; la migración aborta si existieran y deja la conciliación como tarea física.

## Corrección: inventario por valor nominal (compras por importe)

- **Dos libros:** la composición física por denominación (`chip_inventory_balances` y `chip_inventory_movements`), que fijan los arqueos y las operaciones con desglose; y el **saldo nominal** (`chip_set_inventory_states.custodyNominal/reservedNominal/circulationNominal` más el libro inmutable `chip_nominal_movements`), que es la fuente de verdad para disponibilidad. Las entregas y devoluciones por importe solo mueven el saldo nominal y marcan la composición como no exacta (`breakdownExact = false`) hasta el siguiente arqueo; nunca se inventa un desglose.
- **Arqueo:** el esperado es el valor nominal bajo custodia. Si el valor cuadra y la composición no era exacta, se actualiza la composición (`COMPOSITION_UPDATE`, sin cambio nominal). Si no cuadra, se concilia una sola vez (ajuste nominal más composición). La vigencia es explícita: `resultingInventoryVersion`.

## Decisiones del Módulo 06

- **Sesión única vigente en PostgreSQL** (`poker_sessions_single_active ON ((true)) WHERE status IN (…)`) en vez de comprobar antes de insertar: funciona entre instancias serverless.
- **Transiciones centralizadas** (`transitionInTx`: bloqueo, actualización condicional e historial) y un trigger que vuelve a validar transiciones y campos inmutables.
- **Checklist derivado, nunca almacenado:** `computeOpeningChecklist` lee los arqueos, versiones, circulación y libro de caja reales. La apertura lo recalcula dentro de la transacción con la sesión, el inventario y el efectivo bloqueados.
- **Regla del creador como servicio compartido** (`assertPreparationAccess`), invocado también por los motores de arqueo de los Módulos 04 y 05 para que no haya atajos.
- La caja deja el adaptador «sin sesiones» y usa `prismaSessionGateway` (lee `poker_sessions`).

## Decisiones del Módulo 07

- **Ciclos como registros nuevos** (no se reabre un ciclo): el historial es inmutable por trigger y la fotografía de ciegas vive en el ciclo.
- **Índices parciales** para un ciclo OPEN por mesa y una participación ACTIVE por jugador y sesión. FK compuestas `(id, sessionId)` y `(id, sessionTableId)` contra referencias cruzadas.
- **Bloqueos:** sesión `FOR SHARE` (no transiciona a la mitad) y mesa `FOR UPDATE` (cerrar y agregar se serializan); las transferencias bloquean ambas mesas en orden fijo. La idempotencia se revisa después del bloqueo, así que los reintentos simultáneos con la misma clave devuelven el mismo resultado.
- **Salida definitiva desacoplada:** `completeParticipationFromSettlementInTx` y `markParticipationSettlingInTx` reciben un `SettlementVerifier`. El de por defecto rechaza; el Módulo 11 pasa el real (`settlementVerifier`). No existe endpoint para marcar SETTLING/SETTLED.

## Decisiones del Módulo 08

- **Compras por importe sobre el saldo nominal** (`src/modules/purchases/`): ningún modelo ni schema de compras admite denominaciones. La entrega usa `reserveNominalAmountInTx` → `confirmNominalChipDeliveryInTx` dentro de la transacción de la compra.
- **Pagos como componentes** (`PurchasePayment`) en vez de reutilizar `recordPlayerPaymentInTx`: permite varios componentes, estados de terminal y una referencia por componente (`cash_transactions_one_per_origin`, `bank_transfers_one_live_per_origin`). Efectivo y tarjeta se contabilizan **al confirmar la entrega** para que compra, salida de fichas, asientos, deuda y numeración sean una sola transacción; la transferencia vive en el Módulo 05 desde que se declara (verificación manual independiente).
- **Terminal**: cuenta de tránsito `CARD_TERMINAL_CLEARING` (no es efectivo ni banco liquidado) y `CardTerminalSettlement` para el depósito (banco + / tránsito −, sin tocar `PLAYER_PURCHASES`). La diferencia por comisiones queda pendiente de conciliar; no se inventan porcentajes ni gastos.
- **Saldos derivados** (`purchase.math.ts`, puro y probado): pagos confirmados, pendientes, saldo por cobrar, sobreaplicación y bloqueos se calculan desde los registros; no se guardan estados derivados editables. `PlayerDebt` es inmutable y su saldo se deriva.
- **Versionado del resumen** (`ChipPurchase.version` + `summaryHash`): toda alteración material incrementa la versión, reemplaza la autorización y deja sin validez la firma; la confirmación exige la versión revisada (concurrencia optimista sobre lo que vio el cajero).
- **Contrato de firmas** (`signature-gateway.ts`): registro de un verificador, como el `SessionGateway` del Módulo 05; el predeterminado no encuentra firmas, de modo que el crédito queda bloqueado sin simular nada. La base respalda la regla (CHECK `purchase_deliveries_credit_requires_signature`).
- **Integración con transferencias** por import dinámico (`purchase-transfer-hook.ts`) para evitar el ciclo caja ↔ compras; bloquea la compra antes que la transferencia (mismo orden que la cancelación de pagos).
- **Outbox** (`NotificationOutbox`) genérico y deduplicado por `dedupeKey`: la notificación es un efecto externo y nunca forma parte de la transacción PostgreSQL.
- **Orden de bloqueos** documentado y pre-bloqueo de cuentas (`lockAccountsInTx`) para evitar interbloqueos entre entregas, verificaciones de transferencias y depósitos de terminal.

## Decisiones del Módulo 09

- **Trazos en vez de imagen**: el cliente envía coordenadas enteras normalizadas; el servidor valida (no vacía, no trivial) y genera un PNG determinista sin metadatos con `node:zlib` (sin bibliotecas). Así no existe un camino para subir una imagen arbitraria como firma.
- **Almacenamiento privado con adaptador** (`evidence-storage.ts`): no había infraestructura ni credenciales de objetos, y el disco de una instancia serverless no es persistente. El driver por defecto usa PostgreSQL (`evidence_blobs`, tabla aparte, nunca en `chip_purchases`). Flujo PENDING → transacción → ACTIVE / ORPHANED + limpieza, válido también para un driver externo futuro.
- **Snapshot con doble huella canónica** (`src/lib/canonical-json.ts`): `contentHash` detecta cambios materiales y `payloadHash` protege lo mostrado; ambos se recalculan desde columnas para detectar manipulación.
- **Verificador registrado por defecto con import diferido** (`moduleSignatureVerifier`): evita el ciclo compras ↔ firmas; la invalidación vive en un módulo sin dependencias de compras (`signature-invalidation.ts`).
- **Comprobante dentro de la transacción de entrega** y PNG con `next/og` (incluido en Next) a partir del snapshot, compartiendo `receiptLines` con la pantalla: lo que se ve y lo que se descarga es lo mismo. Sin PDF.

## Decisiones del Módulo 10

- **Sin modelos duplicados**: `PlayerDebt` (Módulo 08) es la cuenta por cobrar; el dinero sigue en el libro del Módulo 05. Lo nuevo es el libro de **aplicaciones** (`payment_allocations`), del que se deriva todo saldo.
- **Motor FIFO único** (`allocateFifoInTx`, cálculo puro en `credit.math.ts`) para abonos y para las compensaciones del Módulo 11 (solo cuando el cajero decide compensar).
- **Serialización por jugador** (`SELECT … FOR UPDATE` del jugador) + trigger de sobreaplicación en la base: dos rutas concurrentes nunca aplican de más.
- **Custodia administrativa como alcance del libro** (`ADMIN_CASH_CUSTODY` con `scopeKey = custodian:<id>`): un libro de entradas/salidas sin saldo editable, separado de la caja de sesión.
- **Verificación de transferencias en dos pasos** dentro del Módulo 05 (`plan` antes del asiento, `finalize` después): permite acreditar el excedente real a `UNAPPLIED_PLAYER_FUNDS` en el mismo asiento, sin saldos a favor.
- **Comprobantes** con el mismo generador PNG del Módulo 09 (`renderDocumentPng`).

## Decisiones de UI/Mobile

- `next-themes` para claro/oscuro (clase `.dark` en `<html>`, respeta `prefers-color-scheme` por defecto).
- Safe-area insets (`env(safe-area-inset-*)`) aplicados en `globals.css` para notch/gestos de iOS/Android.
- Área táctil mínima recomendada (44px) para acciones primarias en móvil: usar `size="lg"` (h-9) o superior en `<Button>` para CTAs principales; los tamaños `xs`/`sm`/`icon-*` son para UI densa de escritorio/tablas.
- Desde el Módulo 01, inputs y botones de formularios usan `h-11 md:h-9` (44px en celular), los selects son nativos (`NativeSelect`, abren el selector del sistema) y los listados usan tarjetas en vez de tablas.
- Navegación: barra lateral en `md+`; en celular, menú a pantalla completa desde el header.

## Decisiones del Módulo 11

- **Liquidación como documento con versión**: borrador sin efectos → resumen preparado por el servidor (snapshot canónico con `materialHash`) → firma → recepción. La recepción RECALCULA el plan con el jugador bloqueado y lo compara con la parte material firmada; cualquier diferencia exige una firma nueva (versión + invalidación con evidencia conservada).
- **Firmas de liquidación en tablas propias** (`settlement_signature_snapshots`, `settlement_signatures`) reutilizando la infraestructura del Módulo 09 (trazos → PNG, `evidence-storage`, huella canónica): las tablas de firmas de compras quedan intactas y una firma de compra nunca sirve para una liquidación.
- **Compensación opcional** como decisión explícita (`NO_COMPENSATE`/`PARTIAL`/`MAXIMUM`) almacenada siempre; FIFO solo si hay compensación, con el mismo motor del Módulo 10.
- **Cuenta por pagar separada de la cuenta por cobrar** (`SettlementPayable` vs `PlayerDebt`); el pendiente se deriva de los desembolsos EXECUTED y las transferencias PENDING solo reservan.
- **Origen del efectivo decidido por el servidor**: caja de la sesión de origen mientras esté OPEN/CLOSING; después, custodia administrativa del pagador (fondeable con aportaciones documentadas). Nunca cajas cerradas ni otra sesión.
- **Contrato de caja por desembolso** (`recordSettlementPayoutInTx`, un asiento por `SettlementPayout`): reemplaza al contrato anterior de «un pago neto por liquidación», que no admitía pagos parciales ni transferencias.
- **SETTLING** como estado de participación sin silla: permite cerrar mesas y sesiones con obligaciones registradas sin inventar pagos.

## Decisiones del Módulo 12

- **Cierre como intentos auditados** (`SessionClosure`): cada `OPEN → CLOSING` crea un intento; el regreso `CLOSING → OPEN` lo deja `RETURNED_TO_OPEN` (con sus prevalidaciones, arqueos y discrepancias como evidencia) y el siguiente cierre empieza de cero. Nunca se reabre una sesión CLOSED.
- **Sin duplicar fuentes de verdad**: el arqueo final es un `ChipStockCount` CLOSING del Módulo 04 (confirmado solo vía cierre con `confirmStockCountInTx`), el de efectivo un `CashReconciliation` CLOSING del Módulo 05 (`recordClosingCashCountInTx`), el retiro `withdrawAllCashForClosingInTx`, los ajustes `reconcileStockCountInTx`/`adjustCashReconciliationInTx`. El cierre solo agrega proceso, evidencia, autorizaciones y comprobante.
- **Tres cifras de fichas separadas** (lógica pura `closure.math.ts`): diferencia física (bloquea), neto no retornado de la sesión y circulación global (libro nominal, continua). La circulación nunca es ingreso ni obligación; la apertura (Módulo 06) dejó de bloquearse por ella.
- **`SUPERSEDED`** en los estados de diferencia: un recuento o el regreso a OPEN sustituye la diferencia pendiente sin ajustar ni borrar el arqueo original.
- **Huella del resumen** (`buildClosurePreview` → `previewHash` canónico): la confirmación la recalcula bajo bloqueo de sesión, inventario y caja; cualquier movimiento relevante posterior invalida la aprobación (409).
- **Permiso nuevo `sessions:close-authorize`** (PARTNER, SUPERADMIN) para la transición final y los ajustes excepcionales; CASHIER prepara con `sessions:manage`. La regla del creador no aplica al cierre.
- **Caja cerrada sellada en la base** (`cash_entries_closed_session_guard`) y pagos en efectivo de la caja bloqueados durante CLOSING; después del cierre se paga desde custodia o banco.
- **Canje posterior de fichas** solo como contrato de evaluación (`assessLateRedemption`), sin escrituras, hasta que exista un flujo completo con recepción física.

## Decisiones del Módulo 14

- **Capa de consulta, no segunda contabilidad**: `src/modules/reports/*` solo lee (rutas exclusivamente GET). No hay tablas de estadísticas ni saldos materializados: las cifras se derivan de `payment_allocations`, el libro financiero, el libro nominal y los snapshots `closure_reports`. Por eso no hace falta un mecanismo de consistencia de proyecciones.
- **Una sola fórmula por cifra**: los agrupamientos viven en funciones puras (`report.math.ts`: árbol jugador → sesión → compra, deuda al cierre vs. actual, totales de abonos sin duplicar) que alimentan pantalla, API y XLSX; los cobros de compras reutilizan `summarizePayments` (Módulo 08) y la circulación `getGlobalChipPosition` (Módulo 12). Las agregaciones SQL de listados se verifican contra el árbol en las pruebas de integración.
- **Deuda al cierre**: el total histórico es el snapshot del Módulo 12; el desglose por jugador/compra se reconstruye del libro inmutable con `allocatedAt ≤ closedAt`. La diferencia con el saldo actual se explica por clase de movimiento y se valida con una identidad.
- **Rendimiento**: paginación, métricas por lote de sesiones (número fijo de consultas), dos consultas para el árbol de créditos y 9 índices nuevos (`20261027120000_module14_report_indexes`, solo índices).
- **Actualización sin tiempo real**: TanStack Query para el dashboard (refetch al montar y al foco, invalidación global de `["reports"]` en cada mutación vía `MutationCache`) y `router.refresh()` al volver a la pestaña en los reportes de servidor. Sin WebSocket.
- **Filtros en la URL** (Zod en el servidor) + memoria por pestaña (`sessionStorage`, opcional) para restaurarlos al volver por el menú.
- **Dependencia nueva justificada: `exceljs` 4.4.0** (MIT): no existía librería XLSX; escribe y lee libros (las pruebas abren el archivo generado), formatos numéricos y fórmulas de totales. Se excluye del empaquetado (`serverExternalPackages`). Su dependencia `uuid@8` tenía un aviso moderado de `npm audit`; se fuerza `uuid@11.1.1` con `overrides` (API CJS compatible, verificado). **Sin CSV ni PDF.**
- **Gráficas sin dependencias**: barras horizontales con HTML/CSS accesibles (valor en texto, unidad, periodo y definición), suficientes para los comparativos; no se agregó una librería de gráficas.
- **Permisos**: los tres roles tienen `reports:view`, `reports:financial` y el nuevo `reports:export` (DEC-06..08); la exportación se audita (`REPORT_EXPORTED`).

## Decisiones del Módulo 15

- **Auditoría ampliada, no duplicada**: columnas transversales nuevas en `audit_logs` derivadas en `recordAudit` (cubre automáticamente los Módulos 01–14); sin outbox porque no hay replicación externa; la recuperación escribe además un registro externo de solo anexado.
- **Correcciones como proceso, no como contabilidad**: la solicitud nunca escribe en el libro; la ejecución se demuestra enlazando una operación real (unicidad de la referencia). Esto mantiene una sola fuente de verdad financiera y deja listo el enganche del Módulo 16.
- **Integridad**: comprobaciones SQL de solo lectura en una transacción REPEATABLE READ, reutilizando el árbol de créditos del Módulo 14 y la posición de fichas del Módulo 12; incidencias deduplicadas por huella con índice único parcial.
- **Respaldo lógico propio**: Neon corre PostgreSQL 18 y el `pg_dump` disponible es 16; la instantánea en una transacción consistente incluye las evidencias (viven en PostgreSQL), se comprime, cifra (AES-256-GCM) y se escribe inmutable. Restauración con `prisma migrate deploy` + carga en una transacción con `session_replication_role = replica`, verificada por huella por tabla. Sin dependencias nuevas.
- **Operaciones fuera de la web**: respaldos, pruebas de restauración y recuperación corren por CLI (`scripts/ops.ts` con `tsx --conditions=react-server`); la web solo consulta, prepara y aprueba. La automatización se declara activa solo por evidencia (respaldos SCHEDULED reales).
- **Modo mantenimiento** verificado en `withApiHandler` (escrituras → 503, caché de 5 s), exento para autenticación y la propia recuperación.
- **Permisos nuevos**: `corrections:request`, `integrity:run`, `incidents:manage`, `incidents:resolve`, `backups:read`, `system:health`, `recovery:manage` (solo SUPERADMIN) y `players:history`; CASHIER obtiene `audit:read` (DEC-03).

## Decisiones del Módulo 16

- **Sin libros nuevos**: canjes, reversos, correcciones y devoluciones reutilizan el inventario nominal (Módulo 04), el libro de partida doble (Módulo 05), el motor de aplicaciones (Módulo 10) y las autorizaciones (Módulo 15). Solo se agregan expedientes, obligaciones (`special_payables`, saldo derivado) y pagos (`special_payouts`).
- **Autorización y ejecución separadas**: la ejecución bloquea la solicitud aprobada dentro de su transacción (`requireApprovedCorrectionInTx`) y la enlaza ahí mismo (`linkExecutionInTx`); si algo falla, nada queda (ni la solicitud EXECUTED).
- **Defensa en la base**: triggers para la transición CONFIRMED → REVERSED, para cerrar la deuda de una compra revertida y para que los pagos nunca excedan la obligación; comprobaciones de integridad específicas en el diagnóstico.
- **Constantes compartidas fuera de módulos `"use client"`** (`special.constants.ts`): importar un valor (no un componente) desde un módulo cliente en una página de servidor produce una referencia de cliente, no el valor.
