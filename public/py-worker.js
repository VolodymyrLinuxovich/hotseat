// Runs candidate Python against the hidden tests with Pyodide (CPython compiled to WebAssembly).
// The page starts this worker when the coding round opens, so Pyodide is loaded before the first run.
importScripts("https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js");

const ready = loadPyodide();
ready.then(() => postMessage({ ready: true }));

const HARNESS = `
import json

def _hotseat_run(src, fn_name, tests_json):
    ns = {}
    try:
        exec(src, ns)
        f = ns[fn_name]
    except KeyError:
        return json.dumps({"compileError": f"No function named {fn_name}"})
    except Exception as ex:
        return json.dumps({"compileError": f"{type(ex).__name__}: {ex}"})
    results = []
    for t in json.loads(tests_json):
        args = json.loads(t["args_json"])
        expected = json.loads(t["expected_json"])
        try:
            got = f(*args)
            # Round-trip through JSON so tuples compare equal to lists.
            got_json = json.dumps(got)
            passed = json.loads(got_json) == expected
        except Exception as ex:
            got_json = f"error: {type(ex).__name__}: {ex}"
            passed = False
        results.append({"args": t["args_json"], "expected": t["expected_json"], "got": got_json, "pass": passed})
    return json.dumps({"results": results})
`;

let harnessLoaded = false;

onmessage = async (e) => {
  const py = await ready;
  if (!harnessLoaded) {
    py.runPython(HARNESS);
    harnessLoaded = true;
  }
  postMessage({ started: true });
  const { code, fn, tests } = e.data;
  try {
    const run = py.globals.get("_hotseat_run");
    const out = run(code, fn, JSON.stringify(tests));
    postMessage(JSON.parse(out));
  } catch (err) {
    postMessage({
      compileError: String(err.message || err)
        .split("\n")
        .slice(-2)
        .join(" "),
    });
  }
};
