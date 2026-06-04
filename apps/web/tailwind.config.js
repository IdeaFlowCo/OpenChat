/** @type {import('tailwindcss').Config} */
export default {
  // 'class' strategy: dark mode activates when html has class="dark", which
  // is applied by the no-flash inline script in index.html based on the
  // user's saved theme preference (Light / Dark / System). See OpenChat-dpy.
  darkMode: 'class',
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {},
  },
  plugins: [],
}
