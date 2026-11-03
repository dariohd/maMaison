import assert from "node:assert/strict";
import test from "node:test";
import { issue, valid } from "../lib/session.js";

test("une session nomme la maison et sa generation", () => {
  process.env.SESSION_SECRET = "test-secret";
  const token = issue("AB12CD34", 3);
  const session = valid(token);
  assert.equal(session.house, "AB12CD34");
  assert.equal(session.epoch, 3);
  assert.equal(valid("AB12CD34.1.0.nope"), null);
  assert.equal(valid(""), null);
});
