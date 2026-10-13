import type { ComponentProps } from "react"

import { cn } from "@/lib/utils"

/**
 * <select> nativo con el estilo de los inputs. En celular abre el
 * selector del sistema (mejor UX táctil que un popover).
 */
export function NativeSelect({
  className,
  ...props
}: ComponentProps<"select">) {
  return (
    <select
      className={cn(
        "border-input focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:border-destructive dark:bg-input/30 h-11 w-full min-w-0 rounded-lg border bg-transparent px-2.5 text-base outline-none focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-50 md:h-9 md:text-sm",
        className
      )}
      {...props}
    />
  )
}
