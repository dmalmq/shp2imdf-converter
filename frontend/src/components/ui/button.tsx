import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "@/lib/utils";

// `default` is the single highest-emphasis action on a screen — there is never
// more than one. `ghost` carries map and toolbar chrome.
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-sm font-medium " +
    "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring " +
    "focus-visible:ring-offset-2 focus-visible:ring-offset-background " +
    // Disabled drops the variant's fill for a dashed outline and muted label, a
    // look no enabled variant has. Fading the variant instead left a disabled
    // pine button looking like an enabled pine-tint one in dark mode. It is an
    // outline rather than a border so that disabling never resizes a button.
    "disabled:pointer-events-none disabled:border-transparent disabled:bg-transparent disabled:text-muted-foreground " +
    "disabled:outline disabled:outline-1 disabled:-outline-offset-1 disabled:outline-dashed disabled:outline-input " +
    "[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        outline: "border border-input bg-background hover:bg-accent hover:text-accent-foreground",
        ghost: "hover:bg-accent hover:text-accent-foreground disabled:outline-none",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90"
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 px-3",
        icon: "h-8 w-8"
      }
    },
    defaultVariants: { variant: "default", size: "default" }
  }
);

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean };

/**
 * A disabled Button must be wrapped in a Tooltip that states the precondition.
 * The old placement sidebar disabled "Fit all linked floors" and explained why
 * in a paragraph 100px away, which is how nobody found it.
 */
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return <Comp className={cn(buttonVariants({ variant, size }), className)} ref={ref} {...props} />;
  }
);
Button.displayName = "Button";

export { buttonVariants };
