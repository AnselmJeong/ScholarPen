import type { AIDetectionReport } from "./ai-detection";

export const detectionReportFixture: AIDetectionReport = {
  version: 2, engine: "detectorscope", model: "liamdugan/detector-scope",
  revision: "9baaff9e2d1cdb79cafa90cdb27811b847e69dae", packageVersion: "0.0.1",
  head: "logreg", tau: 0.85, thresholdLogit: 0.4, tokens: 64,
  windows: [{ start: 0, end: 23, text: "A repeated phrase here.", tokens: 64,
    pAi: 1 / (1 + Math.exp(-1)), label: "ai", logit: 1, bias: -0.5,
    otherContribution: 0.25, featureCount: 3,
    features: [
      { id: 42, description: "repeated phrases", importance: 1.5, spans: [{ start: 2, end: 17, activation: 2 }] },
      { id: 43, description: "conversational wording", importance: -0.25, spans: [{ start: 18, end: 22, activation: 1 }] },
    ],
  }],
};
