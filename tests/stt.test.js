import assert from "node:assert/strict";
import test from "node:test";

import { normalizeMime } from "../engine/stt.js";

test("recorder types become the bare container Gemini expects", () => {
  assert.equal(normalizeMime("audio/webm;codecs=opus"), "audio/webm");
  assert.equal(normalizeMime("audio/mp4;codecs=mp4a.40.2"), "audio/mp4");
  assert.equal(normalizeMime("audio/x-wav"), "audio/wav");
});

test("an audio-only clip labelled as video still counts as audio", () => {
  assert.equal(normalizeMime("video/mp4"), "audio/mp4");
  assert.equal(normalizeMime("video/webm;codecs=opus"), "audio/webm");
});

test("anything else is refused", () => {
  assert.equal(normalizeMime("text/plain"), null);
  assert.equal(normalizeMime(""), null);
  assert.equal(normalizeMime("video/quicktime"), null);
});
