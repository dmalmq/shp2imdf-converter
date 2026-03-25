import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: "var(--color-surface)",
          muted: "var(--color-surface-muted)",
          raised: "var(--color-surface-raised)"
        },
        border: {
          DEFAULT: "var(--color-border)",
          muted: "var(--color-border-muted)"
        },
        primary: {
          DEFAULT: "var(--color-primary)",
          hover: "var(--color-primary-hover)",
          muted: "var(--color-primary-muted)"
        },
        success: {
          DEFAULT: "var(--color-success)",
          muted: "var(--color-success-muted)"
        },
        warning: {
          DEFAULT: "var(--color-warning)",
          muted: "var(--color-warning-muted)"
        },
        error: {
          DEFAULT: "var(--color-error)",
          muted: "var(--color-error-muted)"
        },
        text: {
          DEFAULT: "var(--color-text)",
          secondary: "var(--color-text-secondary)",
          muted: "var(--color-text-muted)"
        }
      },
      borderRadius: {
        sm: "var(--radius-sm)",
        md: "var(--radius-md)",
        lg: "var(--radius-lg)"
      },
      boxShadow: {
        sm: "var(--shadow-sm)",
        md: "var(--shadow-md)"
      }
    }
  },
  plugins: []
};

export default config;
