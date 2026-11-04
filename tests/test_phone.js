import assert from "node:assert/strict";
import test from "node:test";
import { personRole, phoneWriteAllowed } from "../lib/phone.js";

test("owner can rename, use cannot", () => {
  const owner = personRole({ people: [] }, { person: "owner" });
  const setup = personRole({ people: [{ id: "p1", role: "setup" }] }, { person: "p1" });
  const use = personRole({ people: [{ id: "p2", role: "use" }] }, { person: "p2" });
  assert.equal(owner, "owner");
  assert.equal(setup, "setup");
  assert.equal(use, "use");
  const rename = ["devices", "3"];
  assert.equal(phoneWriteAllowed("owner", "PUT", rename), true);
  assert.equal(phoneWriteAllowed("setup", "PUT", rename), true);
  assert.equal(phoneWriteAllowed("use", "PUT", rename), false);
  assert.equal(phoneWriteAllowed("use", "POST", ["devices", "3", "actions", "2", "run"]), true);
  assert.equal(phoneWriteAllowed("use", "GET", ["devices"]), true);
  assert.equal(phoneWriteAllowed("use", "POST", ["scenes"]), false);
});
