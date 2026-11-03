/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: { 950: '#000000', 900: '#06070d', 850: '#0b0e18', 800: '#111526', 700: '#1c2340', 600: '#2a3358' },
        up: '#22c55e',
        down: '#ef4444',
        accent: '#2f7dff',
        rose: { DEFAULT: '#ff2d78', soft: '#ff6fa5' },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        led: ['Doto', 'ui-monospace', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
};
