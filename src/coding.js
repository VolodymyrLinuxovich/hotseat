// The live coding round: the editor, the in-browser judge, the integrity counters, and the
// side chat where the candidate talks to Theo while they code.

import { bindMicButton } from "./listen.js";

// One paste longer than this gets a visible note. Keep in step with LARGE_PASTE_CHARS in engine/checks.js.
const LARGE_PASTE_CHARS = 80;
const PASTE_SAMPLE_CHARS = 160;

const FALLBACK_OPENER = "Before you start typing, talk me through your approach. Ask me anything about the problem.";

const PY_LOAD_FAILED = "Python could not load. Switch the language to JavaScript and run again.";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const JS_WORKER_SRC = `
onmessage = (e) => {
  const { code, fn, tests } = e.data;
  const results = [];
  let f;
  try {
    f = new Function(code + "\\n;return " + fn + ";")();
  } catch (err) {
    postMessage({ compileError: String(err) });
    return;
  }
  if (typeof f !== "function") {
    postMessage({ compileError: "No function named " + fn });
    return;
  }
  for (const t of tests) {
    try {
      const args = JSON.parse(t.args_json);
      const expected = JSON.parse(t.expected_json);
      const got = f(...structuredClone(args));
      // JSON.stringify(undefined) is undefined, and the page needs a string to show
      const gotJson = got === undefined ? "undefined" : JSON.stringify(got);
      const pass = gotJson === JSON.stringify(expected);
      results.push({ args: t.args_json, expected: t.expected_json, got: gotJson, pass });
    } catch (err) {
      results.push({ args: t.args_json, expected: t.expected_json, got: "error: " + err.message, pass: false });
    }
  }
  postMessage({ results });
};`;

// api, speak and the voice helpers come from main.js, so this module never touches the 3D scene.
// getSession returns the current { id, state }, and setSessionState stores what the server sends back.
// submitAnswer sends the final text to the panel and resolves to { ok, error }.
export function createCodingRound({
  api,
  speak,
  stopSpeaking,
  setMood,
  setStatus,
  getSession,
  setSessionState,
  submitAnswer,
}) {
  const codeEl = $("code");
  const chatBox = $("chatBox");
  const jsWorkerUrl = URL.createObjectURL(new Blob([JS_WORKER_SRC], { type: "text/javascript" }));

  let problem = null;
  let lastRun = null;
  let submitting = false;
  let chatting = false;
  let stats = freshStats();

  // Bumped on every submit and every new problem. A chat reply that comes back after either
  // belongs to a round that is over, so it must not speak or overwrite the session state.
  let chatRound = 0;

  let lang = localStorage.getItem("hotseat_lang") || "python";
  let pyWorker = null;
  let pyReady = false;
  let pyFailed = false;

  // ---------- integrity counters ----------

  function freshStats() {
    return { typed: 0, pasted: 0, pastes: 0, largest: 0, sample: "", runs: 0, openedAt: Date.now() };
  }

  function secondsOpen() {
    return Math.round((Date.now() - stats.openedAt) / 1000);
  }

  function integrityPayload() {
    return {
      typed_chars: stats.typed,
      pasted_chars: stats.pasted,
      pastes: stats.pastes,
      largest_paste: stats.largest,
      largest_paste_sample: stats.sample,
      test_runs: stats.runs,
      seconds_open: secondsOpen(),
    };
  }

  function recordPaste(text) {
    const n = text.length;
    if (n === 0) {
      return;
    }

    stats.pasted += n;
    stats.pastes += 1;
    if (n > stats.largest) {
      stats.largest = n;
      stats.sample = text.slice(0, PASTE_SAMPLE_CHARS);
    }
    if (n > LARGE_PASTE_CHARS) {
      $("pasteNote").textContent = `Paste noticed (${n} characters): the panel will see this.`;
      $("pasteNote").classList.remove("hidden");
    }
  }

  // We insert pasted text ourselves so the exact length is known, and execCommand keeps undo working.
  // The flag stops that insert from also counting as typing.
  let insertingPaste = false;

  codeEl.addEventListener("paste", (e) => {
    const text = e.clipboardData ? e.clipboardData.getData("text/plain") : "";
    if (!text) {
      return;
    }
    e.preventDefault();
    recordPaste(text);

    insertingPaste = true;
    const inserted = document.execCommand("insertText", false, text);
    insertingPaste = false;
    if (!inserted) {
      codeEl.setRangeText(text, codeEl.selectionStart, codeEl.selectionEnd, "end");
    }
  });

  codeEl.addEventListener("beforeinput", (e) => {
    if (insertingPaste) {
      return;
    }
    if (e.inputType === "insertFromDrop") {
      recordPaste(e.dataTransfer ? e.dataTransfer.getData("text/plain") : "");
      return;
    }
    if (e.inputType === "insertLineBreak" || e.inputType === "insertParagraph") {
      stats.typed += 1;
      return;
    }
    if (e.inputType.startsWith("insert") && e.data) {
      stats.typed += e.data.length;
    }
  });

  codeEl.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") {
      return;
    }
    e.preventDefault();
    const { selectionStart: a, selectionEnd: b } = codeEl;
    codeEl.value = codeEl.value.slice(0, a) + "  " + codeEl.value.slice(b);
    codeEl.selectionStart = codeEl.selectionEnd = a + 2;
    stats.typed += 2;
  });

  // ---------- judge ----------

  function startPyWorker() {
    pyReady = false;
    pyFailed = false;
    pyWorker = new Worker("/py-worker.js");
    pyWorker.onerror = () => {
      pyFailed = true;
    };
    pyWorker.addEventListener("message", (e) => {
      if (e.data && e.data.ready) {
        pyReady = true;
        if (problem && lang === "python" && !lastRun) {
          $("testSummary").textContent = `Python ready · ${problem.tests.length} hidden tests`;
        }
      }
    });
  }

  function runJs() {
    return new Promise((resolve) => {
      const w = new Worker(jsWorkerUrl);
      const timer = setTimeout(() => {
        w.terminate();
        resolve({ compileError: "Timed out after 3s (infinite loop?)" });
      }, 3000);
      w.onmessage = (e) => {
        clearTimeout(timer);
        w.terminate();
        resolve(e.data);
      };
      w.postMessage({ code: codeEl.value, fn: problem.function_name, tests: problem.tests });
    });
  }

  // Python runs in a long-lived Pyodide worker (loading takes a few seconds), restarted after a timeout.
  function runPy() {
    if (!pyWorker) {
      startPyWorker();
    }
    return new Promise((resolve) => {
      const w = pyWorker;
      let timer = null;
      let loadTimer = null;

      const fail = () => {
        clearTimeout(timer);
        clearTimeout(loadTimer);
        w.removeEventListener("message", onMsg);
        w.removeEventListener("error", fail);
        w.terminate();
        pyWorker = null;
        resolve({ compileError: PY_LOAD_FAILED });
      };

      const onMsg = (e) => {
        const d = e.data || {};
        if (d.ready) {
          return;
        }
        clearTimeout(loadTimer);
        if (d.started) {
          // The clock starts once Pyodide is loaded, so load time never counts against the candidate.
          timer = setTimeout(() => {
            w.removeEventListener("message", onMsg);
            w.terminate();
            startPyWorker();
            resolve({ compileError: "Timed out after 5s (infinite loop?)" });
          }, 5000);
          return;
        }
        clearTimeout(timer);
        w.removeEventListener("message", onMsg);
        w.removeEventListener("error", fail);
        resolve(d);
      };

      if (pyFailed) {
        fail();
        return;
      }

      // Pyodide comes from a CDN; if it never answers, don't leave "Running…" up forever
      loadTimer = setTimeout(fail, 30000);
      w.addEventListener("message", onMsg);
      w.addEventListener("error", fail);
      w.postMessage({ code: codeEl.value, fn: problem.function_name, tests: problem.tests });
    });
  }

  // One run at a time: two Python runs would share a single worker and mix up results.
  async function runTests() {
    $("runBtn").disabled = true;
    $("submitCode").disabled = true;
    $("testSummary").textContent = lang === "python" && !pyReady ? "Loading Python…" : "Running…";
    try {
      const r = lang === "python" ? await runPy() : await runJs();
      // A worker that answers with neither shape would otherwise crash the summary below.
      if (!r || (!r.compileError && !Array.isArray(r.results))) {
        return { compileError: "The judge returned nothing. Run again." };
      }
      return r;
    } catch (err) {
      return { compileError: `The judge failed: ${err.message || err}` };
    } finally {
      $("runBtn").disabled = false;
      $("submitCode").disabled = false;
    }
  }

  const nothing = () => (lang === "python" ? "None" : "undefined");

  function isEmptyResult(x) {
    if (x.pass) {
      return false;
    }
    if (lang === "python") {
      return x.got === "null" && x.expected !== "null";
    }
    return x.got === "undefined";
  }

  // The most common silent failure: the function prints its answer, or forgets to return it.
  function returnNote(results) {
    const empty = results.filter(isEmptyResult);
    if (empty.length === 0) {
      return "";
    }

    const printed = empty.some((x) => x.printed && x.printed.trim());
    if (printed) {
      return `Your function printed its answer but returned ${nothing()}. Use return instead of print.`;
    }
    if (empty.length === results.length) {
      return `Your function returned ${nothing()}. Did you forget return?`;
    }
    return `Your function returned ${nothing()} on ${empty.length} of ${results.length} tests. Did you forget return on some path?`;
  }

  function shownValue(got) {
    if (lang === "python" && got === "null") {
      return "None";
    }
    return got;
  }

  function showRun(r) {
    const note = $("judgeNote");
    note.classList.add("hidden");

    if (r.compileError) {
      $("testSummary").textContent = r.compileError;
      $("testList").innerHTML = "";
      return;
    }

    const passed = r.results.filter((x) => x.pass).length;
    $("testSummary").textContent = `${passed}/${r.results.length} tests passed`;
    $("testList").innerHTML = r.results
      .map((x, i) => {
        const title = `args ${x.args} → expected ${x.expected}, got ${shownValue(x.got)}`;
        return `<span class="t ${x.pass ? "pass" : "fail"}" title="${esc(title)}">#${i + 1} ${x.pass ? "✓" : "✗"}</span>`;
      })
      .join("");

    const hint = returnNote(r.results);
    if (hint) {
      note.textContent = hint;
      note.classList.remove("hidden");
    }

    let mood = "concerned";
    if (passed === r.results.length) {
      mood = "impressed";
    } else if (passed > r.results.length / 2) {
      mood = "neutral";
    }
    setMood("tech", mood);
  }

  function runSummary(r) {
    if (!r) {
      return "";
    }
    if (r.compileError) {
      return `did not run: ${r.compileError}`;
    }
    return `${r.results.filter((x) => x.pass).length}/${r.results.length} passed`;
  }

  function judgeReport(r) {
    if (r.compileError) {
      return `Code did not run: ${r.compileError}`;
    }

    const passed = r.results.filter((x) => x.pass).length;
    const failures = r.results
      .filter((x) => !x.pass)
      .map((x) => `args ${x.args} expected ${x.expected} got ${shownValue(x.got)}`)
      .join("; ");
    let report = `${passed}/${r.results.length} hidden tests passed. Failures: ${failures || "none"}`;

    const hint = returnNote(r.results);
    if (hint) {
      report += `\n[JUDGE NOTE] ${hint}`;
    }
    return report;
  }

  // ---------- language ----------

  function starterFor(l) {
    if (!problem) {
      return "";
    }
    return l === "python" ? problem.starter_code_python : problem.starter_code;
  }

  function showLang() {
    $("langPill").textContent = `LIVE CODING · ${lang === "python" ? "Python" : "JavaScript"}`;
  }

  function setLang(next) {
    const edited = problem && codeEl.value.trim() !== starterFor(lang).trim();
    if (edited && !confirm("Switch language? Your current code will be replaced by the starter.")) {
      $("langSel").value = lang;
      return;
    }

    lang = next;
    localStorage.setItem("hotseat_lang", lang);
    showLang();
    if (problem) {
      codeEl.value = starterFor(lang);
      lastRun = null;
      $("testList").innerHTML = "";
      $("judgeNote").classList.add("hidden");
      $("testSummary").textContent = `${problem.tests.length} hidden tests`;
    }
    if (lang === "python" && !pyWorker) {
      startPyWorker();
    }
  }

  $("langSel").value = lang;
  $("langSel").addEventListener("change", (e) => setLang(e.target.value));

  // ---------- run and submit ----------

  $("runBtn").onclick = async () => {
    if (!problem) {
      return;
    }
    stats.runs += 1;
    const r = await runTests();
    lastRun = r;
    showRun(r);
  };

  function setIdeVisible(visible) {
    $("ide").classList.toggle("hidden", !visible);
    $("dock").classList.toggle("hidden", visible);
  }

  async function submit() {
    if (!problem || submitting) {
      return;
    }
    submitting = true;
    chatRound++;
    stopDictation();
    const submitted = problem;

    const r = await runTests();
    lastRun = r;
    showRun(r);

    const language = lang === "python" ? "Python" : "JavaScript";
    const text = `[LIVE CODING: ${problem.title} · language: ${language}]\n${codeEl.value}\n\n[JUDGE] ${judgeReport(r)}`;

    // The panel confers in the room, so the editor steps aside while the answer is out.
    setIdeVisible(false);
    $("submitCode").disabled = true;
    const result = await submitAnswer(text, { coding: { integrity: integrityPayload() } });
    $("submitCode").disabled = false;
    submitting = false;

    if (result.ok) {
      // The panel's reply may already have opened the next coding problem; keep that one.
      if (problem === submitted) {
        problem = null;
      }
      return;
    }

    // Nothing reached the panel, so the code is still here and the candidate can submit again.
    setIdeVisible(true);
    $("testSummary").textContent = `The panel didn't get your code (${result.error}). Submit again.`;
    setStatus("Coding round. Your code is still in the editor.");
  }

  $("submitCode").onclick = submit;

  // ---------- chat with Theo ----------

  function addChatLine(who, text, extraClass = "") {
    const line = document.createElement("div");
    line.className = `msg ${who === "tech" ? "theo" : "me"} ${extraClass}`.trim();
    line.innerHTML = `<b>${who === "tech" ? "Theo" : "You"}</b><span>${esc(text)}</span>`;
    $("chatLog").append(line);
    $("chatLog").scrollTop = $("chatLog").scrollHeight;
    return line;
  }

  function say(text) {
    // speak resolves when the line ends; a voice failure must never break the chat
    Promise.resolve(speak("tech", text)).catch(() => {});
  }

  async function sendChat() {
    const message = chatBox.value.trim();
    if (!message || !problem || chatting) {
      return;
    }
    stopDictation();
    chatting = true;
    const round = chatRound;
    $("chatSend").disabled = true;

    addChatLine("candidate", message);
    chatBox.value = "";
    const pending = addChatLine("tech", "…", "pending");

    try {
      const { id, state } = getSession();
      const out = await api("/api/coding-chat", {
        session_id: id,
        state,
        message,
        code: codeEl.value,
        context: { seconds: secondsOpen(), last_run: runSummary(lastRun) },
      });
      if (round !== chatRound) {
        pending.remove();
        return;
      }
      setSessionState(out.state);
      pending.remove();
      addChatLine("tech", out.reply);
      say(out.reply);
    } catch (err) {
      pending.remove();
      addChatLine("tech", `(Theo didn't catch that: ${err.message})`, "error");
      // give the message back so the candidate doesn't have to retype it
      if (!chatBox.value) {
        chatBox.value = message;
      }
    } finally {
      chatting = false;
      $("chatSend").disabled = false;
    }
  }

  $("chatSend").onclick = sendChat;
  chatBox.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendChat();
    }
  });

  // Typing to Theo cuts him off, like interrupting a person.
  chatBox.addEventListener("input", () => {
    stopSpeaking();
  });

  // ---------- dictation into the chat ----------

  // The same recorder as the main answer box: the browser's guess shows while the candidate
  // talks, then the server's transcript replaces it. Starting it also cuts Theo off.
  const chatMic = bindMicButton($("chatMic"), chatBox, { idleLabel: "🎙", stopLabel: "■", busyLabel: "…" });

  // Sending or submitting mid sentence keeps what the preview heard and drops the recording.
  function stopDictation() {
    chatMic.stopRec();
  }

  // ---------- open ----------

  function open(p) {
    problem = p;
    lastRun = null;
    submitting = false;
    chatRound++;
    stats = freshStats();

    $("pTitle").textContent = p.title;
    $("pDesc").textContent = p.description;
    $("langSel").value = lang;
    showLang();
    codeEl.value = starterFor(lang);
    $("testSummary").textContent = `${p.tests.length} hidden tests`;
    $("testList").innerHTML = "";
    $("pasteNote").classList.add("hidden");
    $("judgeNote").classList.add("hidden");
    $("chatLog").innerHTML = "";
    chatBox.value = "";

    if (lang === "python" && !pyWorker) {
      startPyWorker();
    }
    setIdeVisible(true);

    // Theo opens by asking for the approach, so talking first is the expected move.
    const opener = p.opener || FALLBACK_OPENER;
    addChatLine("tech", opener);
    say(opener);
    chatBox.focus();
  }

  return {
    open,
    isOpen: () => Boolean(problem),
  };
}
