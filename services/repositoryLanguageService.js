const path = require("path");
const { isSensitiveRepoPath } = require("../utils/repoPath");

const LANGUAGES = new Map([
  [".js", "JavaScript"], [".jsx", "JavaScript"], [".ts", "TypeScript"], [".tsx", "TypeScript"],
  [".py", "Python"], [".java", "Java"], [".c", "C"], [".h", "C"], [".cpp", "C++"], [".hpp", "C++"],
  [".go", "Go"], [".rs", "Rust"], [".php", "PHP"], [".rb", "Ruby"], [".sh", "Shell"],
  [".css", "CSS"], [".scss", "CSS"], [".html", "HTML"], [".htm", "HTML"],
]);

function detectRepositoryLanguage(files = []) {
  const counts = new Map();
  for (const file of files || []) {
    const filePath = String(file?.path || file?.filename || "");
    try { if (!filePath || isSensitiveRepoPath(filePath)) continue; } catch { continue; }
    const language = LANGUAGES.get(path.posix.extname(filePath.toLowerCase()));
    if (language) counts.set(language, (counts.get(language) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || "";
}

module.exports = { LANGUAGES, detectRepositoryLanguage };
