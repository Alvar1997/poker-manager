# CLAUDE.md — Poker Manager

Reglas permanentes para trabajar en este repositorio. Léelas antes de modificar cualquier módulo.

## Arquitectura

- Full Stack con Next.js 16 (App Router, TypeScript estricto).
- Prisma ORM 7 (driver adapter `@prisma/adapter-pg`) como capa de datos.
- PostgreSQL alojado en Neon.
- Arquitectura modular por dominio bajo `src/modules/*` (auth, users, sessions, tables, players, chips, cash, purchases, credits, settlements, closure, reports, audit — ver `docs/MODULES.md`).
- Mobile First: todo se diseña primero para pantalla de celular.
- Patrón de capas en el backend: **Route Handler → Autorización (`src/config/permissions.ts`) → Validación (Zod) → Servicio (`src/modules/*`) → Prisma** (desde el Módulo 01 la autorización va primero: sin sesión siempre 401, sin permiso siempre 403). Los componentes React nunca contienen lógica financiera ni hacen queries directas a la base de datos.

Detalle completo de decisiones técnicas: `docs/ARCHITECTURE.md`.

## Reglas de negocio globales

- Una única caja central. El dinero se administra exclusivamente desde ahí.
- Dos mesas (25/25 y 10/10) pueden operar simultáneamente desde el inicio.
- Cada movimiento pertenece a una sesión y, cuando corresponde, a una mesa — nunca se duplica entre mesas.
- Cada compra pertenece a una sesión, una mesa y un jugador.
- El crédito **no** representa dinero recibido — es una deuda del jugador.
- El inventario de fichas es independiente del saldo de dinero.
- El cajero confirma apertura y cierre de sesión (arqueo) sin necesitar autorización de un supervisor.
- Las compras a crédito no requieren aprobación en el sistema, pero deben identificar al **socio que autorizó** el crédito (verbalmente o por mensaje) — Módulo 08.
- SUPERADMIN y PARTNER tienen prácticamente las mismas capacidades de operación y visibilidad financiera. Administración de usuarios, roles, seguridad y configuración crítica son exclusivas de SUPERADMIN. CASHIER opera la caja sin aprobación de socios.
- Usuarios: nunca borrado físico (solo desactivar); siempre al menos un SUPERADMIN activo; nadie cambia su propio rol.
- Caja central única (`CashBox` `MAIN`), sin campo de saldo: los saldos se derivan de movimientos. **UN INVENTARIO FÍSICO DE FICHAS COMPARTIDO + DOS MESAS OPERATIVAS + UNA CAJA FINANCIERA CENTRAL.** Las sesiones deben guardar una fotografía de ciegas y juego.
- El crédito no es un método de pago; el pago mixto es una operación con componentes.
- WhatsApp: el número exclusivo está pendiente; la integración real corresponde al Módulo 13 y su ausencia no bloquea nada. Nunca guardes tokens en la base de datos.
- Jugadores (`Player`) separados de los usuarios administrativos: sin correo, contraseña ni rol.
- Teléfono del jugador obligatorio, normalizado a E.164 con `src/lib/phone.ts` (México por defecto) y único en la base. Nunca concatenar +52 a mano.
- Crédito ilimitado: sin límite por jugador ni global (`src/config/credit-policy.ts`); nunca agregar campos o controles de límite sin una decisión de negocio documentada.
- Deudas y saldos SIEMPRE derivados de movimientos reales confirmados; nunca campos editables del jugador.
- Consentimiento de WhatsApp independiente del teléfono: explícito, versionado, revocable, ligado al número; los envíos deben consultar `getConsentStatus(playerId).granted`.
- Sin borrado físico de jugadores (desactivar); un inactivo no se selecciona para operaciones nuevas (`assertPlayerSelectable`), pero sus deudas siguen vigentes.
- Inventario de fichas: hay UN solo inventario físico (`ChipSet` `CHIPSET_MAIN`, ubicación `INVENTARIO-GENERAL`) compartido por las mesas 25/25 y 10/10: denominaciones y existencias comunes, sin inventarios ni maletines por mesa. La base impide dos juegos activos (`chip_sets_single_active`). Las operaciones guardan `tableId`/`sessionId`/`playerId` solo como trazabilidad; nunca separan stock. Un jugador que cambia de mesa conserva sus fichas (sin conversión). El inventario NO es la caja y las fichas NUNCA se registran como efectivo.
- Toda escritura de inventario pasa por `src/modules/inventory/*` (bloqueo del inventario compartido + transacción + idempotencia): las dos mesas se serializan y nunca entregan las mismas fichas. Nunca escribir directamente en `chip_inventory_balances`/`movements`.
- Ajustes de inventario: SUPERADMIN, PARTNER y CASHIER, sin aprobación adicional, con motivo obligatorio y auditoría.
- Movimientos de fichas inmutables (se corrigen con ajustes); arqueos con el motor único de `stock-count.service.ts` (sesiones lo reutilizan con OPENING/CLOSING).
- **Compras y recompras SOLO por importe nominal**: no se exige ni almacena desglose por denominación en cada entrega. El inventario operativo usa un saldo nominal compartido (`custodyNominal`/`reservedNominal`/`circulationNominal`); las cantidades físicas por denominación se verifican en los arqueos. Compras y liquidaciones usan `reserveNominalAmountInTx` → `confirmNominalChipDeliveryInTx` (una sola vez) / `releaseNominalReservationInTx` y `confirmNominalChipReturnInTx` dentro de su transacción; nunca duplicar entregas ni devoluciones.
- Firma del jugador en el celular del cajero **solo cuando la compra genera crédito** (corrección confirmada para el Módulo 08; antes: toda entrega).
- Al liquidar, la compensación de deudas es OPCIONAL (decisión explícita del cajero: no compensar, parcial o máximo); si se compensa, la distribución es FIFO automático (Módulo 11).
- Los mensajes de WhatsApp de compras/recompras a crédito se envían **después** de confirmar la compra, no antes.
- Una sesión cerrada no admite edición directa (correcciones van por un mecanismo de auditoría explícito, no por mutar el histórico).

### Caja central (Módulo 05) — reglas permanentes

- **Una caja central para ambas mesas** (`CashBox` `MAIN`): las dos mesas usan el mismo libro financiero; cada movimiento se registra una sola vez, con su mesa cuando corresponde.
- **Cada sesión inicia con $0.00 de efectivo** (`ZERO_OPENING_BALANCE`). **No existe fondo inicial** (ni obligatorio ni automático) y **no existe arrastre** de efectivo entre sesiones: el efectivo se lleva por sesión (`scopeKey` = id de sesión).
- **No hay apertura operativa sin arqueo de fichas**: un arqueo general vigente del inventario compartido (uno solo, nunca uno por mesa; motor del Módulo 04) y un arqueo de efectivo de apertura confirmado en $0.00 (`assertOpeningReady({ sessionId })`). Si hay dinero al abrir, se retira y se recuenta; nunca se convierte en fondo.
- **No se permite saldo negativo** de efectivo (ni en tránsito): se rechaza indicando el faltante.
- **No existen gastos operativos**: ni tipo, ni categoría genérica, ni formulario. Los retiros solo tienen destinos cerrados (propietario/socio, resguardo, devolución de aportación, cierre).
- **Las transferencias se verifican manualmente** y **los tres roles** (SUPERADMIN, PARTNER, CASHIER) pueden confirmarlas o rechazarlas sin aprobación adicional. Una pendiente no es cobro.
- **El crédito no se contabiliza como dinero** y **las compensaciones FIFO no son entradas ni salidas de efectivo**: en una liquidación solo sale dinero realmente entregado (cada desembolso es un asiento).
- **El cierre requiere retiro total** del efectivo tras el arqueo de cierre (`withdrawAllCashForClosingInTx`, Módulo 12).
- **La cuenta bancaria conserva su historial**: no se reinicia entre sesiones.
- **No existe doble registro financiero**: una operación de origen (compra, abono, liquidación, transferencia) genera a lo sumo un asiento (índices únicos), y los reintentos son idempotentes.
- Toda escritura de dinero pasa por `src/modules/cash/ledger.ts#postTransactionInTx` (partida doble, bloqueo `FOR UPDATE`, folio, auditoría). Nunca escribir directamente en `cash_transactions`, `cash_transaction_entries` ni `financial_account_balances`. Los movimientos son inmutables; se corrigen con reversos.
- La caja no inventa sesiones: pregunta al `SessionGateway` (`src/modules/cash/session-gateway.ts`). El Módulo 06 debe registrar su implementación con `registerSessionGateway`.

### Sesiones (Módulo 06) — reglas permanentes

- **Única forma de abrir:** CREAR → PREPARAR → CONTAR EL INVENTARIO FÍSICO COMPARTIDO → CONCILIAR → CONFIRMAR EFECTIVO FÍSICO $0 → CONFIRMAR APERTURA. Ningún rol (tampoco SUPERADMIN) omite estos controles; el checklist se DERIVA de registros reales (`computeOpeningChecklist`), nunca de booleanos editables ni del navegador.
- **Una sola sesión vigente** (DRAFT/PREPARATION/OPEN/CLOSING) a la vez: índice único parcial `poker_sessions_single_active`. Transiciones solo por `transitionInTx` (y trigger en la base): DRAFT→PREPARATION→OPEN→CLOSING→CLOSED, CLOSING→OPEN (regreso auditado con motivo, Módulo 12), DRAFT/PREPARATION→CANCELLED. Nunca reabrir una sesión CLOSED.
- **Regla del creador:** solo quien creó la sesión, o SUPERADMIN (intervención auditada), prepara y confirma la apertura. Se aplica también en los arqueos de fichas y de efectivo ligados a la sesión (`assertPreparationAccess`), sin atajos por endpoints genéricos. No restringe la operación de mesas después de abrir.
- Un arqueo general del inventario COMPARTIDO por apertura (no uno por mesa), vigente por `resultingInventoryVersion`; sin reservas activas de operaciones anteriores. Las fichas en circulación de sesiones cerradas NO bloquean la apertura: se informan como valor pendiente de retorno (Módulo 12). Caja física confirmada en $0 (arqueo de efectivo OPENING) sin crear movimientos de dinero.
- Folio, creador y fechas reales los fija el servidor (UTC, mostradas en America/Monterrey); una sesión puede cruzar medianoche. Se puede abrir sin mesas.
- **Folio `S-0001-YYYYMMDD`** (`session-folio.ts`): consecutivo GLOBAL (`sequenceNumber`, único, por orden real de creación, emitido con `issueSessionFolio` dentro de la transacción; nunca MAX()+1 ni renumerar) + fecha operativa. Inmutable (trigger + CHECK de formato). `businessDate` (DATE) es la JORNADA; nunca confundirla con `createdAt`/`openedAt`/`closedAt` ni con fechas de movimientos. Reportes por jornada usan `businessDate`; la deuda sigue agrupada por `sessionId` de origen. Folios anteriores en `previousFolio`.
- **Sesiones históricas**: solo SUPERADMIN (`sessions:historical-create`, validado en el servidor y con rechazo auditado), de un día ANTERIOR a hoy. Estado `HISTORICAL`: no ocupa la sesión vigente, sin caja, inventario, mesas ni operación en vivo; solo pasa a CANCELLED. Nunca simular operaciones pasadas con los flujos en vivo (la captura financiera histórica NO existe todavía). Detalle: `docs/SESSION_FOLIO_AND_HISTORICAL_ENTRY.md`.

### Mesas y participación (Módulo 07) — reglas permanentes

- Un solo inventario físico y una sola caja central; las mesas son operativamente independientes (estado, ciclos, participaciones), nunca tienen caja ni inventario propios.
- Cada apertura o reapertura de mesa crea un **ciclo nuevo** (un solo ciclo OPEN por mesa: índice parcial); los ciclos cerrados son inmutables. Abrir/cerrar/reabrir no mueve dinero ni fichas ni exige otro arqueo.
- **Una participación ACTIVE por jugador por sesión** (índice parcial `table_participations_one_active_per_player`): nunca en dos mesas a la vez.
- **Transferencia de mesa** sin liquidación, sin conteo de fichas, sin cobro ni pago y sin movimiento de inventario: origen TRANSFERRED + destino ACTIVE + `TableTransfer`, atómico e idempotente.
- **Salida definitiva solo con liquidación real confirmada** (`completeParticipationFromSettlementInTx`, Módulo 11); no hay endpoint que marque SETTLED. No se cierra una mesa con participantes activos. Historial inmutable (sin DELETE).

### Compras y recompras (Módulo 08) — reglas permanentes

- **Solo importe**: ningún schema, endpoint ni pantalla de compras pide o guarda denominaciones, cantidades ni combinaciones. Sesión, mesa, ciclo, jugador, folio, responsables, fechas, numeración e importe autorizado los deriva el servidor desde la participación ACTIVE.
- **Pagos por componente** (`PurchasePayment`): efectivo (declarado recibido), transferencia (PENDIENTE en el Módulo 05 hasta verificación manual), `CARD_DEBIT`/`CARD_CREDIT` (solo `APPROVED`, con folio y confirmación explícita; nunca datos de tarjeta). El crédito NO es método de pago: es `importe − pagos confirmados`. Una transferencia pendiente forma parte de ese saldo (nunca otra deuda).
- **Efectivo y tarjeta se contabilizan al confirmar la entrega**, en la MISMA transacción que la salida nominal, la deuda y la numeración (referencia `PurchasePayment`, un asiento por componente). Tarjeta aprobada → `CARD_TERMINAL_CLEARING` (nunca efectivo); el depósito de la terminal (`card-settlement.service.ts`) mueve a banco sin reconocer la venta otra vez y no inventa comisiones.
- **Crédito**: exige socio ACTIVO con rol PARTNER (`PurchaseCreditAuthorization`, VERBAL/MESSAGE, registro operativo del cajero, sin aprobación en línea) y **firma auténtica** de la versión exacta (`PurchaseSignatureVerifier`; el real del Módulo 09 está registrado por defecto). Nunca simular firmas ni aceptar booleanos del cliente. Cualquier cambio material incrementa `version` (`bumpPurchaseVersionInTx`, con actor y motivo) e invalida autorización y firma.
- **Deuda**: `PlayerDebt` inmutable con saldo DERIVADO (`listPlayerPurchaseDebts`); nunca un campo de saldo. WhatsApp: solo evento `PURCHASE_CREDIT_CONFIRMED` en `notification_outbox` (deduplicado); este módulo no envía nada.
- **Numeración** por (sesión, jugador) al confirmar, serializada por la participación (`FOR UPDATE`) + índice único; no se reinicia al cambiar de mesa y las compras conservan su mesa original.
- **Orden de bloqueos**: sesión (FOR SHARE) → compra → mesa → participación → inventario compartido → saldos (`lockAccountsInTx`). La verificación de transferencias bloquea la compra antes que la transferencia (`purchase-transfer-hook.ts`).
- Compras confirmadas inmutables (trigger); el reverso hoy es solo una SOLICITUD auditada (ejecución en Módulos 10/11). Cancelar un borrador exige devolver/anular cobros reales primero.

### Firmas y comprobantes (Módulo 09) — reglas permanentes

- **Firma solo si existe crédito** (saldo por cobrar > 0, aunque sea parcial) y **una firma independiente por cada compra o recompra con crédito**: nunca se reutiliza (snapshot único por firma, una VALID por compra, la entrega solo acepta una firma VALID de la misma compra).
- **El jugador firma en el celular del cajero** sobre un resumen preparado por el SERVIDOR (`SignatureSnapshot`, JSON canónico + SHA-256, declaración versionada). El navegador envía TRAZOS, nunca una imagen; el servidor genera el PNG. Sin presión ni tiempos (no biometría); no es firma electrónica avanzada.
- **La firma no equivale a la entrega**: no descuenta inventario, no crea deuda ni mueve dinero. **El cajero confirma la entrega después** (Módulo 08), y el verificador real (`moduleSignatureVerifier`) revalida firma, versión, huella, numeración e imagen dentro de esa transacción.
- Todo cambio material antes de entregar invalida la firma (`bumpPurchaseVersionInTx` → `invalidatePurchaseSignaturesInTx`); cancelar la deja `CANCELLED`. Evidencia inmutable: nunca se borra ni se sustituye (triggers).
- **Evidencia privada** vía `evidence-storage.ts` (driver PostgreSQL `evidence_blobs`; nunca carpetas públicas, disco temporal ni URLs públicas). Se sirve solo por `/api/purchases/:id/signature-evidence` tras autorizar.
- **Comprobante digital (no PDF)** para TODA compra confirmada, creado en la misma transacción de la entrega (`createReceiptInTx`), con snapshot inmutable; **descarga PNG** (`next/og`, desde el snapshot) y **compartición manual** (menú nativo, descarga o copiar texto). Nunca se envía WhatsApp desde aquí.
- Nunca registrar denominaciones de fichas por compra. En auditoría, las huellas van como `…Digest` (las claves con «hash» se filtran).

### Créditos y abonos (Módulo 10) — reglas permanentes

- La deuda (`PlayerDebt` = cuenta por cobrar) nace SOLO al confirmar una entrega con crédito, firma y socio (Módulo 08); una por compra. Su saldo se DERIVA del libro inmutable `payment_allocations` (original − aplicaciones + reversos); nunca hay saldos editables ni `currentDebt`.
- Abonos generales (`ReceivablePayment`) por **FIFO automático** (`allocateFifoInTx`, más antigua primero, desempate por id); el cliente nunca envía la distribución. Pagos vinculados a una compra (transferencia de la compra verificada tras entregar) se aplican a SU deuda (`allocatePurchasePaymentInTx`). Pagos inmediatos de compra nunca se redistribuyen.
- Abonos en sesión OPEN (efectivo a SU caja; la sesión la elige el servidor) o **ADMINISTRATIVOS** fuera de sesión: nunca tocan cajas de sesión (menos aún cerradas). El efectivo administrativo va a `ADMIN_CASH_CUSTODY` por custodio (`custodianScope`), no es caja de juego, no se suma a la apertura ($0) y se deposita al banco como traslado (sin doble ingreso).
- No se aceptan abonos mayores a la deuda ni saldos a favor. Transferencias pendientes no reducen deuda; terminal solo APROBADA (va a «por liquidar», nunca a efectivo). Dinero real recibido que ya no puede aplicarse → `UNAPPLIED_PLAYER_FUNDS` (por devolver), nunca saldo a favor.
- Serialización POR JUGADOR (`lockPlayerInTx`) en abonos, verificaciones, compensaciones y reversos; un trigger impide sobreaplicar deudas o abonos. Reversos solo con contraasientos (dinero + aplicaciones), sin re-ejecutar FIFO y sin borrar nada.
- Cada abono confirmado tiene comprobante digital inmutable (PNG con el mismo generador del Módulo 09, compartición manual; sin PDF). El Módulo 11 compensa con fichas mediante `applyChipSettlementOffsetInTx` (mismo motor, sin dinero) SOLO cuando el cajero decide compensar.

### Liquidaciones (Módulo 11) — reglas permanentes

- **Toda liquidación requiere la firma del jugador**, incluso con $0 devueltos, sobre un resumen preparado por el SERVIDOR (`SettlementSignatureSnapshot` canónico + parte material); una firma por snapshot, una VALID por liquidación, nunca reutilizada (ni de compras). La firma no recibe fichas ni mueve dinero: el cajero confirma la recepción después (`confirmReturn`), que recalcula el plan y exige que coincida con lo firmado (si no, 409 y firma nueva).
- **Solo valor nominal**: se captura `returnedNominalAmount` (≥ 0); nunca denominaciones. La entrada al inventario compartido ocurre UNA vez al recibir (`confirmNominalChipReturnInTx`, clave por liquidación); con $0 no hay movimiento artificial.
- **Compensación OPCIONAL**: `NO_COMPENSATE` | `PARTIAL` (importe del cajero) | `MAXIMUM` (min(fichas, deuda)); si se compensa, FIFO del Módulo 10 (`applyChipSettlementOffsetInTx`), nunca selección manual; no es dinero. Nunca más que las fichas ni que la deuda; con $0 no se compensa.
- **Cuenta por pagar** (`SettlementPayable`, saldo derivado = original − desembolsos EXECUTED) distinta de la deuda del jugador (`PlayerDebt`); nunca se fusionan sin decisión del cajero.
- **Desembolsos** (`SettlementPayout`): efectivo (se contabiliza al entregarlo; caja de SU sesión si está OPEN/CLOSING, si no custodia administrativa del pagador; nunca caja cerrada) y transferencia (PENDING reserva y no cuenta; EXECUTED tras verificación manual; FAILED/CANCELLED liberan). Nunca más que `pendiente − reservado` (bloqueo + trigger); todo por `recordSettlementPayoutInTx`.
- **Participación**: `SETTLING` (fichas recibidas, falta pagar; sin silla, sin compras ni transferencias; sin reingreso en la sesión) → `SETTLED` al pagar. Con liquidación en curso (DRAFT/READY) no hay compras ni cambio de mesa. Solo vía `markParticipationSettlingInTx`/`completeParticipationFromSettlementInTx` con `settlementVerifier`.
- Las obligaciones sobreviven al cierre de mesa y de sesión; después se pagan con custodia (fondeada con aportaciones documentadas) o banco. Comprobante de recepción inmutable + anexos por pago (PNG, sin PDF).
- Recepción confirmada inmutable (trigger); reverso solo sin pagos reales, sesión abierta y fichas devueltas físicamente al jugador (contraasientos, nada se borra).

### Cierre de mesas y sesiones (Módulo 12) — reglas permanentes

- **Una caja central y un inventario compartido**: cada mesa cierra su ciclo por separado (sin arqueo), pero el arqueo final de fichas es **ÚNICO y GLOBAL**, por denominación, con el motor del Módulo 04 (`countType CLOSING`), confirmado SOLO desde el cierre. Compras y liquidaciones siguen sin denominaciones.
- Cerrar un ciclo exige: sin participaciones ACTIVE, sin compras ni liquidaciones del ciclo sin resolver; las SETTLING (falta pagar) pueden quedar. No se calcula un resultado neto por mesa.
- Flujo: prevalidación (BLOCKING / WARNING / INFO; solo BLOCKING bloquea) → `OPEN → CLOSING` → arqueo de fichas → arqueo de efectivo → diferencias → retiro final → confirmación. En CLOSING no hay compras, mesas, jugadores, transferencias, liquidaciones nuevas ni pagos en efectivo de la caja de la sesión.
- **«Las fichas que no regresan al cierre se muestran como valor nominal pendiente de retorno o en circulación. No constituyen automáticamente un faltante físico de arqueo ni utilidad definitiva y no se pagan sin una presentación y validación física posterior.»** Nunca mezclar: diferencia física (contado − esperado bajo custodia, bloquea), neto no retornado de la sesión e circulación GLOBAL (continua entre sesiones, nunca se reinicia; atribución por jugador solo informativa).
- Una diferencia física bloquea hasta resolverla: **recuento** (el original queda `SUPERSEDED`), **regreso a OPEN** o **ajuste excepcional** autorizado SOLO por PARTNER/SUPERADMIN (`ClosureAdjustmentAuthorization`, la diferencia original se conserva).
- **Caja $0 → $0**: arqueo de efectivo (esperado = libro), retiro final por el importe EXACTO disponible con receptor declarado (sin login ni firma del receptor), caja final $0. No es gasto.
- **Solo PARTNER o SUPERADMIN confirman** (`sessions:close-authorize`), en una transacción que revalida todo y exige la huella del resumen revisado (409 si hubo movimientos relevantes después). CASHIER prepara todo.
- **Regreso CLOSING → OPEN** con motivo (y hora informada aparte): conserva arqueos como evidencia, invalida el intento y no reabre ciclos cerrados. Una sesión CLOSED nunca se reabre y su caja no admite partidas (trigger).
- Cierre **sin actividad** (sin ciclos de mesa) con motivo obligatorio; nunca se usa CANCELLED como sustituto.
- El cierre NO cobra, paga ni compensa: deudas, pagos pendientes, transferencias, terminal y circulación sobreviven con su estado real. Comprobante `ClosureReport` inmutable (PNG, sin PDF, compartición manual); los movimientos posteriores no lo cambian.
- Canje posterior de fichas no retornadas: solo contrato (`assessLateRedemption`, sin escrituras); nunca pagar sin recepción física validada ni duplicar devoluciones.

### Reportes y estadísticas (Módulo 14) — reglas permanentes

- **«Toda deuda debe poder consultarse de forma global por jugador, desglosada por sesión de origen y finalmente por cada compra o recompra. Los pagos posteriores se aplican a las obligaciones originales y no trasladan la deuda a la fecha o sesión del pago.»** Agrupar SIEMPRE por `PlayerDebt.sessionId` original (nunca por la sesión o fecha del abono); la mesa y el ciclo son los de la compra.
- **Solo lectura** (`src/modules/reports/*`): sin tablas nuevas, sin saldos materializados, sin escrituras ni endpoints que no sean GET. Las cifras salen de las fuentes de verdad (libro de aplicaciones, libro financiero, libro nominal, snapshots de cierre) y de funciones PURAS compartidas por pantalla, API y XLSX (`report.math.ts`; cobros con `summarizePayments` del Módulo 08). Nunca duplicar fórmulas en componentes.
- **Cuatro categorías que no se suman**: nominal, monetario, por cobrar, por pagar. **No se declara utilidad neta** sin fórmula contable validada; el crédito no es ingreso, la circulación no es utilidad, los retiros no son gastos y el depósito de terminal es traslado (no se suma otra vez).
- **Deuda al cierre** = snapshot inmutable del `ClosureReport` (por jugador/compra, reconstruida del libro con `allocatedAt ≤ closedAt`); **deuda actual** = movimientos vigentes; la diferencia se identifica por clase (abonos, pagos vinculados, compensaciones, reversos). Un abono se suma UNA vez aunque tenga varias aplicaciones; las compensaciones no son abonos de efectivo; CxC y CxP nunca se netean.
- Filtros validados con Zod en el servidor y persistidos en URL search params (fecha de ORIGEN de deuda ≠ fecha REAL del abono). Los tres roles consultan y exportan (`reports:view`, `reports:financial`, `reports:export`).
- **Exportación EXCLUSIVA XLSX** (ExcelJS; sin CSV ni PDF), con los mismos servicios de pantalla, formato MXN numérico, anti-inyección de fórmulas (`safeText`), límite de filas y auditoría `REPORT_EXPORTED` (consultar no se audita).

### Auditoría, administración y respaldos (Módulo 15) — reglas permanentes

- **Auditoría transversal en `audit_logs`** (solo inserción por trigger): `recordAudit` deriva rol del momento, módulo, sesión, jugador, ciclo, importe e idempotencia; audita SIEMPRE dentro de la transacción de la operación. Nunca crear otra tabla de auditoría ni endpoints que editen/borren eventos. Los tres roles consultan la auditoría operativa y financiera (`audit:read`); seguridad (`audit:security-read`) e infraestructura (`backups:read`) NO se exponen por esa autorización.
- **Correcciones excepcionales**: cualquier rol solicita (`corrections:request`); solo PARTNER/SUPERADMIN deciden (`corrections:operate`), sin autoaprobarse si hay otro autorizador. **Aprobar NO modifica saldos**: EXECUTED solo al ENLAZAR la operación real ya registrada por el servicio legítimo de su módulo (verificada). Los 4 procesos del Módulo 16 se EJECUTAN en Operaciones especiales, que enlaza la solicitud en su misma transacción (`linkExecutionInTx`) solo cuando los efectos reales quedaron registrados.
- **Integridad** (`integrity.checks.ts`): diagnóstico de SOLO LECTURA en REPEATABLE READ; nunca repara ni crea movimientos; una comprobación que no corrió es NOT_EVALUATED. Deudas/obligaciones pendientes, transferencias por verificar y fichas en circulación son estados legítimos (INFO), no errores.
- **Incidencias**: nunca se borran; historial inmutable; una abierta por huella de hallazgo (sin duplicados); resolver exige `incidents:resolve` y resolución escrita.
- **Respaldos**: instantánea lógica consistente (base + `evidence_blobs` en un mismo punto) cifrada AES-256-GCM, con manifiesto y checksums, ejecutada SOLO por CLI (`npm run backup:daily`), nunca por HTTP. Nunca registrar SUCCESS sin artefacto, checksum y verificación; nunca declarar la automatización activa sin respaldos SCHEDULED reales. Claves y cadenas de conexión jamás en la base, el manifiesto ni la interfaz (solo huella/nombres).
- **Restauración y recuperación**: siempre en una base DISTINTA del origen (prueba: `RESTORE_TEST_DATABASE_URL`; recuperación: base NUEVA con «recovery»); solo SUPERADMIN (`recovery:manage`) con contraseña, prueba aislada aprobada y modo mantenimiento (la API responde 503 a escrituras). La ejecución es CLI (`npm run recovery:execute`); el cambio de conexión es manual (`docs/DISASTER_RECOVERY_RUNBOOK.md`).

### Operaciones financieras especiales (Módulo 16) — reglas permanentes

- **Lo original es inmutable**: corregir = movimientos NUEVOS (entrada nominal, aplicaciones/contraaplicaciones, obligaciones `special_payables`, asientos por `postTransactionInTx`). La compra solo pasa CONFIRMED → REVERSED con un `purchase_reversals` registrado (trigger); liquidaciones, firmas, comprobantes, cajas y snapshots de cierre nunca se editan; una sesión CLOSED nunca se reabre ni recibe asientos.
- **Autorizar ≠ ejecutar**: reverso de compra, corrección de liquidación y devolución de fondos exigen una `CorrectionRequest` APROBADA por PARTNER/SUPERADMIN (`requireApprovedCorrectionInTx`); el valor de un canje lo valida `special-ops:authorize`. CASHIER solicita y ejecuta lo autorizado, nunca autoriza.
- **Nunca registrar fichas ni dinero no recibidos o no pagados**: canje y reverso exigen recepción FÍSICA declarada (el reverso, del valor completo; si falta, `PURCHASE_REVERSAL_BLOCKED` sin movimientos). Una obligación solo cuenta como pagada con pagos EXECUTED (efectivo entregado o transferencia confirmada con referencia); una transferencia PENDING compromete pero no paga. Estados parciales explícitos.
- **Pagos especiales** solo por `registerSpecialPayout`/`resolveSpecialPayout`: custodia administrativa del pagador, banco, o la caja de la sesión de origen SOLO si sigue OPEN. Nunca más que lo pendiente (servicio + trigger). Sin saldo negativo de efectivo.
- **Reverso de compra**: extingue el saldo de la deuda SIN dinero (aplicación `PURCHASE_REVERSAL`) y reembolsa solo el dinero REALMENTE pagado (efectivo, terminal, transferencias verificadas, abonos y compensaciones de esa deuda); extinción + reembolso = valor de la compra. La deuda de una compra revertida queda cerrada (trigger). Participación ya liquidada → corregir la liquidación, no la compra.
- **Corrección de liquidación**: firma del jugador obligatoria; `OFFSET_REVERSAL` (contraasientos FIFO + obligación por el mismo valor, sin efectivo; una por liquidación) o `ADDITIONAL_PAYOUT`. Reclamar dinero pagado de más NO está implementado.
- **Fondos no aplicados**: se devuelven por exactamente lo recibido; nunca son saldo a favor ni se aplican a deudas futuras.
- Detalle: `docs/MODULE_16_SPECIAL_OPERATIONS.md`.

### Mesa interactiva — asientos, dealer y paño — reglas permanentes

- **La mesa es el centro operativo, no un atajo**: sentar, comprar, recomprar, liquidar, cambiar de asiento y transferir desde la mesa usan los MISMOS servicios de los Módulos 07–11 (sin endpoints nuevos de compras, firmas, créditos ni liquidaciones). Lo que se ve lo decide el servidor (`GET …/tables/:tableId/seats`); el éxito se muestra solo con su respuesta.
- **Nueve asientos fijos** (`SEAT_LAYOUT`): 1-2-3 arriba, 4-5 derecha, 6-7 abajo, 8-9 izquierda; numeración estable. `TableSeatAssignment` con índices únicos parciales (un ocupante por asiento del ciclo, un asiento por participación) e historial inmutable (cambiar de asiento = liberar + nueva fila enlazada). Toda salida de ACTIVE libera el asiento en la misma transacción (`releaseSeatInTx`; la base lo exige).
- **Sentar no compra**: el jugador queda «pendiente de compra» (estado DERIVADO: sin compra CONFIRMED en su cadena de participaciones); sin compra, crédito, firma, fichas ni dinero. Inicial vs recompra lo decide el Módulo 08 al confirmar (`nextPurchaseNumber`, por sesión y jugador); la UI solo lo proyecta.
- **Retiro sin compra** (`WITHDRAWN`) solo si nunca recibió fichas (trigger); si recibió fichas, su salida es una liquidación.
- **Dealer = persona** (`Dealer`, sin usuario, rol ni asiento; sin compras, deudas ni liquidaciones). Asignación por ciclo (`DealerAssignment`): una vigente por ciclo y por dealer; cambiar = CHANGED + nueva; cerrar la mesa la libera (CYCLE_CLOSED). Va DENTRO del óvalo entre los asientos 7 y 6. **No** implementar botón «D», rotación, manos ni ciegas por dealer sin una decisión de negocio.
- **Paño** (`PokerTable.feltColor`): paleta cerrada con contraste AA probado, por mesa, solo visual. Sin colores libres.
- Permisos existentes (`sessions:manage` para asientos, dealer y paño); auditoría `SEAT_*`, `PLAYER_SEATED_PENDING_BUY`, `TABLE_PARTICIPATION_WITHDRAWN`, `DEALER_*`, `TABLE_FELT_COLOR_CHANGED` dentro de la transacción.
- Detalle: `docs/POKER_TABLE_UX_REDESIGN.md`.

Detalle completo: `docs/BUSINESS_RULES.md`, `docs/MODULE_05_CASH_BOX.md`, `docs/MODULE_06_SESSIONS.md`, `docs/MODULE_07_TABLES.md`, `docs/MODULE_08_PURCHASES.md`, `docs/MODULE_09_SIGNATURES_RECEIPTS.md`, `docs/MODULE_10_CREDITS.md`, `docs/MODULE_11_SETTLEMENTS.md`, `docs/MODULE_12_CLOSURE.md`, `docs/MODULE_14_REPORTS.md`, `docs/MODULE_15_AUDIT_ADMIN_BACKUP.md`, `docs/MODULE_16_SPECIAL_OPERATIONS.md`, `docs/POKER_TABLE_UX_REDESIGN.md` y `docs/SESSION_FOLIO_AND_HISTORICAL_ENTRY.md` (más `docs/BACKUP_SETUP.md` y `docs/DISASTER_RECOVERY_RUNBOOK.md`).

## Reglas técnicas

- Migraciones de Prisma siempre versionadas y commiteadas (`prisma/migrations/`).
- Toda entrada externa se valida con Zod (`src/lib/validation.ts`) antes de tocar la base de datos.
- Los permisos se verifican **en el servidor** (`src/config/permissions.ts`), nunca solo ocultando botones en el cliente. Un usuario nunca puede autoasignarse un rol vía parámetro de cliente.
- Autoriza por **capacidad**: `requirePermission(PERMISSIONS.X)` en endpoints y `requirePagePermission(PERMISSIONS.X)` en páginas. Nunca `role === "..."` disperso. La matriz rol → permisos vive solo en `src/config/permission-matrix.ts` (denegado por defecto). Ver `docs/ROLES_AND_PERMISSIONS.md`.
- El rol y estado vigentes se leen de la base en cada request (`getCurrentUser` → `loadSessionUser`); el JWT solo identifica. Cambios de rol, desactivación o de contraseña incrementan `User.sessionVersion` (revoca sesiones). Ver `docs/AUTHENTICATION.md`.
- Schemas Zod de entrada como `z.strictObject`: un campo no previsto (p. ej. `role`) es 400, no se ignora.
- Nunca devolver `passwordHash`/`sessionVersion`: lecturas de usuario siempre con `publicUserSelect` (`src/modules/users/user.dto.ts`).
- `audit_logs` es de solo inserción (trigger en BD). Las mutaciones administrativas auditan dentro de su misma transacción.
- Catálogos de configuración: sin `DELETE` (activar/desactivar), códigos internos inmutables, montos como string en la API y `Decimal` en la base (`src/lib/money.ts`). Reglas fijas en `src/config/operational-rules.ts`. Folios solo con `issueFolio(tx, tipo)` dentro de la transacción del documento.
- Datos bancarios cifrados (`src/lib/crypto.ts`, `SETTINGS_ENCRYPTION_KEY`); nunca devolver números completos.
- Enlaces con estilo de botón: `<Link className={buttonVariants()}>`, nunca `<Button render={<Link/>}>`.
- Pruebas de integración (`npm run test:integration`) y E2E con sesión real requieren `TEST_DATABASE_URL` local desechable: PostgreSQL 16 en Docker (`npm run test:db:up`), nunca Neon — ver `docs/SETUP.md`. PGlite (`prisma dev`) no sirve para pruebas de concurrencia.
- Dinero: siempre `Decimal` de Prisma — **nunca** `Float`/`number` de JS para cálculos financieros.
- Fichas: siempre enteros no negativos (`src/lib/validation.ts#nonNegativeInt`).
- Operaciones que mueven dinero o fichas van en una transacción de Prisma (`$transaction`).
- Las operaciones deben ser idempotentes cuando el negocio lo requiera (p. ej. bootstrap de SUPERADMIN).
- Toda acción relevante del negocio se audita en el modelo `AuditLog` — nunca loguear contraseñas, tokens ni secretos ahí ni en `src/lib/logger.ts`.
- Cobertura de pruebas: unitarias (Vitest) para lógica de validación/errores/permisos/utilidades, E2E (Playwright) para flujos de navegación críticos.
- Nunca exponer secretos con el prefijo `NEXT_PUBLIC_`.
- Mantener compatibilidad Mobile First en cualquier pantalla nueva.
- No introducir una dependencia nueva sin justificarla (ver sección "No utilizar" en `docs/ARCHITECTURE.md`).

## Flujo de trabajo

Antes de modificar código existente:

1. Revisa los archivos relacionados (el módulo de dominio, sus tipos, sus tests).
2. Identifica qué otros módulos dependen de lo que vas a cambiar.
3. Verifica qué reglas de negocio/técnicas de este documento aplican.
4. Implementa el cambio.
5. Corre `npm run lint && npm run typecheck && npm test` (y `npm run test:integration` + `npm run test:e2e` con `TEST_DATABASE_URL` si el cambio toca servicios, navegación o auth).
6. Documenta el cambio (README/docs/comentarios) si alteró una decisión arquitectónica.

No modifiques un módulo ya cerrado/entregado sin una razón técnica explícita y documentada en el commit.

## Estado actual

- Módulos 00 a 12, 14, 15 y 16 completados (infraestructura, usuarios y seguridad, configuración, jugadores, inventario de fichas, caja central, sesiones y apertura, mesas y participación, compras y recompras, firmas y comprobantes, créditos y abonos, liquidaciones, cierre de mesas y sesiones, reportes y estadísticas con exportación XLSX, auditoría/administración/integridad/incidencias/respaldos/recuperación, operaciones financieras especiales) — ver `docs/MODULES.md` y `docs/MODULE_*.md`. El Módulo 13 (WhatsApp) está en pausa.
- Correcciones aplicadas (también en Neon): inventario físico compartido (`20261018120000_shared_chip_inventory`) e inventario operativo por valor nominal (`20261019120000_nominal_chip_inventory`).
- WhatsApp en `PENDING_CONFIGURATION` por diseño (número exclusivo pendiente; integración en el Módulo 13).
- Pendiente operativo: capturar las denominaciones reales del inventario común y registrar su inventario inicial (sin eso no se puede abrir ninguna sesión).
- Almacenamiento de evidencias: driver privado en PostgreSQL (no hay credenciales de almacenamiento de objetos; un driver S3/R2 se agrega con la misma interfaz cuando existan).
- Pendientes reales: reclamar al jugador dinero pagado de más en una liquidación (NOT_IMPLEMENTED, requiere decisión de negocio). Migraciones de los Módulos 11, 12 y 14 aplicadas en Neon el 2026-10-20; y las del Módulo 15 (`20261028120000_module15_enums`, `20261028130000_module15_audit_admin_backup`) el 2026-10-21 (esquema verificado sin diferencias). Migraciones del Módulo 16 (`20261029120000_module16_enums`, `20261029130000_module16_special_operations`) aplicadas en Neon el 2026-10-21 (esquema verificado sin diferencias). Respaldos diarios: CONFIGURACIÓN PENDIENTE (destino, clave y tarea programada; ver `docs/BACKUP_SETUP.md`).
- Rediseño de la mesa interactiva (asientos, dealer como persona, paño, compra/liquidación rápidas) implementado y probado localmente. Migraciones `20261030120000_table_floor_enums` y `20261030130000_table_floor` aplicadas en Neon el 2026-10-23 (esquema verificado sin diferencias).
- Folios de sesión `S-0001-YYYYMMDD` y captura histórica (SUPERADMIN) implementados y probados localmente. Migraciones `20261031120000_session_folio_enums` y `20261031130000_session_folio_historical` aplicadas en Neon el 2026-10-23 (esquema sin diferencias; `SES-000001` → `S-0001-20261022`).
- Siguiente: el Módulo 13 — WhatsApp se retoma cuando exista el número exclusivo.
