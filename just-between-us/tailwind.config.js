/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      fontFamily: {
        serif: ['"Cormorant Garamond"', "Georgia", "serif"],
        sans: ["Inter", "system-ui", "sans-serif"],
      },
      colors: { crimson: "#dc2626", gold: "#c9a24b", ink: "#0a0a0a", wine: "#2a0707" },
      keyframes: {
        heartbeat: {
          "0%,100%": { transform: "scale(1)", boxShadow: "0 0 0 0 rgba(220,38,38,.55)" },
          "50%": { transform: "scale(1.08)", boxShadow: "0 0 0 16px rgba(220,38,38,0)" },
        },
        flash: { "0%,100%": { boxShadow: "0 0 0 0 rgba(201,162,75,0)" }, "30%": { boxShadow: "0 0 0 3px rgba(201,162,75,.8)" } },
      },
      animation: { heartbeat: "heartbeat 2s ease-in-out infinite", flash: "flash 1.8s ease-out" },
    },
  },
  plugins: [],
};
