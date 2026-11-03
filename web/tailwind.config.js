/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: { 950: '#0a0e14', 900: '#0f141c', 850: '#131a24', 800: '#18212d', 700: '#243041', 600: '#334155' },
        up: '#22c55e',
        down: '#f43f5e',
        accent: '#38bdf8',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        led: ['Doto', 'ui-monospace', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
};
