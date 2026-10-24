# Conciliación GLOBAL de fichas, liquidaciones y cierre

> **Actualización (Módulo 18):** la diferencia nominal ya incluye rake y propinas y **no bloquea** el cierre: se advierte y el cajero confirma con motivo obligatorio (sin ajustes). La conciliación especial de §5 sigue disponible como opción del socio. Ver `docs/MODULE_18_RAKE_TIPS_RECONCILIATION.md`.

Corrección transversal (Módulos 04, 07, 11, 12, 14, 15, 17). Código: `src/modules/closure/closure.math.ts` (`sessionChipReconciliation`, `individualResult`, `identifiableReturn`), `chip-circulation.service.ts#getSessionChipReconciliation`, `closure.data.ts#computePrecheck`, `closure.service.ts#reconcileSessionChips`; migración `20261102120000_chip_global_reconciliation`.

## 1. Regla

**Ningún jugador se lleva fichas.** Al terminar su participación entrega todas las fichas que tiene o confirma expresamente que termina con $0. El cajero registra el nominal recibido y confirma la recepción física; la firma es obligatoria incluso con $0. Las deudas y los pagos pendientes son **dinero**, nunca fichas pendientes.

Las fichas cambian de manos durante el juego: lo que un jugador pierde lo gana otro y regresa en **su** liquidación. Por eso no se exige que cada jugador devuelva lo que compró.

## 2. Tres conceptos que no se mezclan

| Concepto                               | Fórmula                                                            | Qué significa                                                                     |
| -------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| A. Resultado individual                | devuelto − comprado (por jugador)                                  | Positivo, negativo o cero. **No es faltante** ni utilidad.                        |
| B. Balance nominal GLOBAL de la sesión | Σ entregado − Σ devuelto − Σ diferencias autorizadas (ambas mesas) | Con jugadores activos: fichas **en juego**. Con todos terminados debe ser **$0**. |
| C. Diferencia física                   | contado − esperado según el libro                                  | Resultado del arqueo global (Módulo 04).                                          |

Las transferencias entre mesas no generan movimientos nominales: se cuentan una sola vez (compra y retorno).

## 3. Diagnóstico de la advertencia anterior

Antes: `closure.data.ts` agregaba `CHIPS_NOT_RETURNED` (ADVERTENCIA) con `getSessionChipFlows(...).netNotReturned` = Σ cambios positivos − Σ negativos de `circulationAfter − circulationBefore` en `chip_nominal_movements` de la sesión, y lo presentaba como «valor nominal EN CIRCULACIÓN (pendiente de retorno)… no es faltante». La fórmula es GLOBAL (no suma pérdidas individuales), pero su **interpretación** era incorrecta: con todos los jugadores terminados, una diferencia no es circulación legítima sino devoluciones no registradas o fichas faltantes, y no debía permitir cerrar como si nada.

**Caso real (Neon, consulta de solo lectura del 2026-10-24, sesión `S-0001-20261021` en CIERRE):** entregado $111,300 (28 entregas), devuelto $64,000 (9 entradas en 20 liquidaciones), 0 jugadores activos ⇒ diferencia **$47,300**. El arqueo de cierre contó **$264,190 (todo el inventario)** contra un esperado de $216,890: sobrante físico **+$47,300**, idéntico. Conclusión: las fichas **sí regresaron a la caja**; faltó capturar parte de las devoluciones en las liquidaciones. **REQUIRES_RECONCILIATION**: un socio debe registrar el «retorno identificado en el arqueo» (§5) y, además, revisar jugador por jugador si alguna liquidación capturó menos fichas de las entregadas (eso afecta el pago al jugador y se corrige con el Módulo 16, no con este proceso). No se modificó ningún dato de producción.

## 4. Nuevo comportamiento del cierre

`computePrecheck` usa `getSessionChipReconciliation`:

- `CHIPS_IN_PLAY` (INFO): hay jugadores activos; sus fichas están en la mesa.
- `CHIPS_RECONCILED` (INFO): todos terminaron y la diferencia es $0 (las pérdidas y ganancias individuales se compensaron).
- `SESSION_NOMINAL_DIFFERENCE`: todos terminaron y faltan fichas por regresar. **ADVERTENCIA** con la sesión OPEN (permite iniciar el cierre y hacer el arqueo) y **BLOQUEO** en CLOSING (la confirmación exige conciliarla).
- `SESSION_RETURNED_PRIOR_CIRCULATION` (ADVERTENCIA): se devolvió más de lo entregado en la sesión (fichas de circulación anterior, registro histórico).

Deudas (`PLAYER_DEBTS_OUTSTANDING`) y pagos pendientes (`PAYABLES_PENDING`) siguen como advertencias: sobreviven al cierre sin cobrarse ni pagarse.

## 5. Conciliación de una diferencia (PARTNER/SUPERADMIN)

`POST /api/sessions/:id/closure/chip-reconciliation` (`sessions:close-authorize`; CASHIER → 403 y auditoría `CLOSURE_NOMINAL_RECONCILIATION_DENIED`). El importe lo calcula el servidor.

- **`RETURN_IDENTIFIED_IN_COUNT`**: solo si el arqueo de cierre confirmado encontró fichas **de más**. Registra una entrada nominal REAL (`confirmNominalChipReturnInTx`, referencia `SessionChipReconciliation`) por `min(sobrante, diferencia)`. El arqueo queda desactualizado y se hace un recuento. Sin sobrante → rechazado (nunca un retorno sin fichas contadas).
- **`UNRECOVERED_AUTHORIZED`**: las fichas no aparecen. Se documenta y autoriza **sin movimientos**; el valor sigue fuera de custodia y queda señalado.

Tabla `session_chip_reconciliations` (solo inserción, CHECK: importe > 0, motivo ≥ 10 caracteres, retorno identificado ⇔ operación nominal y arqueo). Idempotente; serializada con el inventario. Auditoría `CLOSURE_NOMINAL_RETURN_IDENTIFIED` / `CLOSURE_NOMINAL_DIFFERENCE_AUTHORIZED`. Pantalla: Cierre → Diferencias (tarjeta «Conciliación global de fichas»).

## 6. Liquidaciones (Módulo 11)

- Se captura el valor nominal TOTAL devuelto; puede ser menor o mayor que lo comprado (resultado individual mostrado en pantalla, `purchasedInSession` en el contexto).
- Recepción física obligatoria (`chipsReceived`) y **retorno cero explícito**: si el valor es $0, `confirm-return` exige `zeroReturnConfirmed: true` («Confirmo que el jugador terminó sin fichas y no conserva fichas de esta participación»). Con $0 no hay entrada nominal.
- Firma obligatoria, entrada nominal única, cuenta por pagar y desembolsos reales: sin cambios.

## 7. Jugadores bancados (Módulo 17)

Misma regla física: la jugada se confirma con devolución verificada o cero explícito; sus entregas y devoluciones forman parte del balance global de la sesión. No hay pago automático y la mesa no los distingue.

## 8. Reportes, integridad y datos anteriores

- Reportes: «Neto no retornado» pasa a **«Diferencia nominal (entregado − devuelto)»**; por jugador se muestra el **resultado individual**. El comprobante de cierre nuevo incluye `inventory.chipReconciliation` («Balance nominal de la sesión»); los comprobantes anteriores (inmutables) conservan su texto.
- Integridad: `SESSION_NOMINAL_BALANCE` (ADVERTENCIA) lista sesiones CERRADAS con diferencia sin conciliar (cierres anteriores a esta regla) para revisión; nunca repara.
- Datos anteriores: no se marcaron devoluciones ni se crearon ajustes. La circulación de sesiones anteriores se informa como registro histórico por revisar.

## 9. Pruebas

- Unitarias (`closure.test.ts`): Juan/Pedro, retorno cero, ganador, en juego, 100,000/95,000, circulación anterior, retorno identificable.
- Integración (`tests/integration/chip-reconciliation.int.test.ts`): escenarios A (−3,000/+3,000 sin alerta, cierre normal), B (cero explícito obligatorio), C (diferencia real: fichas en la caja → retorno identificado + recuento; fichas faltantes → autorización sin movimientos; CASHIER 403; importe del servidor; concurrencia/idempotencia), D (deudas y pagos sobreviven), E (transferencia sin movimientos), F (bancado).
- E2E (`tests/e2e/chip-reconciliation.spec.ts`, Chrome + iPhone): liquidaciones en pantalla con resultado individual y cero explícito, prevalidación sin alerta falsa, diferencia real bloqueando, cajero sin permiso, socio que concilia.
