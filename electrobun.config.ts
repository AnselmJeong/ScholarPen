import type { ElectrobunConfig } from "electrobun";

export default {
  app: {
    name: "ScholarPen",
    identifier: "dev.scholarpen.app",
    version: "0.3.1",
  },
  build: {
    // Vite builds to dist/, Electrobun copies to views/
    copy: {
      "dist/index.html": "views/mainview/index.html",
      "dist/assets": "views/mainview/assets",
    },
    // Ignore Vite output in watch mode — HMR handles view rebuilds
    watchIgnore: ["dist/**"],
    mac: {
      bundleCEF: false,
      icons: "build/icon.iconset",
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
