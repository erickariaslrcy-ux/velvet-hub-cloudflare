/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./public/**/*.html",
    "./public/**/*.js"
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        pitch: '#000000',
        obsidian: '#040209',
        velvet: '#090518',
        glass: '#0f0927',
        glasscard: '#130b32',
        violet: '#8b5cf6',
        neon: '#a855f7',
        hot: '#ec4899',
        crimson: '#f43f5e',
        magenta: '#d946ef',
        gold: '#f59e0b',
        ink: '#f8fafc',
        lav: '#c4b5fd',
        darkborder: '#271754'
      },
      fontFamily: {
        sans: ['"Plus Jakarta Sans"', 'Inter', 'Outfit', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        display: ['"Playfair Display"', '"DM Serif Display"', 'Georgia', 'serif']
      },
      boxShadow: {
        'neon': '0 0 25px rgba(168, 85, 247, 0.25)',
        'neon-strong': '0 0 35px rgba(217, 70, 239, 0.45)',
        'hot-glow': '0 0 30px rgba(236, 72, 153, 0.4)',
        'gold': '0 0 20px rgba(245, 158, 11, 0.35)',
        'thumb': '0 -10px 30px rgba(0, 0, 0, 0.95)'
      }
    }
  },
  plugins: []
};
