const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const renderer = path.join(root, "dist", "renderer");
fs.mkdirSync(renderer, { recursive: true });
fs.copyFileSync(path.join(root, "src", "renderer", "index.html"), path.join(renderer, "index.html"));
fs.cpSync(path.join(root, "src", "renderer", "styles"), path.join(renderer, "styles"), { recursive: true });
