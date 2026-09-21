// Composition adapted from shadcn/ui (MIT); see docs/third-party-ui-notices.md.
import * as React from "react";
import { Slot } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva("pv-button", {
  variants: {
    variant: {
      default: "pv-button-primary",
      secondary: "pv-button-secondary",
      ghost: "pv-button-ghost",
      outline: "pv-button-outline",
      danger: "pv-button-danger",
    },
    size: {
      default: "pv-button-default",
      sm: "pv-button-sm",
      icon: "pv-button-icon",
    },
  },
  defaultVariants: { variant: "default", size: "default" },
});

export function Button({
  className,
  variant,
  size,
  asChild = false,
  type = "button",
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "button";
  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...(!asChild ? { type } : {})}
      {...props}
    />
  );
}
