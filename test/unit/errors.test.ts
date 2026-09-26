import assert from "node:assert/strict"
import { test } from "node:test"
import { AdapterError, errorBody } from "../../src/openai/errors.js"

test("errorBody uses the OpenAI error shape", () => {
  const error = new AdapterError(404, "model_not_found", "Unknown model: x", "raw agent output")
  assert.deepEqual(errorBody(error), {
    error: { message: "Unknown model: x", type: "model_not_found", code: "model_not_found" },
  })
  assert.equal(error.status, 404)
  assert.equal(error.detail, "raw agent output")
  assert.ok(!JSON.stringify(errorBody(error)).includes("raw agent output"))
})
