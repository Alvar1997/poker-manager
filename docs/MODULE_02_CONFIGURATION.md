# Módulo 02 — Configuración general

Configuración del negocio, caja central, mesas, juegos físicos de fichas, denominaciones, métodos de pago, cuenta bancaria, folios, políticas operativas y WhatsApp (pendiente).

> **Este módulo solo configura.** No registra dinero, existencias de fichas, compras, deudas, sesiones, arqueos, liquidaciones ni folios emitidos. No hay ninguna tabla de movimientos ni columnas de saldo o cantidad. Las pruebas de integración lo verifican.

## 1. Configuración del negocio (`BusinessSettings`)

Registro **único** (`id = 1`, con `CHECK` en la base).

| Campo                    | Editable                      | Valor inicial             |
| ------------------------ | ----------------------------- | ------------------------- |
| `businessName`           | Sí (SUPERADMIN)               | Poker Manager             |
| `displayName`, `logoUrl` | Sí (SUPERADMIN), opcionales   | —                         |
| `dateFormat`             | Sí: `DD_MM_YYYY`/`YYYY_MM_DD` | `DD_MM_YYYY` (dd/MM/yyyy) |
| `timeFormat`             | Sí: `H12`/`H24`               | `H12` (12 horas)          |
| `currency`               | **No** (fija en esta versión) | MXN                       |
| `timezone`               | **No** (fija en esta versión) | America/Monterrey         |

Moneda y zona horaria son reglas del negocio (ver `docs/BUSINESS_RULES.md`); `src/lib/format.ts` las aplica. **Pendiente:** `dateFormat`/`timeFormat` se guardan, pero las pantallas aún formatean con es-MX; se aplicarán al construir los reportes.

## 2. Caja central única (`CashBox`)

- Un solo registro, código `MAIN`, "Caja Central", MXN, activa. La base **impide** una segunda caja (`CHECK code = 'MAIN'` + código único).
- **Sin campo de saldo.** El saldo se calculará a partir del libro de movimientos (módulo de caja). Nada en este módulo crea ni edita saldos.
- No pertenece a ninguna mesa y no es un juego de fichas. Crear una mesa no crea una caja.
- Solo el nombre es editable (SUPERADMIN).

## 3. Catálogo de mesas (`PokerTable`)

| Código        | Nombre     | Ciegas  | Juego asignado  |
| ------------- | ---------- | ------- | --------------- |
| `TABLE_25_25` | Mesa 25/25 | 25 / 25 | `CHIPSET_25_25` |
| `TABLE_10_10` | Mesa 10/10 | 10 / 10 | `CHIPSET_10_10` |

Reglas aplicadas:

- **TABLE-01**: código único e inmutable (solo se fija al crear).
- **TABLE-02/03/04**: activar/desactivar; no hay borrado (no existe `DELETE`).
- **TABLE-05**: el juego asignado debe existir y estar activo. La mesa muestra `readyForSession` y los requisitos pendientes (p. ej. "El juego de fichas no tiene denominaciones activas").
- **CHIP-02/03**: un juego físico **no puede estar asignado a dos mesas activas** a la vez. Es una regla del servicio y se puede revisar si el negocio lo requiere.
- Ciegas en `Decimal(12,2)`, `0 < chica ≤ grande` (validación + `CHECK` en la base).
- **TABLE-06/07, CHIP-09**: cambiar ciegas o juego no altera el pasado. Las sesiones (módulo posterior) deberán guardar una **fotografía** de ciegas y juego. Hoy no existen sesiones.
- **TABLE-08**: crear una mesa no crea una caja.
- **TABLE-09**: activar mesas en distintos momentos de una sesión es responsabilidad del módulo de sesiones.

## 4. Juegos físicos independientes (`ChipSet`)

- Dos juegos iniciales: `CHIPSET_25_25` ("Fichas Mesa 25/25") y `CHIPSET_10_10` ("Fichas Mesa 10/10"), **físicamente distintos**.
- `ChipSet` es independiente de `PokerTable`. La identidad del inventario será `(juego, denominación)`, nunca la mesa (**CHIP-05/06/10**).
- Las fichas de un juego no se mezclan con otro. Pasar fichas entre juegos requerirá una **operación de conversión registrada** (módulo de movimientos de fichas), que no es una compra ni un cobro.
- No hay borrado; un juego en uso se desactiva (**CHIP-07/08**). No se puede desactivar un juego asignado a una mesa activa.

## 5. Denominaciones (`ChipDenomination`)

- Pertenecen a un juego. `value` es `Decimal(12,2)` > 0 (validación + `CHECK`), nunca Float. La API recibe y devuelve montos como **string**.
- Único `(chipSetId, value)`: no hay duplicados dentro de un juego (409), pero **sí** el mismo valor en juegos distintos (**DEN-05/06**).
- Nombre y color son opcionales y descriptivos: el color **no** determina el valor (**DEN-07/08**).
- Sin cantidades (**DEN-12**). No hay borrado; se desactivan y se conservan (**DEN-09/10**).
- **No se inventaron denominaciones.** Los dos juegos iniciales quedan **sin denominaciones** y la UI avisa "Requiere configurar denominaciones antes de abrir una sesión".
- **DEN-11** (no cambiar el valor de una denominación con movimientos): hoy no existen movimientos de fichas. El módulo de inventario deberá bloquear el cambio de `value` cuando los haya.

## 6. Métodos de pago (`PaymentMethod`)

- `CASH` (Efectivo) y `BANK_TRANSFER` (Transferencia bancaria). Catálogo cerrado (`enum`): no se crean ni se borran; se renombran, ordenan y activan/desactivan. Debe quedar al menos uno activo.
- **No existe `MIXED`**: un pago mixto será una operación con componentes (p. ej. $500 efectivo + $1,000 transferencia + $500 crédito).
- **No existe `CREDIT`**: el crédito es una cuenta por cobrar, no dinero, y nunca se suma al saldo (**PAY-06/07**).

## 7. Cuenta bancaria única (`PaymentAccount`)

- Una sola cuenta **activa y principal**, garantizada por un índice único parcial en la base (**BANK-01/10**). La usan ambas mesas y no pertenece a ninguna (**BANK-02/04**).
- **Se sembró sin datos** ("Cuenta bancaria principal", pendiente de captura). No se inventaron banco, titular ni CLABE.
- Número de cuenta y CLABE se guardan **cifrados** (AES-256-GCM, clave en `SETTINGS_ENCRYPTION_KEY`). La API y la auditoría solo muestran los **últimos 4 dígitos** (**BANK-07/08**). La CLABE se valida con su dígito de control.
- Nunca se aceptan contraseñas, claves de banca electrónica ni tokens (**BANK-06**): el schema rechaza cualquier campo extra.
- **Historial (BANK-09)**: capturar números distintos en una cuenta que ya tenía datos crea una cuenta nueva principal y desactiva la anterior en la misma transacción.
- Acceso: SUPERADMIN edita; PARTNER consulta enmascarado; CASHIER no tiene acceso.
- El saldo del banco no se reinicia entre sesiones (**BANK-05**); se calculará con los movimientos futuros.

## 8. Política de fondo inicial

`OperationalSettings.initialCashPolicy = NEW_FUND_PER_SESSION` (registro único `id = 1`).

Cada sesión inicia con un fondo **nuevo**, de importe variable, registrado en la apertura y verificado físicamente por el cajero sin autorización externa. No se arrastra efectivo, no es ingreso por venta ni ganancia, y no hay un importe fijo (**FUND-01…08**). El movimiento de apertura **no está implementado** (módulo de sesiones).

## 9. Política de retiro total al cierre

`OperationalSettings.closingCashPolicy = FULL_WITHDRAWAL`.

Arqueo final → efectivo contado → importe retirado, responsable y receptor → efectivo esperado = 0. Las diferencias se registran con explicación. El retiro no es gasto, pérdida ni utilidad. Banco y cuentas por cobrar continúan, y las deudas no se borran (**CLOSE-01…12**). El cierre financiero **no está implementado**.

## 10. Políticas de crédito y 11. Compensación FIFO

Son reglas **fijas** de esta versión (`src/config/operational-rules.ts`), sin interruptores editables. Se muestran en Configuración → Reglas operativas con el módulo que las aplicará:

- Compras a crédito permitidas, sin autorización externa.
- Firma obligatoria en entregas de fichas.
- Compensación automática de deudas al liquidar, **FIFO** (la más antigua primero).
- Arqueos inicial y final obligatorios; una caja central; fondo nuevo; retiro total.
- Notificación de compras a crédito por WhatsApp **después** de confirmar (pendiente).
- Hora local America/Monterrey; dinero y fichas por separado; operaciones confirmadas no editables; auditoría obligatoria.

Solo las políticas de efectivo se guardan en la base, como `enum` de un único valor. No se construyó un motor genérico de reglas.

## 12. Permisos

| Permiso nuevo     | SUPERADMIN | PARTNER | CASHIER | Uso                                                                  |
| ----------------- | :--------: | :-----: | :-----: | -------------------------------------------------------------------- |
| `settings:read`   |     ✅     |   ✅    |    —    | Caja, cuenta bancaria (enmascarada), folios, WhatsApp; ver inactivos |
| `catalogs:read`   |     ✅     |   ✅    |   ✅    | General, mesas, juegos, denominaciones, métodos de pago, reglas      |
| `settings:manage` |     ✅     |    —    |    —    | (ya existía) Cualquier modificación de configuración                 |

CASHIER ve solo registros **activos** de mesas, juegos, denominaciones y métodos. Todo se verifica en el servidor (`requirePermission`/`requirePagePermission`), y cada 403 queda auditado.

## 13. Folios (`FolioSequence`)

| Tipo            | Prefijo | Ejemplo    |
| --------------- | ------- | ---------- |
| `SESSION`       | SES     | SES-000001 |
| `PURCHASE`      | CMP     | CMP-000001 |
| `DEBT_PAYMENT`  | ABN     | ABN-000001 |
| `SETTLEMENT`    | LIQ     | LIQ-000001 |
| `CASH_MOVEMENT` | MOV     | MOV-000001 |
| `CHIP_MOVEMENT` | MFI     | MFI-000001 |
| `CASH_CLOSING`  | CIE     | CIE-000001 |

- `issueFolio(tx, tipo)` (`src/modules/settings/folio.service.ts`) emite con un solo `UPDATE … RETURNING`, que es atómico, así que no hay duplicados bajo concurrencia (probado con 25 emisiones simultáneas). Debe llamarse dentro de la transacción del documento.
- Un folio emitido nunca se reutiliza; cancelar será un estado del documento (**FOL-05**). El folio es independiente del id interno (**FOL-06**).
- Prefijo, dígitos y siguiente número solo se editan **antes** del primer folio (**FOL-04/07**). La edición es condicionada, así que no compite con una emisión simultánea.
- **Ningún endpoint emite folios en este módulo.**

## 14. WhatsApp — PENDIENTE

> **El número nuevo exclusivo de Poker Manager está pendiente de recepción. La configuración de WhatsApp deberá completarse posteriormente desde Configuración → WhatsApp. No se necesitan datos reales para finalizar el Módulo 02.**

- `WhatsAppSettings` (registro único) solo guarda datos **no sensibles**: proveedor `META_CLOUD_API`, `senderPhone`/`phoneNumberId`/`businessAccountId` (todos vacíos), `enabled = false` y `configurationStatus = PENDING_CONFIGURATION`. La base **impide** `enabled = true` mientras no esté `CONFIGURED`.
- Tokens y secretos **nunca** van a la base. Las variables `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_BUSINESS_ACCOUNT_ID`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN` y `WHATSAPP_APP_SECRET` están declaradas **vacías** en `.env.example` y son opcionales en `src/lib/env.ts`.
- La pantalla muestra: proveedor, estado "Pendiente de configuración", número "No configurado", integración activa "No", plantillas "Pendientes" y última verificación "No disponible".
- No hay conexión con Meta, verificación de número, webhooks, cola ni endpoints de envío. La integración real corresponde al **Módulo 13 — Notificaciones automáticas**.

## 15. Endpoints

| Método | Ruta                               | Permiso           |
| ------ | ---------------------------------- | ----------------- |
| GET    | `/api/settings/general`            | `catalogs:read`   |
| PATCH  | `/api/settings/general`            | `settings:manage` |
| GET    | `/api/settings/cash-box`           | `settings:read`   |
| PATCH  | `/api/settings/cash-box`           | `settings:manage` |
| GET    | `/api/tables`                      | `catalogs:read`   |
| POST   | `/api/tables`                      | `settings:manage` |
| GET    | `/api/tables/:id`                  | `catalogs:read`   |
| PATCH  | `/api/tables/:id`                  | `settings:manage` |
| PATCH  | `/api/tables/:id/status`           | `settings:manage` |
| GET    | `/api/chip-sets`                   | `catalogs:read`   |
| POST   | `/api/chip-sets`                   | `settings:manage` |
| GET    | `/api/chip-sets/:id`               | `catalogs:read`   |
| PATCH  | `/api/chip-sets/:id`               | `settings:manage` |
| PATCH  | `/api/chip-sets/:id/status`        | `settings:manage` |
| GET    | `/api/chip-sets/:id/denominations` | `catalogs:read`   |
| POST   | `/api/chip-sets/:id/denominations` | `settings:manage` |
| PATCH  | `/api/denominations/:id`           | `settings:manage` |
| PATCH  | `/api/denominations/:id/status`    | `settings:manage` |
| GET    | `/api/payment-methods`             | `catalogs:read`   |
| PATCH  | `/api/payment-methods/:id`         | `settings:manage` |
| GET    | `/api/settings/bank-account`       | `settings:read`   |
| PATCH  | `/api/settings/bank-account`       | `settings:manage` |
| GET    | `/api/settings/folios`             | `settings:read`   |
| PATCH  | `/api/settings/folios/:id`         | `settings:manage` |
| GET    | `/api/settings/operational`        | `catalogs:read`   |
| GET    | `/api/settings/whatsapp`           | `settings:read`   |

Todos siguen el patrón del Módulo 01: autorización → Zod (`strictObject`) → servicio → Prisma en transacción con auditoría. No hay endpoints `DELETE`.

**Pantallas** (Mobile First, solo lectura sin `settings:manage`): `/dashboard/configuracion` y sus secciones `general`, `caja`, `mesas`, `fichas` (+ `fichas/[id]`), `pagos`, `banco`, `folios`, `reglas` y `whatsapp`. Atajo: `/configuracion/*` redirige a `/dashboard/configuracion/*`. Las páginas privadas viven bajo `/dashboard`, como en el Módulo 01.

**Auditoría:** `SETTINGS_BUSINESS_UPDATED`, `SETTINGS_CASH_BOX_UPDATED`, `TABLE_*`, `CHIP_SET_*`, `CHIP_DENOMINATION_*`, `PAYMENT_METHOD_UPDATED`, `BANK_ACCOUNT_UPDATED`/`BANK_ACCOUNT_REPLACED` (solo últimos 4 dígitos) y `FOLIO_SEQUENCE_UPDATED`, con cambios antes/después, actor y `requestId`.

## 16. Modelos y migraciones

Modelos nuevos: `BusinessSettings`, `CashBox`, `ChipSet`, `ChipDenomination`, `PokerTable`, `PaymentMethod`, `PaymentAccount`, `FolioSequence`, `OperationalSettings`, `WhatsAppSettings`. Enums nuevos: `DateFormat`, `TimeFormat`, `PaymentMethodCode`, `PaymentAccountType`, `FolioDocumentType`, `InitialCashPolicy`, `ClosingCashPolicy`, `WhatsAppProvider`, `WhatsAppConfigurationStatus`.

Migración `20261014120000_module02_configuration` (aditiva; no altera tablas existentes salvo FKs nuevas hacia `users`) con restricciones adicionales:

- `CHECK` singleton (`id = 1`) en configuración general, operativa y WhatsApp.
- `CHECK code = 'MAIN'` en `cash_boxes`.
- `CHECK value > 0` (denominaciones) y `smallBlind > 0 AND bigBlind >= smallBlind` (mesas).
- `CHECK nextNumber >= 1 AND padding BETWEEN 1 AND 12` (folios).
- Índice único parcial `payment_accounts (isPrimary) WHERE isPrimary AND isActive`.
- `CHECK NOT enabled OR configurationStatus = 'CONFIGURED'` (WhatsApp).

**Seed** (`npm run db:seed`, idempotente): `src/modules/settings/configuration.seed.ts` usa `upsert` por clave estable con `update: {}`, así que no duplica ni pisa ediciones. Ahora el seed siempre siembra la configuración; el bootstrap del SUPERADMIN corre solo si se definen las variables `SEED_SUPERADMIN_*`.

## 17. Pruebas

- **Unitarias:** permisos (`settings:read`, `catalogs:read`), secciones por rol, navegación, montos, CLABE, cifrado, schemas, folio y reglas fijas.
- **Integración (Postgres real):** `tests/integration/configuration.int.test.ts` cubre los casos obligatorios 1–20 (caja única, mesas/juegos distintos, denominaciones, permisos por rol, cuenta única, idempotencia del seed, folios concurrentes, WhatsApp pendiente y ausencia de tablas o columnas de movimientos). Los 40 casos del Módulo 01 siguen pasando (caso 21).
- **E2E (Chrome + iPhone 14):** `tests/e2e/configuration.spec.ts` cubre el panel, mesas, denominaciones con duplicado, WhatsApp, banco/folios, PARTNER en solo lectura y CASHIER con catálogos, y verifica que no haya scroll horizontal en celular (caso 22).
