import type { ElectrobunConfig } from "electrobun";
import packageJson from "./package.json";

export default {
  app: {
    name: "ScholarPen",
    identifier: "dev.scholarpen.app",
    version: packageJson.version,
  },
  build: {
    // Vite builds to dist/, Electrobun copies to views/
    copy: {
      "dist/index.html": "views/mainview/index.html",
      "dist/assets": "views/mainview/assets",
      // The bundled im-not-ai rulebook is MIT-licensed; its notice ships with the app.
      "src/bun/collab/agent/humanize/LICENSE.im-not-ai": "licenses/im-not-ai-LICENSE.txt",
      "src/bun/collab/agent/humanize/LICENSE.blader-humanizer": "licenses/blader-humanizer-LICENSE.txt",
      "src/bun/collab/agent/watermark/LICENSE.watermarks-remover": "licenses/watermarks-remover-LICENSE.txt",
    },
    // Ignore Vite output in watch mode — HMR handles view rebuilds
    watchIgnore: ["dist/**"],
    mac: {
      bundleCEF: false,
      icons: "assets/app-icon.iconset",
      createDmg: true,
    },
    linux: {
      bundleCEF: false,
    },
    win: {
      bundleCEF: false,
    },
  },
} satisfies ElectrobunConfig;
