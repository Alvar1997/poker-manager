"use client"

import {
  MutationCache,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query"
import { useState, type ReactNode } from "react"

export function QueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(() => {
    const queryClient: QueryClient = new QueryClient({
      // Módulo 14 (DEC-09): cualquier movimiento registrado desde la app
      // (compra, pago, abono, liquidación, arqueo, apertura/cierre…) deja
      // obsoletos los indicadores de reportes.
      mutationCache: new MutationCache({
        onSuccess: () => {
          void queryClient.invalidateQueries({ queryKey: ["reports"] })
        },
      }),
      defaultOptions: {
        queries: {
          staleTime: 30 * 1000,
          retry: 1,
        },
      },
    })
    return queryClient
  })

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}
