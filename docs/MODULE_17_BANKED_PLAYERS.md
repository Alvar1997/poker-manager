# Módulo 17 — Jugadores bancados por la casa (PRIVADO)

Jugadores que juegan con fichas **financiadas por la casa**: ciclos de **cuatro jugadas**, compensación de ganancias y pérdidas, reserva positiva, pérdidas arrastradas, anticipos, cortes con aprobación digital, pagos y retiros de reserva. Código: `src/modules/banking/*`; pantallas `/dashboard/administracion/bancaje/*`; API `/api/admin/banking/*`; migraciones `20261101120000_module17_enums` y `20261101130000_module17_banked_players`.

**Estado:** IMPLEMENTED y TESTED en local (unitarias, integración con noches reales y E2E Chrome + iPhone). Migraciones aplicadas en Neon el 2026-10-23 (esquema verificado sin diferencias).

## 1. Privacidad

- La condición de bancado vive SOLO en la sección privada (`banking:read`). La mesa de nueve asientos (`GET …/tables/:tableId/seats`), las compras, la auditoría general, los reportes generales, los comprobantes y las incidencias **no** la revelan: el bancado se ve exactamente igual que un jugador que pagó (mismo estado de asiento, mismas clases, misma estructura JSON; probado en integración y E2E).
- `ChipPurchase.fundingSource` (`PLAYER`/`HOUSE`) y `TableParticipation.bankingGameId` existen en la base pero **nunca se proyectan** en vistas compartidas (`toView`, tablero, listados).
- Las compras financiadas usan la auditoría ORDINARIA del Módulo 08 sin datos del financiamiento; los detalles van en eventos `BANKING_*` del módulo `BANKING`, que la auditoría general oculta sin `banking:read`.
- Los asientos de caja y comprobantes de pagos usan la etiqueta neutra «pago administrativo»; las incidencias y comprobaciones de integridad hablan de «registros administrativos».
- Las obligaciones `BANKING_*` (Módulo 16) no aparecen en el panel de Operaciones especiales ni en el reporte financiero general, y los endpoints generales `/api/special-operations/payables/:id` y `/payouts` las rechazan.
- No hay acciones de bancaje en los menús de la mesa. Si se intenta una compra o liquidación ordinaria sobre una jugada financiada, el servidor responde con un mensaje neutro («registro administrativo… desde Administración»).
- WhatsApp (Módulo 13) sigue pausado: no se genera ninguna notificación de bancaje.

## 2. Permisos

| Permiso                                                                                                                                                                             | SUPERADMIN | PARTNER | CASHIER |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------- | ------- |
| `banking:read` (consultar)                                                                                                                                                          | ✅         | ✅      | ✅      |
| `banking:operate` (compras financiadas, conciliación, discrepancias, anticipos con autorizador verbal/mensaje, pagos reales, preparar cortes, solicitar cambios y retiros)          | ✅         | ✅      | ✅      |
| `banking:approve` (aprobación DIGITAL: acuerdos, cambios de %, cortes, retiros, regularizaciones, aclarar discrepancias, ajustes de jugadas, distribución de pérdidas entre tramos) | ✅         | ✅      | ❌      |

El aprobador digital es siempre el usuario con sesión iniciada (nunca un nombre capturado). `approveClosing` vuelve a validar el rol en el servicio y audita el rechazo (`BANKING_CLOSING_APPROVAL_DENIED`, resultado DENIED). Zod `strictObject`: un campo inventado (p. ej. `approvedById`) es 400.

## 3. Acuerdos y porcentajes

- `BankingAgreement` (uno ACTIVO por jugador: índice parcial) + `BankingAgreementVersion` inmutables (jugador + casa = 100, 0–100 con 2 decimales, CHECK).
- Cambio de porcentaje: `BankingPercentageChangeRequest` (CASHIER solicita, PARTNER/SUPERADMIN aprueba o rechaza digitalmente) con modalidad **WHOLE_CYCLE** (todo el ciclo actual) o **FROM_NEXT_GAME** (desde la siguiente jugada). Guarda porcentaje anterior y nuevo, jugada de inicio, motivo, solicitante, aprobador, fechas y el **cálculo antes y después**. Crea una versión nueva y un **tramo** (`BankingPercentageSegment`, solo inserción). La jugada k usa el tramo creado más recientemente con `fromGameNumber ≤ k`. Los ciclos CLOSED nunca cambian.

## 4. Cuatro jugadas

- Jugada (`BankingGame`) = una **sesión distinta** en la que el jugador recibió fichas financiadas: única por (jugador, sesión). Cambiar de mesa NO crea otra jugada. Ausencias no cuentan; sentarse sin fichas no crea jugada.
- `gameNumber` 1..4 (CHECK) y único por ciclo: nunca una quinta jugada; la siguiente abre el ciclo siguiente (aunque el corte anterior siga en revisión, para no bloquear la mesa).
- Ningún bancado se lleva fichas a otra sesión: la jugada solo se confirma con la **devolución física verificada** o el **retorno cero confirmado expresamente**. Una discrepancia bloquea la confirmación (estado `PENDING_RECONCILIATION`), abre una incidencia neutral y un expediente (`PHYSICAL_DISCREPANCY`); un socio la aclara. La sesión no puede cerrarse con el jugador activo (regla del Módulo 12).

## 5. Compras financiadas (Módulo 08)

`recordFinancedPurchase` → `deliverHouseFundedPurchaseInTx`: folio, numeración por (sesión, jugador) (inicial/recompra), reserva y salida nominal del inventario compartido UNA vez, `PurchaseDelivery` con `houseFundedAmount` (pagos + por cobrar + financiado = importe, CHECK) y estado CONFIRMED. **Sin** pagos, asientos de caja, transferencias, crédito, deuda, firma de crédito ni evento de WhatsApp (triggers lo impiden). No genera el comprobante compartible del Módulo 09. Una jugada financiada no se mezcla con compras pagadas por el jugador en la misma sesión (en ambos sentidos).

## 6. Resultado y conciliación

`RESULTADO_BRUTO = NOMINAL_DEVUELTO − NOMINAL_FINANCIADO` (CHECK en la base). `reconcileGame`: valida sesión OPEN, jugada en curso y versión, financiado = Σ compras HOUSE = Σ fuentes, sin compras pendientes, retorno ≤ circulación; registra la entrada nominal (`confirmNominalChipReturnInTx`, clave por jugada) si > 0 y finaliza la participación SETTLED con `bankingGameId` (`completeParticipationFromBankingGameInTx`, libera el asiento) **sin pagar el valor devuelto** (no hay liquidación ordinaria ni cuenta por pagar). El resultado no es un movimiento de caja. Correcciones posteriores: `BankingGameAdjustment` auditado (PARTNER/SUPERADMIN) solo en ciclos NO cerrados; el bruto original se conserva.

## 7. Motor del corte (`banking.math.ts`, puro)

1. Pérdidas del ciclo + pérdida arrastrada se compensan con las ganancias no repartidas.
2. El déficit se cubre con la reserva positiva anterior (`CONSUMED_BY_LOSS`, una vez por corte).
3. Solo lo no cubierto se arrastra (`carriedLossOut`).
4. Solo la ganancia neta elegible se reparte por porcentaje.

Por tramos: si hay pérdidas y ≥ 2 tramos con ganancia y porcentajes distintos, un **socio decide** la distribución al preparar el corte (`lossAllocation`); se valida que cada tramo absorba entre 0 y sus ganancias, que la suma sea exactamente la pérdida a compensar y que no desaparezcan pérdidas. Redondeo: la parte del jugador por tramo con ROUND_HALF_UP a centavos; la casa recibe el resto exacto (la suma coincide siempre).

Después: `saldo = participación − anticipos pagados − recuperaciones`; si es negativo, **excedente** (sin reparto). El cajero propone `reserva + pago = saldo`.

### Ejemplos (probados)

- **A**: +5,000 −2,000 +4,000 −1,000 al 50% → bruto 6,000 → jugador 3,000 / casa 3,000 → − anticipo 1,000 = 2,000 → 1,500 reserva + 500 por pagar.
- **B**: reserva 3,000; ciclo −5,000 → reserva aplicada 3,000, arrastre 2,000. El ciclo siguiente con +3,000 reparte solo 1,000 (los 3,000 cubiertos no se vuelven a descontar).
- **C**: 50%, 50%, 60%, 60% (+4,000 −1,000 +3,000 −2,000); el socio asigna 1,000 al tramo 50% y 2,000 al 60% → 1,500 + 600 = 2,100.
- **E**: anticipos 3,000, participación 2,000 → excedente 1,000 (expediente; sin deuda ordinaria).

## 8. Anticipos

- Solo tras una jugada **ganadora confirmada** del ciclo en curso. El importe lo decide un PARTNER/SUPERADMIN, que lo comunica VERBAL o por MESSAGE; el CASHIER lo registra seleccionando al autorizador (`digitalApproval: false` en la auditoría). Registrar no paga.
- **Límite conservador** (`guaranteedPlayerShare`): mínimo entre todas las distribuciones válidas (absorber primero en los tramos de mayor %), redondeo hacia abajo y 1 centavo de margen por tramo adicional; menos anticipos comprometidos y recuperaciones pendientes. Es **cero** si el ciclo ya tiene 4 jugadas, si el corte anterior no está aprobado, si hay jugadas sin conciliar o en corrección, o si hay una regularización sin decidir.
- Cada entrega real (`disburseAdvance`) crea una obligación `BANKING_ADVANCE` (Módulo 16) y la paga en la misma transacción en que se **revalida el límite** (bloqueo por jugador). Pagos parciales; cerrar el remanente libera lo no pagado.

## 9. Corte y aprobación digital

`prepareClosing` (CASHIER o socio) guarda una VERSIÓN con snapshot canónico + SHA-256 (una en revisión por ciclo). `approveClosing` (PARTNER/SUPERADMIN) recalcula en la misma transacción y exige la misma huella: si cambió una jugada, porcentaje, reserva, anticipo o recuperación → 409 y la versión queda SUPERSEDED (los cambios de porcentaje, ajustes y retiros además invalidan explícitamente). Una sola aprobación por ciclo (índice parcial). Efectos únicos: reserva consumida, reserva creada (`CREATED`), recuperaciones, obligación `BANKING_CYCLE_PAYOUT` por el pago reconocido (sin pagarla), expediente de excedente, ciclo CLOSED (inmutable). `rejectClosing` devuelve el ciclo a revisión.

## 10. Pagos, reserva y retiros

- Pagos: `payBankingPayable` / `resolveBankingPayout` sobre `registerSpecialPayoutInTx` / `resolveSpecialPayoutInTx` (Módulo 16): efectivo de la custodia administrativa del pagador o de la caja de la sesión ABIERTA (nunca de una cerrada; nunca saldo negativo); transferencia PENDIENTE (no cuenta) → EJECUTADA con referencia. Cuenta técnica `BANKING_PLAYER_SHARE`.
- Reserva: libro `BankingReserveMovement` (solo inserción, clave única por origen, trigger que impide saldo negativo). Retirable = saldo − déficit confirmado de ciclos abiertos.
- Retiro: CASHIER solicita → PARTNER/SUPERADMIN aprueba digitalmente (en esa transacción la reserva baja una sola vez: `RECLASSIFIED_TO_WITHDRAWAL`) → pagos reales parciales → cerrar el remanente lo devuelve (`RELEASED_FROM_WITHDRAWAL`). Antes de aprobar se puede rechazar o cancelar.

## 11. Regularizaciones (caso por caso)

`EXCESS_ADVANCE` (al aprobar un corte con excedente) y `PHYSICAL_DISCREPANCY`. Tratamientos del socio: `RECOVER_FROM_FUTURE` (los cortes siguientes lo descuentan FIFO antes de reconocer pago), `APPLY_RESERVE` (consume reserva libre), `MONEY_RETURNED` (entra dinero REAL solo al recibirlo: efectivo a la custodia de quien lo recibe, asiento `BANKING_FUNDS_RECEIVED`) o `DOCUMENTED_WRITE_OFF`. Nunca crea `PlayerDebt` ni usa el FIFO de deudas ordinarias. Visible hasta resolverse.

## 12. Concurrencia e idempotencia

Orden de bloqueos: sesión (FOR SHARE) → mesa → participación → jugador (`lockPlayerInTx`) → filas de bancaje → inventario → obligaciones → saldos. Claves de idempotencia en compras financiadas, conciliación (`confirmIdempotencyKey`), anticipos, retiros, cortes (preparación y aprobación), pagos (`special_payouts.idempotencyKey`). Probado: doble conciliación, dos anticipos simultáneos, doble aprobación de retiro, pagos con la misma clave, dos socios aprobando el mismo corte.

## 13. Modelos

`BankingAgreement`, `BankingAgreementVersion`, `BankingCycle`, `BankingPercentageSegment`, `BankingGame`, `BankingGameFinancialSource`, `BankingGameAdjustment`, `BankingPercentageChangeRequest`, `BankingAdvance`, `BankingCycleClosing` (incluye la aprobación digital: `decidedBy/At`), `BankingReserveMovement`, `BankingReserveWithdrawal`, `BankingRegularization`, `BankingRegularizationRecovery`, `BankingRegularizationReceipt`. Reutiliza `ChipPurchase` (+ `fundingSource`), `PurchaseDelivery` (+ `houseFundedAmount`), `TableParticipation` (+ `bankingGameId`), `SpecialPayable`/`SpecialPayout` (tipos `BANKING_*`) como obligaciones y pagos, el libro financiero (`postTransactionInTx`) y `audit_logs`. Sin caja ni inventario paralelos.

## 14. API (`/api/admin/banking`)

GET: `dashboard`, `players`, `players/candidates`, `players/:id`, `cycles`, `cycles/:id`, `cycles/:id/closing` (vista previa), `closings`, `regularizations`, `authorizers`, `reports/export` (XLSX).
POST: `agreements`, `agreements/:id/end`, `agreements/:id/change-request`, `change-requests/:id/decision`, `financed-purchases`, `games/:id/reconcile`, `games/:id/discrepancy`, `games/:id/resolve-discrepancy`, `games/:id/adjust`, `advances`, `advances/:id/disburse`, `advances/:id/close`, `reserves/withdrawals`, `reserves/withdrawals/:id/{decision,disburse,cancel,close}`, `cycles/:id/{prepare-closing,approve-closing,reject-closing}`, `payables/:id/payouts`, `payouts/:id/resolve`, `regularizations/:id/{resolve,receipts}`.

## 15. Reportes y auditoría

XLSX privado (`PokerManager_Bancaje.xlsx`, ExcelJS, anti-inyección): jugadores, jugadas, cortes, pagos REALES y libro de reserva; separa importes contables de dinero real y no declara utilidad neta de la casa. Auditado como `BANKING_REPORT_EXPORTED`. Eventos `BANKING_*` (acuerdos, cambios de %, ciclos, jugadas, anticipos, pérdidas asignadas, reservas, retiros, cortes, excedentes, regularizaciones). Integridad: `ADMIN_FUNDED_PURCHASES`, `ADMIN_RECORD_RESULTS`, `ADMIN_RESERVE_NONNEGATIVE` (textos neutros).

## 16. Pruebas

- Unitarias `src/modules/banking/banking.test.ts` (23): porcentajes, redondeo, resultados, retorno cero, tramos, escenarios A/B/C/E, recuperación, límite conservador, reserva, permisos, schemas y taxonomía.
- Integración `tests/integration/banking.int.test.ts` (23) con noches REALES y cierre del Módulo 12: compras financiadas sin dinero, ganancia/pérdida/cero, transferencia entre mesas = 1 jugada, no mezcla, discrepancia, 4 jugadas + quinta en ciclo nuevo, escenarios A–G, cambio de % por tramos y de ciclo completo, anticipos verbal/mensaje/parciales/transferencia, excedente con recuperación y con devolución real, retiro con aprobación y pago parcial, privacidad del tablero y de la auditoría, 401/403/400, XLSX, concurrencia, ajustes y sesiones CLOSED intactas.
- E2E `tests/e2e/banking.spec.ts` (7 × Chrome + iPhone): acuerdo, noche con compra y recompra financiadas sin indicadores en la mesa, anticipo verbal pagado, cambio de % aprobado digitalmente, corte con distribución entre tramos aprobado por PARTNER (CASHIER rechazado), reserva y obligación, siguiente ciclo, retiro aprobado y pago parcial, auditoría, XLSX, sin desplazamiento horizontal.

## 17. Limitaciones (NOT_IMPLEMENTED / CONFIGURATION_REQUIRED)

- Jugadas bancadas en **sesiones históricas**: NOT_IMPLEMENTED (la captura financiera histórica no existe; las sesiones `HISTORICAL` no tienen mesas).
- Regularización excepcional de un **ciclo ya cerrado** (recalcular su corte): NOT_IMPLEMENTED; los ajustes solo aplican a ciclos abiertos.
- Devolución de excedente por **transferencia**: NOT_IMPLEMENTED (solo efectivo recibido en custodia).
- Firma del jugador en la conciliación: no se exige (el cajero verifica la recepción); la evidencia es la auditoría.
- Corrección de una compra financiada con el reverso del Módulo 16: bloqueada (se corrige con ajuste de jugada).
- El estado `UNDER_CORRECTION` de jugadas queda reservado (las correcciones actuales son atómicas).
