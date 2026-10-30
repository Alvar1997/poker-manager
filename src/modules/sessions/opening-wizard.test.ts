import { describe, expect, it } from "vitest"

import type { WizardTask } from "@/lib/wizard"
import {
  OPENING_STEPS,
  openingProgress,
  openingStepStatus,
  suggestedOpeningStep,
} from "@/modules/sessions/opening-wizard.math"

const task = (severity: WizardTask["severity"]): WizardTask => ({
  code: "X",
  severity,
  title: "x",
  href: null,
})

describe("asistente de apertura — reglas puras", () => {
  it("tiene cuatro pasos en el orden del negocio", () => {
    expect(OPENING_STEPS.map((s) => s.id)).toEqual([
      "session",
      "chips",
      "tables",
      "confirm",
    ])
  })

  it("un pendiente obligatorio bloquea aunque el paso parezca completo", () => {
    expect(openingStepStatus({ done: true, tasks: [task("BLOCKING")] })).toBe(
      "BLOCKED"
    )
    expect(openingStepStatus({ done: false, tasks: [task("BLOCKING")] })).toBe(
      "BLOCKED"
    )
  })

  it("sin tareas obligatorias: pendiente hasta completarse; la información no bloquea", () => {
    expect(openingStepStatus({ done: false, tasks: [task("INFO")] })).toBe(
      "PENDING"
    )
    expect(openingStepStatus({ done: true, tasks: [task("INFO")] })).toBe(
      "COMPLETED"
    )
    expect(openingStepStatus({ done: true, tasks: [task("WARNING")] })).toBe(
      "WARNING"
    )
  })

  it("el progreso nunca llega a 100% mientras falte abrir", () => {
    expect(
      openingProgress(["COMPLETED", "COMPLETED", "COMPLETED", "PENDING"])
    ).toEqual({ done: 3, total: 4 })
    expect(
      openingProgress(["COMPLETED", "WARNING", "COMPLETED", "COMPLETED"])
    ).toEqual({ done: 4, total: 4 })
  })

  it("sugiere el primer paso incompleto", () => {
    expect(
      suggestedOpeningStep(["COMPLETED", "BLOCKED", "PENDING", "PENDING"])
    ).toBe(2)
    expect(
      suggestedOpeningStep(["COMPLETED", "COMPLETED", "COMPLETED", "PENDING"])
    ).toBe(4)
    expect(
      suggestedOpeningStep(["COMPLETED", "COMPLETED", "COMPLETED", "COMPLETED"])
    ).toBe(4)
  })
})
