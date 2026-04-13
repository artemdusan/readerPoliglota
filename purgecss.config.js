// purgecss.config.js
module.exports = {
  content: [
    "./src/**/*.{html,js,jsx,ts,tsx,vue,svelte}",
    "./index.html",
    // dodaj swoje ścieżki – np. jeśli masz public/ lub app/
  ],
  css: ["./dist/assets/*.css"], // ścieżka do Twoich zbudowanych plików CSS
  output: "./dist/assets", // nadpisze CSS w tym samym folderze
  safelist: {
    standard: [/^hover:/, /^focus:/, /^active:/], // zostawiamy popularne prefiksy
    // możesz dodać własne klasy, które nie są wykrywane automatycznie
  },
};
