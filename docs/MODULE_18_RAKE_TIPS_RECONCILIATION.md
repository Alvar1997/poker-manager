# Módulo 18 — Rake, propinas simplificadas y conciliación global de fichas

Código: `src/modules/rake/*` (`rake.math.ts`, `rake.service.ts`, `nominal-effect.ts`), `src/modules/staff-tips/*` (`tips.math.ts`, `tips.service.ts`, `staff.service.ts`), `src/modules/closure/closure.math.ts#chipDestinations`, `closure.service.ts#confirmClosure`. Migraciones `20261104120000_module18_enums` y `20261104130000_module18_rake_tips_reconciliation` (solo agregan; únicos cambios de datos: modalidad sugerida de 25/25 y catálogo inicial de puestos).

## 1. Enfoque simplificado (y diseño descartado)

El objetivo es explicar el destino de TODAS las fichas entregadas en la jornada: devueltas por jugadores, rake de la casa y propinas del staff. **Se descartó** el diseño anterior de propinas complejas (turnos, cierres individuales, reaperturas, disputas, depósitos y canjes parciales, firmas del staff, pagos y saldos por pagar). Ese diseño nunca se publicó ni se aplicó en Neon: su código y sus migraciones locales se retiraron sin afectar datos.

## 2. Fórmula

```
ENTREGADO a jugadores = DEVUELTO por jugadores + RAKE + PROPINAS + OTROS retornos legítimos + DIFERENCIA NOMINAL
```

- Se calcula del libro nominal del inventario compartido por la referencia de cada movimiento (`chipDestinations`): compras y liquidaciones → jugadores; `RakeMovement`/`RakeCount` → rake; `StaffTipCount`/`StaffTipEntry` → propinas; `SessionChipReconciliation` (retorno identificado en un arqueo) → otros. Una corrección negativa de rake o propinas devuelve fichas a circulación y NO es una entrega a jugadores. Cada ficha se cuenta una vez.
- Diferencia > 0: **faltan** fichas por justificar. < 0: **sobran** frente a lo entregado. Son importes NOMINALES, no efectivo.
- Las diferencias autorizadas por un socio (proceso especial anterior) se siguen restando.

## 3. Rake por mesa

- Modalidad por mesa (`poker_tables.rakeMode`), ambas disponibles en las dos mesas (sugerido: 10/10 `MANUAL`, 25/25 `FINAL_COUNT`). Cambio: PARTNER/SUPERADMIN, con la mesa cerrada. La identidad es la mesa lógica (catálogo); al cerrar y reabrir se conserva el rake de cada ciclo.
- **MANUAL**: cada captura (importe, hora del servidor, responsable, nota; hora efectiva opcional para capturas atrasadas) entra al inventario como custodia de la casa. Al cerrar la mesa, conteo de **comprobación** del recipiente: muestra la diferencia (no mueve fichas).
- **FINAL_COUNT**: al cerrar la mesa se cuenta el recipiente ($0 con confirmación explícita); lo contado ES el rake y entra al inventario. Un conteo por ciclo.
- **Corrección**: movimiento nuevo (±) con motivo, sobre un registro manual concreto o sobre el conteo final; efecto nominal real (`nominal-effect.ts`: positivo → custodia; negativo → reserva + entrega a circulación). Lo capturado originalmente se conserva.
- Pantalla: Sesión → Mesa → **Rake** (`/dashboard/sesiones/:id/mesas/:tableId/rake`).

## 4. Propinas por empleado

- Catálogo de staff (`/dashboard/administracion/staff`): nombre, puesto (DEALER, WAITER, OTHER y otros que se agreguen), activo/inactivo. Sin usuario, contraseña, rol, turnos ni firmas.
- Staff de la sesión (`session_staff`) y **un conteo por empleado y sesión** (`staff_tip_counts`): borrador editable (con versión) → CONFIRMADO (inmutable por trigger; al confirmar se declaran recibidas las fichas y entran al inventario una vez). Solo el confirmado cuenta.
- Registros **parciales** (`staff_tip_entries` PARTIAL): informativos, no se suman (se muestran contra el conteo final). **Correcciones** del confirmado: ± con motivo y efecto nominal real.
- Total de propinas = Σ (conteo confirmado + correcciones) de cada empleado. Sin pagos, saldos ni deudas del staff; no toca la caja.
- Pantalla: Sesión → **Propinas** (paso «Propinas» del cierre, `/dashboard/sesiones/:id/cierre/propinas`).

## 5. Cierre con diferencia

- Prevalidación: `SESSION_NOMINAL_DIFFERENCE` como ADVERTENCIA con el importe y si faltan o sobran; `RAKE_COUNT_PENDING`, `RAKE_DIFFERENCE` y `STAFF_TIPS_UNCONFIRMED` como advertencias. Ninguna bloquea.
- La diferencia FÍSICA de fichas del arqueo global tampoco bloquea. Se muestra aparte de la nominal y nunca se igualan con ajustes automáticos.
- **Confirmación** (`sessions:close-confirm`: CASHIER, PARTNER, SUPERADMIN): el servidor recalcula ambas diferencias en la misma transacción; si alguna ≠ 0 exige `differenceReason` (motivo obligatorio). Guarda `session_chip_differences` (entregado, jugadores, rake, propinas, otros, diferencia nominal, esperado/contado/diferencia física, motivo, usuario y fecha), deja el arqueo `ACCEPTED_WITH_DIFFERENCE` y su discrepancia `RESOLVED / CLOSED_WITH_REASON`, y agrega el desglose y el motivo al comprobante inmutable. **No crea ajustes, fichas ni movimientos de dinero.**
- Se mantienen el resto de las validaciones del cierre (mesas cerradas, arqueo vigente, efectivo $0 con retiro, diferencias de EFECTIVO que sí bloquean, huella del resumen). El proceso especial del socio (retorno identificado / diferencia autorizada) sigue disponible, pero ya no es necesario para cerrar.
- El cierre no cancela deudas de jugadores ni obligaciones de pago.

## 6. Caja, inventario y jugadores bancados

Una sola caja central y un solo inventario global. Rake y propinas son nominales: nunca generan entradas de efectivo ni pagos. Las fichas financiadas del Módulo 17 cuentan como entregadas (sin duplicar) y sus devoluciones una vez; el módulo de bancaje no cambia.

## 7. Sesión real S-0001-20261021

Con la migración aplicada pueden registrar el rake real de cada mesa (conteo final o capturas atrasadas en ciclos cerrados) y las propinas reales de cada empleado mientras la sesión está en CIERRE. Cada registro es una entrada nominal respaldada por fichas contadas: la diferencia se recalcula (111,300 − 64,000 − rake − propinas). Lo que reste se cierra con motivo. No se asume ninguna distribución del valor ni se corrigen liquidaciones sin evidencia.

## 8. Auditoría

`RAKE_MOVEMENT_CREATED`, `RAKE_FINAL_COUNT_CONFIRMED`, `RAKE_CORRECTED`, `RAKE_MODE_CHANGED`, `STAFF_MEMBER_CREATED/UPDATED`, `STAFF_ASSIGNED_TO_SESSION`, `STAFF_TIP_RECORDED` (parcial), `STAFF_TIP_COUNT_SAVED`, `STAFF_TIP_COUNT_CONFIRMED`, `STAFF_TIP_CORRECTED`, `CHIP_RECONCILIATION_CALCULATED`, `CHIP_DIFFERENCE_RECORDED` y `SESSION_CLOSED_WITH_DIFFERENCE`, todas dentro de la transacción. Historial inmutable (triggers de solo inserción).

## 9. Concurrencia e idempotencia

Bloqueos sesión (FOR SHARE) → ciclo de mesa o staff de la sesión (FOR UPDATE) → inventario. Claves de idempotencia en registros y correcciones; conteo único por ciclo y por empleado (índices); versión optimista del borrador; la confirmación del cierre recalcula todo y exige la huella del resumen (409 si cambió) y es idempotente por clave.

## 10. Reportes

Reportes → «Rake y propinas» y XLSX `rake`, `tips` y `nominal` (consolidado por sesión con diferencia nominal y física por separado).

## 11. Pruebas

- Unitarias: `src/modules/staff-tips/module18.test.ts`, `closure.test.ts`.
- Integración: `tests/integration/rake-tips.int.test.ts` (escenarios A–G, idempotencia del cierre, CLOSED inmutable) y pruebas de cierre/conciliación adaptadas.
- E2E: `tests/e2e/rake-tips.spec.ts` (Chrome + iPhone).
