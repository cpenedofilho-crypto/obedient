// SPDX-License-Identifier: AGPL-3.0-only
import {test} from "node:test";
import assert from "node:assert/strict";
import {triage, type Finding} from "./index.js";
const f: Finding = {repository:"owner/repo",revision:"a".repeat(40),rule:"rule1",evidenceId:"ref1",severity:"low"};
test("denies empty and foreign scope",()=>{
  assert.throws(()=>triage([], [f]));
  assert.throws(()=>triage(["owner/other"], [f]));
});
test("deduplicates retaining highest severity",()=>{
  assert.deepEqual(triage(["owner/repo"],[f,{...f,severity:"high"}]),[{...f,severity:"high"}]);
});
test("rejects invalid evidence and revision",()=>{
  assert.throws(()=>triage(["owner/repo"],[{...f,evidenceId:"raw secret"}]));
  assert.throws(()=>triage(["owner/repo"],[{...f,revision:"main"}]));
});
test("does not propagate extra properties",()=>{
  const input = {...f, secret:"synthetic"};
  assert.deepEqual(triage(["owner/repo"],[input]),[f]);
});
