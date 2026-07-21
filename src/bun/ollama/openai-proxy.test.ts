import { describe, expect, test } from "bun:test";
import { prepareOllamaChatRequestBody } from "./openai-proxy";

describe("prepareOllamaChatRequestBody", () => {
  test("disables thinking without changing BlockNote tool definitions", () => {
    const body = {
      model: "glm-5.2",
      messages: [{ role: "user", content: "Edit this paragraph" }],
      tools: [{ type: "function", function: { name: "applyDocumentOperations" } }],
      tool_choice: "required",
      stream: true,
    };

    expect(JSON.parse(prepareOllamaChatRequestBody(JSON.stringify(body)))).toEqual({
      ...body,
      think: false,
    });
  });
});
