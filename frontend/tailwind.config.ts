import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";

// Colours are HSL channel triplets (`--background: 0 0% 100%`) rather than hex so
// Tailwind's opacity modifiers work: the map draws ghost floors at `fill-foreground/[0.06]`
// and there is no way to express that against a `#rrggbb` custom property.
const config: Config = {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        card: { DEFAULT: "hsl(var(--card))", foreground: "hsl(var(--card-foreground))" },
        popover: { DEFAULT: "hsl(var(--popover))", foreground: "hsl(var(--popover-foreground))" },
        primary: { DEFAULT: "hsl(var(--primary))", foreground: "hsl(var(--primary-foreground))" },
        secondary: { DEFAULT: "hsl(var(--secondary))", foreground: "hsl(var(--secondary-foreground))" },
        muted: { DEFAULT: "hsl(var(--muted))", foreground: "hsl(var(--muted-foreground))" },
        accent: { DEFAULT: "hsl(var(--accent))", foreground: "hsl(var(--accent-foreground))" },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
          muted: "hsl(var(--destructive-muted))"
        },
        info: {
          DEFAULT: "hsl(var(--info))",
          foreground: "hsl(var(--info-foreground))",
          muted: "hsl(var(--info-muted))"
        },
        // `artwork` (plum) is reserved for the placed artwork and its active floor.
        artwork: {
          DEFAULT: "hsl(var(--artwork))",
          foreground: "hsl(var(--artwork-foreground))",
          muted: "hsl(var(--artwork-muted))"
        },
        success: "hsl(var(--success))",
        warning: {
          DEFAULT: "hsl(var(--warning))",
          foreground: "hsl(var(--warning-foreground))",
          surface: "hsl(var(--warning-surface))"
        },
        // Reference overlays are data, not brand: distinguishable from each other,
        // subordinate to `artwork`.
        layer: {
          1: "hsl(var(--layer-1))",
          2: "hsl(var(--layer-2))",
          3: "hsl(var(--layer-3))",
          4: "hsl(var(--layer-4))"
        },
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))"
      },
      // In dark mode a fill that carries a white label is too dark to read as text
      // on the dark surfaces, so text utilities take each colour's lifted `-text`
      // variant. `text-primary-foreground` and the rest still resolve from `colors`.
      textColor: {
        primary: { DEFAULT: "hsl(var(--primary-text))" },
        destructive: { DEFAULT: "hsl(var(--destructive-text))" },
        artwork: { DEFAULT: "hsl(var(--artwork-text))" },
        success: "hsl(var(--success-text))"
      },
      borderRadius: {
        xl: "calc(var(--radius) + 4px)",
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)"
      },
      fontFamily: {
        sans: ["IBM Plex Sans JP", "Hiragino Kaku Gothic ProN", "Yu Gothic UI", "Meiryo", "system-ui", "sans-serif"],
        mono: ["Geist Mono Variable", "ui-monospace", "monospace"],
        display: ["Fraunces", "IBM Plex Sans JP", "Georgia", "serif"]
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" }
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" }
        }
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out"
      }
    }
  },
  plugins: [animate]
};

export default config;
