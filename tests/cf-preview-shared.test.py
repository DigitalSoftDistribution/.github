#!/usr/bin/env python3
"""Offline test of .github/workflows/cf-preview-shared.yml (G-466 OSP-infra 3.1, T-14303) and its test caller
tests/fixtures/cf-preview-caller.yml.
usage: bash tests/cf-preview-shared.test.sh    (needs bash, jq, python3 with PyYAML)
       python3 -I tests/cf-preview-shared.test.py [<workflow.yml> [<caller.yml>]]

Job `if` and `runs-on` values are evaluated with the expression evaluator of tests/ci-shared-routing.test.py. Checked:
  1. runner: every job runs on `runner`, which defaults to coolify-ci; no job names a GitHub-hosted label.
  2. gating: the caller's deploy is false while vars.CF_PREVIEW_DEPLOY is unset, and then only `plan` runs, for every
     PR action; with deploy true an open PR runs `preview`, a closed one `cleanup`, a skipped draft neither; a fork PR
     runs nothing.
  3. secrets: each one is declared and optional, and reaches only step env of `preview` / `cleanup`; the steps that run
     project code (install, build, probes with the verify command) get no Cloudflare or Supabase token; no `run:`
     holds a ${{ }} expression (inputs reach the shell through env only).
  4. caller: its `with` keys exist, the required inputs are given, it grants every permission a called job asks for,
     and it lists ready_for_review and closed.
  5. plan step, run in bash under a cleared environment with a stub `gh`: database pick (own, shared, none), cleanup on
     close, draft skip, and exit 2 on each invalid input.
  6. Worker Previews step, run the same way with a stub `wrangler`: arguments, the previews.hyperdrive rewrite of a
     JSONC config (comments, trailing commas, a // inside a string), the shared-branch path, and the refusals.
Negative control: the same checks must FAIL on six mutations of the workflow (one per guarded property)."""
import copy
import importlib.util
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile

try:
    import yaml
except ImportError:
    sys.exit("cf-preview-shared tests: needs PyYAML (pip install pyyaml)")

HERE = os.path.dirname(os.path.abspath(__file__))
WF = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "..", ".github", "workflows", "cf-preview-shared.yml")
CALLER = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, "fixtures", "cf-preview-caller.yml")

# The evaluator of the routing test is loaded as a module; no __pycache__ is left in tests/.
sys.dont_write_bytecode = True
_spec = importlib.util.spec_from_file_location("ci_shared_routing", os.path.join(HERE, "ci-shared-routing.test.py"))
R = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(R)
value, cond, doc_on, text = R.value, R.cond, R.doc_on, R.text

REPO = "DigitalSoftDistribution/zephr"
SB_REF = "abcdefghijklmnopqrst"
HID = "0123456789abcdef0123456789abcdef"
HOSTED = re.compile(r"ubuntu|macos|windows", re.I)
CODE_STEPS = ("Install the project", "Build the project", "Install wrangler", "Probes")
TOKENS = ("CLOUDFLARE_API_TOKEN", "SUPABASE_ACCESS_TOKEN")


def load(path):
    with open(path, encoding="utf-8") as f:
        return yaml.safe_load(f)


def caller_with(caller, vars_):
    w = caller["jobs"]["cf-preview"]["with"]
    return {k: value(v, {"vars": vars_}) for k, v in w.items()}


def ctx(doc, caller=None, vars_=None, action="synchronize", draft=False, fork=False, inputs=None, plan=None, steps=None):
    ins = {k: v.get("default") for k, v in doc_on(doc)["workflow_call"]["inputs"].items()}
    if caller is not None:
        ins.update(caller_with(caller, vars_ or {}))
    ins.update(inputs or {})
    pr = {"number": 7, "draft": draft, "head": {"sha": "a" * 40, "ref": "g1/topic", "repo": {"full_name": "someone/zephr" if fork else REPO}}}
    return {"github": {"event_name": "pull_request", "repository": REPO, "token": "ghs-test", "run_id": 99,
                       "server_url": "https://github.com", "event": {"action": action, "pull_request": pr}},
            "inputs": ins, "vars": dict(vars_ or {}), "needs": {"plan": {"outputs": dict(plan or {})}},
            "steps": steps or {}, "secrets": {k: "tok" for k in doc_on(doc)["workflow_call"]["secrets"]}}


def runs(doc, name, c):
    return cond(doc["jobs"][name].get("if", "true"), c)


def check_runner(doc, caller):
    bad = []
    if doc_on(doc)["workflow_call"]["inputs"]["runner"].get("default") != "coolify-ci":
        bad.append("runner does not default to coolify-ci")
    for name, job in doc["jobs"].items():
        ro = job.get("runs-on")
        if HOSTED.search(str(ro)):
            bad.append(f"{name}: runs-on names a GitHub-hosted label: {ro!r}")
        got = value(ro, ctx(doc, caller))
        if got != "coolify-ci":
            bad.append(f"{name}: runs on {got!r} with default inputs")
    return bad


def check_gating(doc, caller):
    bad = []
    for vars_, want in (({}, False), ({"CF_PREVIEW_DEPLOY": "false"}, False), ({"CF_PREVIEW_DEPLOY": "true"}, True)):
        got = caller_with(caller, vars_)["deploy"]
        if got is not want:
            bad.append(f"caller deploy with vars {vars_}: want {want}, got {got!r}")
    dry = {}
    for action, plan_action in (("opened", "preview"), ("synchronize", "preview"), ("ready_for_review", "preview"), ("closed", "cleanup")):
        c = ctx(doc, caller, dry, action=action, plan={"action": plan_action})
        got = [j for j in doc["jobs"] if runs(doc, j, c)]
        if got != ["plan"]:
            bad.append(f"dry run, PR {action}: want only plan, got {got}")
    live = {"CF_PREVIEW_DEPLOY": "true"}
    for label, kw, want in [
        ("open PR", dict(plan={"action": "preview"}), ["plan", "preview"]),
        ("closed PR", dict(action="closed", plan={"action": "cleanup"}), ["plan", "cleanup"]),
        ("skipped draft", dict(draft=True, plan={"action": "skip"}), ["plan"]),
    ]:
        got = [j for j in doc["jobs"] if runs(doc, j, ctx(doc, caller, live, **kw))]
        if got != want:
            bad.append(f"deploy true, {label}: want {want}, got {got}")
    if runs(doc, "plan", ctx(doc, caller, live, fork=True)):
        bad.append("a fork PR runs plan (and with it the jobs that hold secrets)")
    for name in ("preview", "cleanup"):
        if doc["jobs"][name].get("needs") != "plan":
            bad.append(f"{name} does not need plan")
    return bad


def walk(node, path=()):
    if isinstance(node, dict):
        for k, v in node.items():
            yield from walk(v, path + (k,))
    elif isinstance(node, list):
        for i, v in enumerate(node):
            yield from walk(v, path + (i,))
    elif isinstance(node, str):
        yield path, node


def check_secrets(doc, caller):
    bad = []
    declared = doc_on(doc)["workflow_call"]["secrets"]
    for k, v in declared.items():
        if (v or {}).get("required") is not False:
            bad.append(f"secret {k} is not required: false (a dry run must need none)")
    for path, s in walk(doc["jobs"]):
        for expr in re.findall(r"\$\{\{(.*?)\}\}", s, re.S):
            for name in re.findall(r"secrets\.([A-Za-z_][A-Za-z0-9_]*)", expr):
                where = "/".join(map(str, path))
                if name not in declared:
                    bad.append(f"{where}: secret {name} is not declared")
                if path[0] not in ("preview", "cleanup") or len(path) != 5 or path[1] != "steps" or path[3] != "env":
                    bad.append(f"{where}: secret {name} outside the step env of preview / cleanup")
        if path and path[-1] == "run" and "${{" in s:
            bad.append(f"{'/'.join(map(str, path))}: a ${{{{ }}}} expression inside run (pass it through env)")
    for job in ("preview", "cleanup"):
        if "inputs.deploy" not in str(doc["jobs"][job].get("if", "")):
            bad.append(f"{job}: its if does not test inputs.deploy")
        for step in doc["jobs"][job]["steps"]:
            env = step.get("env") or {}
            if step.get("name") in CODE_STEPS:
                for t in TOKENS:
                    if t in env or any(f"secrets.{t}" in str(v) for v in env.values()):
                        bad.append(f"{job}/{step['name']}: runs project code but gets {t}")
    if any("secrets." in s for _, s in walk(doc["jobs"]["plan"])):
        bad.append("plan reads a secret")
    return bad


def check_caller(doc, caller):
    bad = []
    job = caller["jobs"]["cf-preview"]
    if not str(job.get("uses", "")).endswith("/.github/workflows/cf-preview-shared.yml@main"):
        bad.append(f"caller uses {job.get('uses')!r}")
    inputs = doc_on(doc)["workflow_call"]["inputs"]
    given = set(job.get("with") or {})
    bad += [f"caller passes unknown input {k}" for k in sorted(given - set(inputs))]
    bad += [f"caller misses required input {k}" for k, v in inputs.items() if v.get("required") and k not in given]
    types = set(doc_on(caller)["pull_request"]["types"])
    bad += [f"caller pull_request types lack {t}" for t in ("ready_for_review", "closed") if t not in types]
    granted = {**(caller.get("permissions") or {}), **(job.get("permissions") or {})}
    rank = {"none": 0, "read": 1, "write": 2}
    for name, j in doc["jobs"].items():
        for scope, level in (j.get("permissions") or {}).items():
            if rank[granted.get(scope, "none")] < rank[level]:
                bad.append(f"job {name} asks {scope}: {level}, the caller grants {granted.get(scope, 'none')}")
    return bad


GH_STUB = r"""#!/bin/bash
echo "gh $*" >> "$FAKE_LOG"
[ -z "${FAKE_GH_FAIL:-}" ] || exit 1
printf '%s' "${FAKE_FILES:-}"
"""
WRANGLER_STUB = r"""#!/bin/bash
cfg=""; prev=""
for a in "$@"; do [ "$prev" = --config ] && cfg=$a; prev=$a; done
printf 'wrangler|%s|%s|%s\n' "$(basename "$PWD")" "$cfg" "$*" >> "$FAKE_LOG"
[ -z "${FAKE_NO_JSON:-}" ] || { echo "not json"; exit 0; }
printf '{"preview":{"urls":["https://pr-7-%s.example.workers.dev/"]}}\n' "$(basename "$PWD")"
"""
WEB_JSONC = """// web Worker (test fixture)
{
  "name": "zephr-web-edge", // a line comment
  "main": ".open-next/worker.js",
  "vars": {"DOCS": "https://example.com/a//b", "Q": "say \\"hi\\" /* not a comment */"},
  /* a block
     comment */
  "hyperdrive": [{"binding": "HYPERDRIVE", "id": "11111111111111111111111111111111"}],
  "previews": {
    "hyperdrive": [{"binding": "HYPERDRIVE", "id": "00000000000000000000000000000000",},],
  },
}
"""
RUNTIME_JSONC = '{"name": "zephr-worker-runtime", "main": "dist/cloudflare.js", "previews": {}}\n'
BASH = shutil.which("bash", path="/usr/bin:/bin") or shutil.which("bash")
JQ = shutil.which("jq", path="/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin")


def sandbox():
    tmp = tempfile.mkdtemp(prefix="cf-preview-test-")
    b = os.path.join(tmp, "bin")
    os.mkdir(b)
    for name, body in (("gh", GH_STUB), ("wrangler", WRANGLER_STUB), ("jq", f'#!/bin/sh\nexec "{JQ}" "$@"\n'),
                       ("python3", f'#!/bin/sh\nexec "{sys.executable}" "$@"\n')):
        p = os.path.join(b, name)
        with open(p, "w", encoding="utf-8") as f:
            f.write(body)
        os.chmod(p, os.stat(p).st_mode | stat.S_IXUSR)
    return tmp


def run_step(script, env, cwd, tmp):
    path = os.path.join(tmp, "step.sh")
    with open(path, "w", encoding="utf-8") as f:
        f.write(script)
    out, summary = os.path.join(tmp, "github_output"), os.path.join(tmp, "summary.md")
    for p in (out, summary):
        open(p, "w").close()
    full = {"PATH": f"{tmp}/bin:/usr/bin:/bin", "HOME": tmp, "TMPDIR": tmp, "RUNNER_TEMP": tmp, "GITHUB_OUTPUT": out,
            "GITHUB_STEP_SUMMARY": summary, "FAKE_LOG": os.path.join(tmp, "log")}
    full.update(env)
    p = subprocess.run([BASH, "--noprofile", "--norc", "-eo", "pipefail", path], cwd=cwd, env=full,
                       capture_output=True, text=True, timeout=60)
    with open(out, encoding="utf-8") as f:
        outputs = dict(line.split("=", 1) for line in f.read().splitlines() if "=" in line)
    with open(summary, encoding="utf-8") as f:
        outputs["_summary"] = f.read()
    log = os.path.join(tmp, "log")
    outputs["_log"] = open(log, encoding="utf-8").read() if os.path.exists(log) else ""
    return p.returncode, p.stdout + p.stderr, outputs


def step_env(step, c):
    return {k: text(value(v, c)) for k, v in (step.get("env") or {}).items()}


def plan_run(doc, caller, files="", vars_=None, env_extra=None, **kw):
    v = {"SUPABASE_PREVIEW_BASE_REF": SB_REF}
    v.update(vars_ or {})
    step = doc["jobs"]["plan"]["steps"][0]
    env = step_env(step, ctx(doc, caller, v, **kw))
    env["FAKE_FILES"] = files
    env.update(env_extra or {})
    tmp = sandbox()
    try:
        return run_step(step["run"], env, tmp, tmp)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def bad_worker(**over):
    w = {"id": "web", "dir": "apps/web"}
    w.update(over)
    return json.dumps([w])


INVALID = [
    ("project Zephr", dict(inputs={"project": "Zephr"})),
    ("project of one letter", dict(inputs={"project": "z"})),
    ("workers not JSON", dict(inputs={"workers": "web apps/web"})),
    ("workers empty", dict(inputs={"workers": "[]"})),
    ("unknown worker key", dict(inputs={"workers": bad_worker(name="x")})),
    ("duplicate ids", dict(inputs={"workers": json.dumps([{"id": "a", "dir": "x"}, {"id": "a", "dir": "y"}])})),
    ("dir with ..", dict(inputs={"workers": bad_worker(dir="apps/../../etc")})),
    ("absolute dir", dict(inputs={"workers": bad_worker(dir="/etc")})),
    ("config with a path", dict(inputs={"workers": bad_worker(config="../wrangler.toml")})),
    ("probe without /", dict(inputs={"workers": bad_worker(probe="api/ready")})),
    ("lower-case binding", dict(inputs={"workers": bad_worker(hyperdrive_binding="hyperdrive")})),
    ("empty verify", dict(inputs={"workers": bad_worker(verify="")})),
    ("wrangler 4.134.9", dict(inputs={"wrangler-version": "4.134.9"})),
    ("wrangler 4.151", dict(inputs={"wrangler-version": "4.151"})),
    ("wait 0", dict(inputs={"branch-wait-minutes": 0})),
    ("wait 31", dict(inputs={"branch-wait-minutes": 31})),
    ("migration path ..", dict(inputs={"migration-paths": "../supabase"})),
    ("supabase ref abc", dict(vars_={"SUPABASE_PREVIEW_BASE_REF": "abc"})),
    ("environment with a space", dict(inputs={"environment": "pre view"})),
    ("cli-artifact with a space", dict(inputs={"cli-artifact": "zephr cli"})),
    ("PR file list fails", dict(env_extra={"FAKE_GH_FAIL": "1"})),
]


def check_plan_exec(doc, caller):
    bad = []

    def expect(label, want, **kw):
        rc, out, o = plan_run(doc, caller, **kw)
        if rc != 0:
            bad.append(f"{label}: rc {rc}: {out.strip()[:200]}")
            return o
        for k, v in want.items():
            if o.get(k) != v:
                bad.append(f"{label}: {k} = {o.get(k)!r}, want {v!r}")
        return o

    o = expect("migration change", {"action": "preview", "db": "own"}, files="README.md\nsupabase/migrations/20260101000000_x.sql\n")
    if o.get("workers"):
        if [w["id"] for w in json.loads(o["workers"])] != ["web", "runtime"]:
            bad.append(f"migration change: workers output {o['workers'][:120]}")
        plan = json.loads(o.get("plan", "{}"))
        if plan.get("deploy") is not False or plan.get("pr") != 7 or plan.get("workers") != ["web", "runtime"]:
            bad.append(f"migration change: plan output {o.get('plan')}")
        if "Dry run" not in o["_summary"] or "CLOUDFLARE_API_TOKEN" not in o["_summary"] or "SUPABASE_ACCESS_TOKEN" not in o["_summary"]:
            bad.append("dry run summary does not name the dry run and the secrets a live run needs")
    o = expect("no migration change", {"action": "preview", "db": "shared"}, files="apps/web/page.tsx\nsupabase.md\n")
    if "pulls/7/files" not in o.get("_log", ""):
        bad.append("no migration change: the PR file list was not read")
    o = expect("no supabase-project-ref", {"action": "preview", "db": "none"}, files="supabase/x.sql\n", vars_={"SUPABASE_PREVIEW_BASE_REF": ""})
    if "gh " in o.get("_log", ""):
        bad.append("no supabase-project-ref: gh was called")
    o = expect("closed PR", {"action": "cleanup", "db": "none"}, files="supabase/x.sql\n", action="closed")
    if "gh " in o.get("_log", ""):
        bad.append("closed PR: gh was called")
    expect("draft PR", {"action": "skip", "db": "none"}, draft=True)
    expect("draft PR, skip-drafts false", {"action": "preview"}, draft=True, inputs={"skip-drafts": False})
    expect("deploy true", {"action": "preview"}, vars_={"CF_PREVIEW_DEPLOY": "true"})
    for v in ("4.135.0", "5.0.0"):
        expect(f"wrangler {v}", {"action": "preview"}, inputs={"wrangler-version": v})
    for label, kw in INVALID:
        rc, out, _ = plan_run(doc, caller, files="supabase/x.sql\n", **kw)
        if rc != 2 or "::error" not in out:
            bad.append(f"invalid {label}: want rc 2 with ::error, got rc {rc}: {out.strip()[:160]}")
    return bad


def workers_run(doc, caller, db="own", workers=None, web=WEB_JSONC, web_name="wrangler.jsonc", env_extra=None):
    tmp = sandbox()
    ws = os.path.join(tmp, "ws")
    for d, name, body in (("apps/web", web_name, web), ("apps/worker/runtime", "wrangler.jsonc", RUNTIME_JSONC)):
        os.makedirs(os.path.join(ws, d))
        with open(os.path.join(ws, d, name), "w", encoding="utf-8") as f:
            f.write(body)
    if workers is None:
        workers = json.dumps(json.loads(caller_with(caller, {})["workers"]), separators=(",", ":"))
    c = ctx(doc, caller, {}, plan={"db": db, "workers": workers},
            steps={"db": {"outputs": {"hyperdrive_id": HID if db == "own" else ""}}})
    step = next(s for s in doc["jobs"]["preview"]["steps"] if s.get("id") == "workers")
    env = step_env(step, c)
    env["CF_WRANGLER"] = os.path.join(tmp, "bin", "wrangler")
    env.update(env_extra or {})
    rc, out, o = run_step(step["run"], env, ws, tmp)
    copies = {}
    for d in ("apps/web", "apps/worker/runtime"):
        p = os.path.join(ws, d, ".cf-preview-pr-7.json")
        if os.path.exists(p):
            with open(p, encoding="utf-8") as f:
                copies[d] = json.load(f)
    res = os.path.join(tmp, "cf-preview-workers.jsonl")
    results = [json.loads(line) for line in open(res, encoding="utf-8")] if os.path.exists(res) else []
    calls = [line.split("|") for line in o["_log"].splitlines() if line.startswith("wrangler|")]
    shutil.rmtree(tmp, ignore_errors=True)
    return rc, out, copies, results, calls


def check_workers_exec(doc, caller):
    bad = []
    rc, out, copies, results, calls = workers_run(doc, caller, db="own")
    if rc != 0:
        return [f"own branch: rc {rc}: {out.strip()[:300]}"]
    if len(calls) != 2 or any(c[2] != ".cf-preview-pr-7.json" or "preview --name pr-7 --json" not in c[3] for c in calls):
        bad.append(f"own branch: wrangler calls {calls}")
    web, rt = copies.get("apps/web", {}), copies.get("apps/worker/runtime", {})
    if web.get("previews", {}).get("hyperdrive") != [{"binding": "HYPERDRIVE", "id": HID}]:
        bad.append(f"own branch: web previews.hyperdrive {web.get('previews')}")
    if web.get("hyperdrive") != [{"binding": "HYPERDRIVE", "id": "1" * 32}]:
        bad.append("own branch: the production hyperdrive binding changed")
    if web.get("vars") != {"DOCS": "https://example.com/a//b", "Q": 'say "hi" /* not a comment */'}:
        bad.append(f"own branch: strings changed by the comment strip: {web.get('vars')}")
    if rt.get("previews", {}).get("hyperdrive") != [{"binding": "HYPERDRIVE", "id": HID}]:
        bad.append(f"own branch: runtime previews.hyperdrive {rt.get('previews')}")
    if [r.get("url") for r in results] != ["https://pr-7-web.example.workers.dev", "https://pr-7-runtime.example.workers.dev"]:
        bad.append(f"own branch: results {results}")
    rc, out, copies, results, calls = workers_run(doc, caller, db="shared")
    if rc != 0 or copies or len(calls) != 2 or any(c[2] for c in calls):
        bad.append(f"shared branch: want 2 calls without --config and no copies, got rc {rc}, {calls}, {list(copies)}")
    for label, kw, want in [
        ("TOML config, own branch", dict(web='name = "x"\n', web_name="wrangler.toml"), ".json or .jsonc"),
        ("no previews block, own branch", dict(web='{"name": "x"}'), "no previews block"),
        ("wrangler prints no JSON", dict(db="shared", env_extra={"FAKE_NO_JSON": "1"}), "no .preview.urls[0]"),
        ("missing directory", dict(db="shared", workers='[{"id":"web","dir":"apps/missing"}]'), "does not exist"),
    ]:
        rc, out, _, _, _ = workers_run(doc, caller, **kw)
        if rc == 0 or want not in out:
            bad.append(f"{label}: want a failure naming {want!r}, got rc {rc}: {out.strip()[:200]}")
    return bad


CHECKS = (("runner", check_runner), ("gating", check_gating), ("secrets", check_secrets), ("caller", check_caller),
          ("plan step", check_plan_exec), ("Worker Previews step", check_workers_exec))


def step_of(d, job, pred):
    return next(s for s in d["jobs"][job]["steps"] if pred(s))


def mutations(doc):
    out = {}
    d = copy.deepcopy(doc)
    d["jobs"]["preview"]["if"] = "needs.plan.outputs.action == 'preview'"
    out["preview without the deploy flag"] = (d, check_gating)
    d = copy.deepcopy(doc)
    d["jobs"]["plan"]["runs-on"] = "ubuntu-latest"
    out["plan on ubuntu-latest"] = (d, check_runner)
    d = copy.deepcopy(doc)
    step_of(d, "preview", lambda s: s.get("name") == "Build the project")["env"]["CLOUDFLARE_API_TOKEN"] = "${{ secrets.CLOUDFLARE_API_TOKEN }}"
    out["build step gets the Cloudflare token"] = (d, check_secrets)
    d = copy.deepcopy(doc)
    d["jobs"]["plan"]["if"] = "github.event_name == 'pull_request'"
    out["no fork guard"] = (d, check_gating)
    d = copy.deepcopy(doc)
    s = d["jobs"]["plan"]["steps"][0]
    s["run"] = s["run"].replace(' and (contains("..") | not)', "")
    out["dir .. accepted"] = (d, check_plan_exec) if s["run"] != doc["jobs"]["plan"]["steps"][0]["run"] else (doc, lambda *_: [])
    d = copy.deepcopy(doc)
    s = step_of(d, "preview", lambda x: x.get("id") == "workers")
    before = s["run"]
    s["run"] = before.replace('hit["id"] = hid', "pass")
    out["rewrite keeps the old id"] = (d, check_workers_exec) if s["run"] != before else (doc, lambda *_: [])
    return out


def main():
    if not BASH or not JQ:
        print("cf-preview-shared tests: needs bash and jq")
        return 2
    doc, caller = load(WF), load(CALLER)
    fails = 0
    print(f"cf-preview-shared test: {WF} with {CALLER}")
    for name, fn in CHECKS:
        bad = fn(doc, caller)
        print(f"  {'ok  ' if not bad else 'FAIL'} {name}")
        for b in bad:
            print(f"       {b}")
        fails += bool(bad)
    if fails:
        print(f"FAILED: {fails} (negative control skipped: the workflow itself fails)")
        return 1
    print("negative control (each mutation must fail):")
    for name, (d, fn) in mutations(doc).items():
        bad = fn(d, caller)
        print(f"  {'ok  ' if bad else 'FAIL'} {name}: {len(bad)} finding(s){' - ' + bad[0] if bad else ''}")
        fails += not bad
    print("PASS" if not fails else f"FAILED: {fails}")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
