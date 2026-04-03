import type { Config } from 'tailwindcss'

export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        background: 'rgb(var(--color-background) / <alpha-value>)',
        surface: 'rgb(var(--color-surface) / <alpha-value>)',
        'surface-hover': 'rgb(var(--color-surface-hover) / <alpha-value>)',
        border: 'rgb(var(--color-border) / <alpha-value>)',
        primary: 'rgb(var(--color-primary) / <alpha-value>)',
        accent: 'rgb(var(--color-accent) / <alpha-value>)',
        'accent-hover': 'rgb(var(--color-accent-hover) / <alpha-value>)',
        'text-primary': 'rgb(var(--color-text-primary) / <alpha-value>)',
        'text-secondary': 'rgb(var(--color-text-secondary) / <alpha-value>)',
        success: 'rgb(var(--color-success) / <alpha-value>)',
        warning: 'rgb(var(--color-warning) / <alpha-value>)',
        danger: 'rgb(var(--color-danger) / <alpha-value>)',
        'status-ok': 'rgb(var(--color-status-ok) / <alpha-value>)',
        'status-warn': 'rgb(var(--color-status-warn) / <alpha-value>)',
        'status-error': 'rgb(var(--color-status-error) / <alpha-value>)',
        'border-hi': 'rgb(var(--color-border-hi) / <alpha-value>)',
      },
      keyframes: {
        breathe: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.4' },
        },
        'led-blink': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.3' },
        },
      },
      animation: {
        breathe: 'breathe 3s ease-in-out infinite',
        'led-blink': 'led-blink 1.5s ease-in-out infinite',
      },
    },
  },
  plugins: [],
} satisfies Config
