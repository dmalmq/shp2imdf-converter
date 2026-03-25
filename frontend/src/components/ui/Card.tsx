import { type HTMLAttributes, forwardRef } from "react";

type Props = HTMLAttributes<HTMLDivElement> & {
  padding?: "none" | "sm" | "md" | "lg";
};

const paddingClasses = {
  none: "",
  sm: "p-3",
  md: "p-4",
  lg: "p-5"
};

export const Card = forwardRef<HTMLDivElement, Props>(
  ({ padding = "md", className = "", children, ...rest }, ref) => {
    return (
      <div
        ref={ref}
        className={[
          "rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)]",
          "shadow-[var(--shadow-sm)]",
          paddingClasses[padding],
          className
        ]
          .filter(Boolean)
          .join(" ")}
        {...rest}
      >
        {children}
      </div>
    );
  }
);

Card.displayName = "Card";
