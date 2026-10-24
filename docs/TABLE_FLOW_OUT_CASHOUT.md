# Flujo de mesa: OUT, CASHOUT, compra inicial/recompra por mesa y modalidades de pago

Mejora transversal (Módulos 07, 08, 10, 11 y mesa interactiva). Migración `20261103120000_table_flow_out_credit` (aditiva, sin cambiar datos existentes).

## 1. OUT: perdió todas sus fichas

- Botón **«OUT (perdió todas sus fichas)»** en las acciones del asiento (estado `PLAYING`). Hoja `table-floor/components/out-sheet.tsx`.
- Es una liquidación del Módulo 11 con `exitKind = OUT`: retorno **$0**, `NO_COMPENSATE`, sin entrada de inventario, sin pago al jugador y **con firma obligatoria**. El asiento se libera al confirmar (`completeParticipationFromSettlementInTx`); la participación queda `SETTLED` y su historial se conserva.
- La confirmación «el jugador terminó sin fichas» se pide **una sola vez**, antes de la firma; no existe la pantalla de «fichas recibidas». Se **guarda** en `player_settlements.zeroReturnConfirmed`. La base lo exige (trigger `player_settlements_zero_return_explicit`) cuando `receivedAt` pasa a tener valor con retorno $0, y lo vuelve inmutable después; CHECK `player_settlements_out_valid` (OUT ⇒ $0 y sin compensación). Las liquidaciones anteriores no cambian.
- Sus deudas siguen vigentes. **Abono opcional con dinero real**: el mismo abono del Módulo 10 (`POST /api/credits/payments`, origen `SESSION`, FIFO automático, comprobante propio). No es compensación ni reduce fichas.

## 2. CASHOUT con abono a la deuda (compensación)

- «Cashout (entrega fichas)» = la liquidación existente. Con fichas devueltas la recepción física (`chipsReceived`) es obligatoria; con $0 basta `zeroReturnConfirmed`.
- Pregunta: «¿Deseas aplicar parte de esta liquidación a la deuda del jugador?» → No aplicar / Abonar parcialmente / Abonar lo máximo posible (`min(devuelto, deuda)`), FIFO del Módulo 10, **sin efectivo**. Nunca más que lo devuelto ni que la deuda.
- Resumen: compras y recompras (pagadas vs. a crédito, `purchasedInSession.paid/credit`), deuda vigente, devuelto, compensación, neto a pagar y deuda restante.
- Ejemplos verificados (integración): crédito 2,000 · devuelve 1,600 · máximo → deuda 400, pago 0; parcial 1,000 → deuda 1,000, pago 600.

## 3. Compra inicial / recompra por MESA

- `classifyPurchase(lastSequence, priorInScope)` (`purchase.math.ts`) y `nextPurchaseNumberInTx` (`purchase.service.ts`): el **consecutivo** sigue siendo por (sesión, jugador), único y en orden real; el **tipo** se decide por la mesa lógica (`tableId` del catálogo, la misma tras cerrar y reabrir) **más** la cadena de transferencias (`sourceParticipationId`).
- Jugó en 25/25, hizo OUT/CASHOUT y entra a 10/10 → su primera compra ahí es **COMPRA INICIAL**. Si regresa a 25/25 → **RECOMPRA**. Transferencia sin liquidar → conserva el tratamiento (recompra en destino) sin movimientos de fichas ni dinero.
- Se usa en la entrega (Módulo 08), en la entrega financiada (Módulo 17), en la proyección de la firma y en el tablero. CHECK `chip_purchases_numbering_valid` actualizado: `INITIAL ⇒ rebuy null`; `REBUY ⇒ 1 ≤ rebuy < sequence`.

## 4. Modalidad de pago

- `chip_purchases.paymentMode` (`CASH | BANK_TRANSFER | CARD | CREDIT | MIXED`, null en compras anteriores). La hoja rápida la envía.
- El servidor valida (`assertPaymentMatchesMode`): **CRÉDITO total no acepta cobros**; efectivo/transferencia/terminal solo aceptan su método; **solo PAGO MIXTO combina**. Efectivo o terminal como modalidad única deben cubrir el importe al entregar.
- Pantalla: cada método muestra solo sus campos; cambiar de método limpia lo incompatible; con crédito total no aparece «agregar pago».

## 5. Pruebas

- Unitarias: `purchase.test.ts` (clasificación), `table-floor.test.ts` (acción OUT), `settlement.test.ts` (esquemas OUT y recepción).
- Integración: `tests/integration/table-flow.int.test.ts`.
- E2E: `tests/e2e/table-flow.spec.ts` (Chrome + iPhone).
