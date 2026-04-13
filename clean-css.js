// clean-css.js
// Usage:
//   node clean-css.js         → purge dist/assets/*.css (post-build)
//   node clean-css.js --src   → purge src/index.css in-place
import { PurgeCSS } from "purgecss";
import path from "path";
import fs from "fs";

const SRC_CONTENT = [
  "./src/**/*.{html,js,jsx}",
  "./index.html",
];

// Classes built at runtime that won't appear as static strings in source.
// Add here whenever a new dynamic pattern is introduced.
const SAFELIST = {
  standard: [/^toc-depth-/],
};

async function purge({ css, label }) {
  const result = await new PurgeCSS().purge({
    content: SRC_CONTENT,
    css,
    safelist: SAFELIST,
  });

  if (result.length === 0) {
    console.log(`⚠️  Nie znaleziono plików CSS (${label})`);
    return;
  }

  result.forEach(({ file, css: cleaned }) => {
    const outputPath = path.resolve(process.cwd(), file);
    fs.writeFileSync(outputPath, cleaned, "utf8");
    console.log(`✅ ${path.relative(process.cwd(), outputPath)}`);
  });

  console.log(`🎉 PurgeCSS (${label}) zakończone`);
}

const srcMode = process.argv.includes("--src");

if (srcMode) {
  console.log("🧹 PurgeCSS – czyszczenie src/index.css...");
  purge({ css: ["./src/index.css"], label: "src" }).catch((err) => {
    console.error("❌", err.message);
    process.exit(1);
  });
} else {
  console.log("🧹 PurgeCSS – czyszczenie dist/assets/*.css...");
  purge({ css: ["./dist/assets/*.css"], label: "dist" }).catch((err) => {
    console.error("❌", err.message);
    process.exit(1);
  });
}
