# Base de datos — Neon + Prisma

## Proveedor

PostgreSQL alojado en [Neon](https://neon.tech). No se usa la base administrada de Prisma (Prisma Postgres) ni Supabase/Firebase.

## Dos cadenas de conexión — por qué

Neon ofrece una conexión **pooled** (vía PgBouncer, puerto con sufijo `-pooler`) y una **directa**. Prisma 7 las usa en lugares distintos:

| Variable       | Conexión              | Usada por                                                                                       |
| -------------- | --------------------- | ----------------------------------------------------------------------------------------------- |
| `DATABASE_URL` | Pooled                | El runtime de la app (`src/lib/prisma.ts`, vía `PrismaPg` adapter)                              |
| `DIRECT_URL`   | Directa (sin pooling) | El motor de migraciones (`prisma migrate`, `prisma studio`) — configurado en `prisma.config.ts` |

Usar la conexión pooled para migraciones puede fallar (PgBouncer en modo transacción no soporta algunas operaciones DDL/prepared statements que Migrate necesita) — por eso Neon recomienda separar ambas, y así quedó configurado.

## Cómo obtener las credenciales (si no las tienes)

1. Crea una cuenta/proyecto en [neon.tech](https://neon.tech).
2. En el dashboard del proyecto → **Connect** → copia:
   - **Pooled connection** → `DATABASE_URL`
   - **Direct connection** → `DIRECT_URL`
3. Pégalas en tu `.env.local` (nunca en `.env` ni en un archivo versionado).

**Nadie debe inventar estas URLs.** Si no las tienes, todo lo que no dependa de una conexión real ya está implementado (ver reporte del Módulo 00) — migra y haz seed en cuanto las tengas.

## Prisma 7: dónde vive cada cosa

- `prisma/schema.prisma`: solo modelos + `datasource { provider = "postgresql" }` (sin `url`/`directUrl` — Prisma 7 los rechaza aquí, ver `docs/ARCHITECTURE.md`).
- `prisma.config.ts`: `datasource.url` (usa `DIRECT_URL`, para Migrate/Studio), ruta de `schema` y de `migrations`.
- `src/lib/prisma.ts`: el `PrismaClient` de runtime, construido perezosamente con `new PrismaPg({ connectionString: DATABASE_URL })`.

## Generar el cliente

```bash
npm run db:generate
```

Se genera en `src/generated/prisma/` (ignorado por git — se regenera en cada instalación/build vía este script; no se versiona).

## Migraciones

```bash
npm run db:migrate   # desarrollo: crea y aplica una migración nueva
npm run db:deploy    # producción: aplica migraciones pendientes sin generar nuevas
npm run db:studio    # explorador visual de la base
```

## Modelos (Módulos 00–07)

- `User` (`@@map("users")`): `id`, `name`, `email` (único), `passwordHash`, `role` (`Role`: `SUPERADMIN`/`PARTNER`/`CASHIER`), `isActive`, `createdAt`, `updatedAt`, `lastLoginAt?`; desde el Módulo 01: `mustChangePassword` (credencial temporal pendiente), `passwordChangedAt?`, `sessionVersion` (revocación de sesiones), `createdById?`/`updatedById?` → `User`. Nunca se borra físicamente.
- `AuditLog` (`@@map("audit_logs")`): `id`, `actorUserId?` → `User`, `action`, `entityType`, `entityId?`, `result` (`AuditResult`: `SUCCESS`/`FAILURE`/`DENIED`), `requestId?`, `metadata` (`Json?`), `createdAt`. **Nunca** contiene contraseñas/tokens/secretos. **Solo inserción**: un trigger (`audit_logs_immutable`) rechaza `UPDATE`/`DELETE`.
- `LoginThrottle` (`@@map("login_throttles")`): `key` (`email:<sha256>` / `ip:<ip>` / `password-change:<userId>`), `failures`, `windowStartedAt`, `lockedUntil?`, `updatedAt`. Limitador de intentos de login — ver `docs/AUTHENTICATION.md`.

- Módulo 02 (configuración, sin saldos ni movimientos): `BusinessSettings` (singleton), `CashBox` (única, `MAIN`), `ChipSet` (un solo activo: índice `chip_sets_single_active`; `CHIPSET_MAIN` compartido por todas las mesas), `ChipDenomination` (`Decimal(12,2)`, único por juego), `PokerTable` (ciegas `Decimal`, apunta al inventario compartido), `PaymentMethod` (`CASH`/`BANK_TRANSFER`; desde el Módulo 08 también `CARD_DEBIT`/`CARD_CREDIT`), `PaymentAccount` (cifrada, única activa y principal), `FolioSequence`, `OperationalSettings` (singleton), `WhatsAppSettings` (singleton, sin secretos). Restricciones `CHECK`/índices parciales y detalle en `docs/MODULE_02_CONFIGURATION.md`.

- Módulo 03 (jugadores, sin deudas ni saldos): `Player` (teléfono E.164 `UNIQUE` + `CHECK`, `countryCode` ISO, sin campos financieros), `PlayerPhoneHistory` y `PlayerNotificationConsent` (ambos de solo inserción con trigger). Ver `docs/MODULE_03_PLAYERS.md`.

- Módulo 04 (inventario físico de fichas, sin dinero): `ChipContainer` (una ubicación activa: `INVENTARIO-GENERAL`), `ChipSetInventoryState` (bloqueo y versión del inventario), `ChipInventoryBalance` (proyección por ubicación, denominación y estado, con CHECKs), `ChipInventoryOperation` + `ChipInventoryMovement` (libro inmutable, idempotencia; `tableId`/`sessionId`/`playerId` de trazabilidad), `ChipStockCount` + `ChipStockCountDetail` (arqueos con snapshot inmutable) y `ChipReservation` + `ChipReservationItem` (con mesa/sesión/jugador). Ver `docs/MODULE_04_CHIP_INVENTORY.md`.

- Módulo 05 (caja central, libro financiero): `FinancialAccount` (cuentas técnicas por `kind`: 9 en el Módulo 05 + `CARD_TERMINAL_CLEARING` en el Módulo 08), `FinancialAccountBalance` (proyección por cuenta y `scopeKey`: id de sesión para efectivo, `GLOBAL` para el resto; CHECK de no negativos), `CashTransaction` + `CashTransactionEntry` (libro de partida doble inmutable: trigger de cuadre diferido, triggers de solo inserción, idempotencia, reverso único, asiento único por operación de origen), `BankTransferVerification` (pendiente → confirmada/rechazada/cancelada; inmutable al resolverse), `CashReconciliation` + `CashReconciliationDetail` (arqueos de efectivo; apertura con esperado 0). `OperationalSettings` agrega `openingCashBalance` (0), `requireOpeningCashFund`, `carryCashToNextSession`, `allowNegativeCashBalance` (todos `false`, fijados por CHECK). Ver `docs/MODULE_05_CASH_BOX.md`.

- Corrección nominal: `ChipSetInventoryState` agrega `custodyNominal`, `reservedNominal`, `circulationNominal` (CHECK: no negativos y reservado ≤ custodia) y `breakdownExact`; nuevo libro inmutable `ChipNominalMovement`; `ChipStockCount` agrega `breakdownExact`, `resultingInventoryVersion` (vigencia) y `compositionOperationId`; `ChipReservation.amount` (reserva por importe).

- Módulo 06 (sesiones): `PokerSession` (folio único, creador inmutable, estados `PokerSessionStatus`; índice parcial `poker_sessions_single_active`; trigger de transiciones e inmutabilidad), `SessionOpening` (evidencia única por sesión, referencia al arqueo de fichas y al de efectivo, `openingCashAmount = 0` por CHECK, solo inserción) y `SessionStatusHistory` (solo inserción). Ver `docs/MODULE_06_SESSIONS.md`.

- Módulo 07 (mesas y participación): `SessionTable` (único por sesión y mesa), `SessionTableCycle` (consecutivo único, un OPEN por mesa, fotografía de ciegas, cerrados inmutables), `TableParticipation` (una ACTIVE por jugador y sesión, `SETTLING`/`SETTLED ⇒ settlementId` con FK a la liquidación desde el Módulo 11, sin DELETE) y `TableTransfer` (solo inserción, origen ≠ destino). Ver `docs/MODULE_07_TABLES.md`.

- Módulo 08 (compras por importe): `ChipPurchase` (folio, sesión/mesa/ciclo/participación/jugador inmutables, `nominalAmount > 0`, estados `ChipPurchaseStatus`, `version` del resumen, numeración `sequenceNumber`/`purchaseType`/`rebuyNumber` con CHECK y único parcial por sesión y jugador; trigger: nace en DRAFT y confirmada/cancelada es inmutable), `PurchasePayment` (componentes por método con CHECK de estado por método, tarjeta aprobada con folio, asiento y liquidación de terminal fijados una sola vez; trigger de transiciones), `PurchaseCreditAuthorization` (socio, medio VERBAL/MESSAGE, importe calculado, versión; una ACTIVE y una USED por compra; solo cambia el estado), `PurchaseDelivery` (una por compra, referencia a la operación nominal y a la reserva; CHECK pagos + saldo = importe y **saldo por cobrar ⇒ firma**), `PurchaseStatusHistory` y `PurchaseReversalRequest` (solo inserción; una solicitud abierta por compra), `PlayerDebt` (deuda inmutable con saldo derivado), `NotificationOutbox` (evento deduplicado; solo cambia su estado de procesamiento) y `CardTerminalSettlement` (depósito de terminal, diferencia = bruto − depositado, inmutable). Sin campos de denominaciones. Ver `docs/MODULE_08_PURCHASES.md`.

- Módulo 09 (firmas y comprobantes): `SignatureSnapshot` (resumen exacto mostrado al jugador, `contentHash`/`payloadHash` SHA-256 canónicos, único por compra y contenido; CHECK pagos + crédito = importe y crédito > 0; inmutable), `PurchaseSignature` (una por snapshot, una VALID por compra por índice parcial; trigger: nace VALID ligada a la compra y jugador del snapshot, solo pasa a INVALIDATED/CANCELLED con motivo y responsable, nunca después de usarse en una entrega), `StoredFile` (metadatos de evidencia privada: clave aleatoria, SHA-256, MIME, tamaño ≤ 1 MB; PENDING → ACTIVE/ORPHANED; sin DELETE), `EvidenceBlob` (contenido binario privado; sin UPDATE; no se borra si es evidencia ACTIVE) y `PurchaseReceipt` (uno por compra, solo para CONFIRMED, contenido JSON + huella inmutables; solo AVAILABLE → VOIDED). `PurchaseDelivery.signatureId` es FK a `PurchaseSignature` y un trigger exige que sea una firma VALID de la misma compra. Ver `docs/MODULE_09_SIGNATURES_RECEIPTS.md`.

- Módulo 10 (créditos y abonos): `PlayerDebt` sigue siendo la cuenta por cobrar (inmutable). Nuevos: `ReceivablePayment` (abono: SESSION con `sessionId` / ADMINISTRATIVE sin sesión; efectivo administrativo con custodio; PENDING → CONFIRMED/REJECTED, CONFIRMED → REVERSED; trigger de inmutabilidad), `PaymentAllocation` (libro de solo inserción: APPLICATION/REVERSAL por fuente RECEIVABLE_PAYMENT, PURCHASE_PAYMENT o CHIP_SETTLEMENT_OFFSET; trigger que impide aplicar más que la deuda o que el abono, o dejar saldo negativo; reverso único por aplicación), `ReceivablePaymentReversal`, `UnappliedPlayerFunds` (dinero real no aplicable, por devolver; uno por transferencia), `AdministrativeCashDeposit` y `ReceivablePaymentReceipt` (solo para abonos CONFIRMED; contenido inmutable). Cuentas nuevas `ADMIN_CASH_CUSTODY` (alcance `CUSTODIAN`, no negativa) y `UNAPPLIED_PLAYER_FUNDS`. Ver `docs/MODULE_10_CREDITS.md`.

- Mesa interactiva (ver `docs/POKER_TABLE_UX_REDESIGN.md`): `TableSeatAssignment` (asiento 1..9 de una participación ACTIVE en el ciclo vigente; únicos parciales por asiento del ciclo y por participación; liberación con motivo `SeatReleaseReason`; historial inmutable con `previousAssignmentId`), `Dealer` (persona sin cuenta; sin DELETE; no se desactiva asignado), `DealerAssignment` (por ciclo; únicos parciales por ciclo y por dealer; liberación `DealerReleaseReason`), `PokerTable.feltColor` (`TableFeltColor`, por defecto `CASINO_GREEN`) y `ParticipationStatus.WITHDRAWN` (retiro sin compra; trigger que exige que nunca haya recibido fichas). Triggers: una participación no sale de ACTIVE con asiento ocupado; un ciclo no se cierra con asientos ocupados ni dealer vigente.

Migraciones: `20261013044915_init` (Módulo 00), `20261013180000_module01_security` (Módulo 01), `20261014120000_module02_configuration` (Módulo 02), `20261015120000_module03_players` (Módulo 03), `20261016120000_module04_chip_inventory` (Módulo 04), `20261017120000_module05_cash_box` (Módulo 05) `20261018120000_shared_chip_inventory` (corrección: inventario compartido), `20261019120000_nominal_chip_inventory` (corrección: saldo nominal; inicializa el saldo con el valor de las existencias registradas), `20261020120000_module06_sessions`, `20261021120000_module07_tables`, `20261022120000_module08_payment_enums` (valores de enum, en migración aparte para poder usarlos en CHECKs), `20261022130000_module08_purchases`, `20261023120000_module09_signatures_receipts`, `20261024120000_module10_enums`, `20261024130000_module10_credits`, `20261025120000_module11_enums`, `20261025130000_module11_settlements`, `20261026120000_module12_enums`, `20261026130000_module12_closure` (no cierra ni modifica sesiones existentes, ni toca compras, deudas o saldos) `20261027120000_module14_report_indexes` (Módulo 14: solo nueve índices de lectura para reportes; no crea tablas ni toca datos), `20261028120000_module15_enums` y `20261028130000_module15_audit_admin_backup` (Módulo 15: columnas nuevas opcionales en `audit_logs`, tablas de proceso y siembra idempotente de folios COR-/INC- y del modo mantenimiento; no toca saldos ni movimientos), `20261029120000_module16_enums` y `20261029130000_module16_special_operations` (Módulo 16: tablas nuevas, `payment_allocations.purchaseReversalId`, reemplazo de `chip_purchases_guard` y `payment_allocations_guard` con las reglas previas intactas más el paso CONFIRMED → REVERSED con reverso registrado y el cierre de la deuda de una compra revertida, y siembra idempotente de folios CAN-/REV-/AJL-/PES-; no toca datos existentes), `20261030120000_table_floor_enums` y `20261030130000_table_floor` (mesa interactiva: tablas de asientos y dealers, color de paño con valor por defecto y estado `WITHDRAWN`; no toca datos existentes). Todas son aditivas; la del Módulo 05 además convierte el valor `NEW_FUND_PER_SESSION` en `ZERO_OPENING_BALANCE` (el enum se reemplaza tras convertir los datos, sin borrar filas). La de inventario compartido crea `CHIPSET_MAIN` + `INVENTARIO-GENERAL`, reasigna las mesas, **desactiva** (no borra) los juegos y maletines por mesa y sus denominaciones, deja constancia en `audit_logs` (`CHIP_INVENTORY_CONSOLIDATED`, con las denominaciones previas) y **se detiene** si esos juegos tuvieran existencias, movimientos, arqueos o reservas: nunca suma ni fusiona inventarios automáticamente.

## Seed

`npm run db:seed` (carga `.env.local` si existe) es **idempotente**:

1. Siempre: configuración inicial del Módulo 02 (`src/modules/settings/configuration.seed.ts`, incluido el inventario único `CHIPSET_MAIN` y las mesas apuntando a él), la ubicación `INVENTARIO-GENERAL` del Módulo 04 (`src/modules/inventory/inventory.seed.ts`), sin cantidades, y las cuentas financieras del Módulo 05 (`src/modules/cash/cash.seed.ts`), sin saldos ni movimientos.
2. Opcional: el primer SUPERADMIN, solo si se definen `SEED_SUPERADMIN_NAME`, `SEED_SUPERADMIN_EMAIL` y `SEED_SUPERADMIN_PASSWORD` y no existe ya uno.

No siembra denominaciones, cantidades, importes, saldos, movimientos, aportaciones, transferencias, datos bancarios, teléfonos, tokens ni **jugadores**. Los jugadores de prueba se crean con factories solo en la base de pruebas (`tests/integration/helpers.ts`, `tests/e2e/players.spec.ts`), con teléfonos sintéticos.

- Módulo 11 (liquidaciones): `PlayerSettlement` (valor nominal devuelto ≥ 0, decisión de compensación explícita, importes fijados al recibir con CHECKs de coherencia — neto = devuelto − compensación, compensación ≤ fichas y ≤ deuda, entrada nominal ⇔ devuelto > 0 —; una viva por participación; trigger de transiciones e inmutabilidad tras la recepción), `SettlementStatusHistory` (solo inserción), `SettlementSignatureSnapshot` (contenido canónico + huellas, inmutable) y `SettlementSignature` (una VALID por liquidación; la recepción solo usa una firma VALID de la misma liquidación), `SettlementPayable` (cuenta por pagar, original ≥ 0, estado derivado), `SettlementPayout` (efectivo EXECUTED con asiento / transferencia PENDING → EXECUTED/FAILED/CANCELLED; trigger: PENDING + EXECUTED ≤ original), `SettlementReceipt` (una RECEPTION por liquidación + un PAYOUT por desembolso; inmutable), `SettlementReversal` y `AdministrativeCashContribution` (solo inserción). `PaymentAllocation.settlementId`, `StoredFile.settlementId` y `TableParticipation.settlementId` tienen FK; trigger que impide compensar más que lo devuelto; política de reingreso con SETTLING. Ver `docs/MODULE_11_SETTLEMENTS.md`.

- Módulo 12 (cierre): `SessionClosure` (intento de cierre IN_PROGRESS → RETURNED_TO_OPEN/COMPLETED; un intento en curso y un completado por sesión por índices parciales; CHECK de coherencia y guarda de inmutabilidad), `ClosureStatusHistory` y `ClosurePrecheck` (solo inserción), `ClosureDiscrepancy` (diferencia FÍSICA de un arqueo de cierre, única por arqueo; CHECK diferencia = contado − esperado; importes inmutables; OPEN → RESOLVED una vez con RECOUNT/RETURNED_TO_OPEN/AUTHORIZED_ADJUSTMENT), `ClosureAdjustmentAuthorization` (una por discrepancia; referencia a la operación de inventario o al asiento de efectivo), `ClosureCashWithdrawal` (retiro final > 0 con receptor; uno por intento), `ClosureApproval` (una por sesión, con la huella del resumen revisado y los arqueos finales) y `ClosureReport` (folio `CIE-`, snapshot + huella, inmutable). Valor `SUPERSEDED` en `ChipReconciliationStatus` y `CashDifferenceStatus` (diferencia sustituida por recuento o regreso a OPEN, sin ajuste). Triggers: `poker_sessions_guard` admite CLOSING → OPEN; `cash_entries_closed_session_guard` impide partidas de efectivo en sesiones CLOSED/CANCELLED. Ver `docs/MODULE_12_CLOSURE.md`.
- Módulo 14 (reportes): **sin modelos nuevos** (capa de solo lectura; no hay tablas de estadísticas ni saldos materializados). Índices: `player_debts(createdAt)`, `player_debts(tableId)`, `receivable_payments(sessionId)`, `payment_allocations(source, allocatedAt)`, `chip_purchases(cycleId)`, `chip_purchases(confirmedAt)`, `player_settlements(cycleId)`, `cash_transactions(confirmedAt)`, `chip_stock_counts(status, confirmedAt)`. Ver `docs/MODULE_14_REPORTS.md`.
- Módulo 15 (auditoría y administración): `audit_logs` ampliada (`actorRole`, `module`, `sessionId`, `tableCycleId`, `playerId`, `idempotencyKey`, `reason`, `relatedEventId`, `amount`, `evidenceRef`); `CorrectionRequest`/`CorrectionApproval`/`CorrectionEvent`, `IntegrityCheckRun`/`IntegrityFinding`, `OperationalIncident`/`IncidentHistory`, `BackupExecution`/`BackupArtifact`, `RestoreValidation`, `RestoreRequest`, `SystemMaintenance`. Triggers de solo inserción en historiales y de no borrado en procesos; CHECKs (EXECUTED con referencia, SUCCESS con artefacto, COMPLETED con evidencia); índices únicos parciales (una ejecución en curso por proceso, una solicitud activa por movimiento, una incidencia abierta por huella). Ver `docs/MODULE_15_AUDIT_ADMIN_BACKUP.md`.
- Módulo 16 (operaciones especiales): `LateChipRedemption`, `SpecialPayable`/`SpecialPayout` (obligaciones con saldo DERIVADO y pagos reales), `PurchaseReversal`, `SettlementCorrection`, `SpecialOperationEvidence`, `SpecialOperationReceipt`. Triggers: hechos ejecutados, evidencias y comprobantes de solo inserción; canje sin cambios tras recibir; obligación con importe/origen inmutables; pagos que nunca comprometen más que la obligación (PENDING + EXECUTED), inmutables al resolverse y EXECUTED ⇒ asiento. Índice parcial: una compensación revertida por liquidación. Ver `docs/MODULE_16_SPECIAL_OPERATIONS.md`.

Los reportes globales se agregan en módulos siguientes — ver `docs/MODULES.md`.

## Backups

Neon mantiene point-in-time recovery según el plan de tu proyecto (revisa el dashboard de Neon → Settings → Backups/Restore). No hay un mecanismo de backup adicional implementado en la aplicación — queda fuera de alcance del Módulo 00.

## Qué NO hacer

- No ejecutar `prisma migrate dev` ni `db push` contra una base de producción.
- No commitear `.env`/`.env.local` con credenciales reales.
- No usar `DATABASE_URL` (pooled) para migraciones.
