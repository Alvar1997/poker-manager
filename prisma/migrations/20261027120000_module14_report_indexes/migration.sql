-- Módulo 14 — Reportes y estadísticas (solo lectura).
-- Índices para las agregaciones de reportes: fecha de origen de deudas
-- (FIFO / filtros), mesa original, sesión de cobro de abonos, compensaciones
-- por fecha, compras por ciclo y fecha de confirmación, liquidaciones por
-- ciclo, asientos por fecha real y arqueos confirmados por fecha.
-- No crea tablas ni modifica datos.

-- CreateIndex
CREATE INDEX "player_debts_createdAt_idx" ON "player_debts"("createdAt");

-- CreateIndex
CREATE INDEX "player_debts_tableId_idx" ON "player_debts"("tableId");

-- CreateIndex
CREATE INDEX "receivable_payments_sessionId_idx" ON "receivable_payments"("sessionId");

-- CreateIndex
CREATE INDEX "payment_allocations_source_allocatedAt_idx" ON "payment_allocations"("source", "allocatedAt");

-- CreateIndex
CREATE INDEX "chip_purchases_cycleId_idx" ON "chip_purchases"("cycleId");

-- CreateIndex
CREATE INDEX "chip_purchases_confirmedAt_idx" ON "chip_purchases"("confirmedAt");

-- CreateIndex
CREATE INDEX "player_settlements_cycleId_idx" ON "player_settlements"("cycleId");

-- CreateIndex
CREATE INDEX "cash_transactions_confirmedAt_idx" ON "cash_transactions"("confirmedAt");

-- CreateIndex
CREATE INDEX "chip_stock_counts_status_confirmedAt_idx" ON "chip_stock_counts"("status", "confirmedAt");
