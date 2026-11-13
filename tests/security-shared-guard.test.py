#!/usr/bin/env python3
"""Guard test for the jobs of .github/workflows/security-shared.yml (G-218 T-11229, extended by T-11386).
usage: bash tests/security-shared-guard.test.sh    (needs python3 with PyYAML)
       python3 -I tests/security-shared-guard.test.py [<new.yml> [<old.yml>]]
The new file is GL_WF or the workflow in this repo; the old file (the negative control) is GL_OLD or tests/fixtures/security-shared.before-t11229.yml,
the workflow as it was before the fresh-HOME change (main at 0cdfadf), kept byte for byte so the control cannot drift.

Part 1, shape: in the gitleaks, npm-audit, trivy, codeql and zap-baseline jobs the first step is the isolate step, the checkout
keeps no credentials, the guard step follows it (zap-baseline has no checkout: the guard is its second step), the job env fixes
PATH and PYTHONNOUSERSITE, the shell is an absolute path and no step overrides it. T-11386 adds: npm-audit has no
actions/setup-node, a pinned and sha256-checked node step and a tool guard before the audit; the gitleaks job env holds no
licence, the licensed action gets it in its own env with TMPDIR under RUNNER_TEMP, and a guard step follows it.
The same checks FAIL on the old file (negative control) and on mutations of the new one.
Part 2, behaviour: the isolate step, the guard step and npm-audit's tool guard, extracted from the YAML, run in bash under a
cleared environment. The runner's cache root and the "image PATH" are fixture directories (each guard text is patched on exactly
two lines, asserted), so no root and no /gha-cache are needed. Green on a clean job, red on each way the cache can still reach it."""
import copy
import os
import re
import shutil
import subprocess
import sys
import tempfile

try:
    import yaml
except ImportError:
    sys.exit("security-shared guard tests: needs PyYAML (pip install pyyaml)")

HERE = os.path.dirname(os.path.abspath(__file__))
NEW = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("GL_WF") or os.path.join(HERE, "..", ".github", "workflows", "security-shared.yml")
OLD = sys.argv[2] if len(sys.argv) > 2 else os.environ.get("GL_OLD") or os.path.join(HERE, "fixtures", "security-shared.before-t11229.yml")
SAFE = "/usr/bin:/bin:/usr/sbin:/sbin"
SHELL = "/usr/bin/bash --noprofile --norc -eo pipefail {0}"
JOBS = ("gitleaks", "npm-audit", "trivy", "codeql", "zap-baseline")
# the ZAP scan reads only the preview URL: that job has no checkout, its guard is the second step
NO_CHECKOUT = ("zap-baseline",)
fails = 0


def check(label, got, want):
    global fails
    if got == want:
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label} (want {want!r} got {got!r})")
        fails += 1


def load(path):
    return yaml.safe_load(open(path, encoding="utf-8"))


def shape(doc, job):
    """Everything wrong with one job, as a list of short strings (empty = hardened)."""
    j = doc["jobs"][job]
    bad = []
    steps = j.get("steps", [])
    env = j.get("env", {}) or {}
    if env.get("PATH") != SAFE:
        bad.append("job env PATH is not the fixed one")
    if str(env.get("PYTHONNOUSERSITE")) != "1":
        bad.append("job env PYTHONNOUSERSITE is not 1")
    if (j.get("defaults", {}).get("run", {}) or {}).get("shell") != SHELL:
        bad.append("defaults.run.shell is not the absolute one")
    if not steps or not str(steps[0].get("name", "")).startswith("isolate") or "uses" in steps[0]:
        bad.append("first step is not the inline isolate step")
    if job in NO_CHECKOUT:
        if len(steps) < 2 or not str(steps[1].get("name", "")).startswith("runner cache guard"):
            bad.append("second step is not the runner cache guard")
        if any(str(s.get("uses", "")).startswith("actions/checkout@") for s in steps):
            bad.append("a checkout in a job that needs none")
    else:
        if len(steps) < 3 or not str(steps[1].get("uses", "")).startswith("actions/checkout@"):
            bad.append("second step is not the checkout")
        elif (steps[1].get("with") or {}).get("persist-credentials") is not False:
            bad.append("checkout does not set persist-credentials: false")
        if len(steps) < 3 or not str(steps[2].get("name", "")).startswith("runner cache guard"):
            bad.append("third step is not the runner cache guard")
    for s in steps:
        if "shell" in s:
            bad.append(f"step {s.get('name', s.get('uses'))!r} overrides the shell")
        if str(s.get("uses", "")).startswith("actions/cache@"):
            bad.append("actions/cache in the job")
    return bad


NODE_VERSION_RE = re.compile(r"^\d+\.\d+\.\d+$")
HEX64 = re.compile(r"^[0-9a-f]{64}$")


def t11386(doc):
    """What T-11386 asks of node/pnpm in npm-audit and of the licensed gitleaks path that is missing (empty = done)."""
    bad = []
    na = doc["jobs"]["npm-audit"]["steps"]
    uses = [str(s.get("uses", "")) for s in na]
    names = [str(s.get("name", "")) for s in na]
    if any(u.startswith("actions/setup-node@") for u in uses):
        bad.append("npm-audit still uses actions/setup-node (node from the runner's tool cache)")

    def first(seq, pred):
        return next((i for i, x in enumerate(seq) if pred(x)), -1)

    node = first(names, lambda n: n.startswith("node (pinned"))
    tg = first(names, lambda n: n.startswith("tool guard"))
    audit = first(names, lambda n: n.startswith("Audit"))
    pn = first(uses, lambda u: u.startswith("pnpm/action-setup@"))
    if node < 0:
        bad.append("npm-audit has no pinned node step")
    if tg < 0:
        bad.append("npm-audit has no tool guard step")
    if not (0 <= pn < tg and 0 <= node < tg < audit):
        bad.append("the tool guard does not run after pnpm/action-setup and the node step, and before the audit")
    if node >= 0:
        env, run = na[node].get("env") or {}, str(na[node].get("run", ""))
        if not NODE_VERSION_RE.match(str(env.get("NODE_VERSION", ""))):
            bad.append("NODE_VERSION is not an exact version")
        if not all(HEX64.match(str(env.get(k, ""))) for k in ("NODE_SHA256_X64", "NODE_SHA256_ARM64")):
            bad.append("the node sha256 pins are not 64 hex digits")
        if "sha256sum -c" not in run or '"$dir/bin" >> "$GITHUB_PATH"' not in run or "https://nodejs.org/dist/" not in run:
            bad.append("the node step does not check the sha256 and install under RUNNER_TEMP")
        if re.search(r"RUNNER_TOOL_CACHE|toolcache|/gha-cache", run):
            bad.append("the node step reads the tool cache")
    gj = doc["jobs"]["gitleaks"]
    if "GITLEAKS_LICENSE" in (gj.get("env") or {}):
        bad.append("the gitleaks job env holds the licence itself")
    for s in gj["steps"]:
        if re.search(r"env\.GITLEAKS_LICENSE(?!D)", str(s.get("if", ""))):
            bad.append(f"step {s.get('name', s.get('uses'))!r} reads the licence in its if")
    lic = [i for i, s in enumerate(gj["steps"]) if str(s.get("uses", "")).startswith("gitleaks/gitleaks-action@")]
    if len(lic) != 1:
        bad.append("not exactly one licensed gitleaks action step")
    else:
        s = gj["steps"][lic[0]]
        le = s.get("env") or {}
        if le.get("TMPDIR") != "${{ runner.temp }}":
            bad.append("the licensed action's TMPDIR is not runner.temp")
        if le.get("GITLEAKS_LICENSE") != "${{ secrets.GITLEAKS_LICENSE }}":
            bad.append("the licensed action does not get the licence in its own env")
        if "env.GITLEAKS_LICENSED == 'true'" not in str(s.get("if", "")):
            bad.append("the licensed action's if does not read GITLEAKS_LICENSED")
        nxt = gj["steps"][lic[0] + 1] if lic[0] + 1 < len(gj["steps"]) else {}
        if not str(nxt.get("name", "")).startswith("gitleaks (licensed action) guard"):
            bad.append("no guard step right after the licensed action")
    return bad


def step_run(doc, job, prefix):
    hits = [s["run"] for s in doc["jobs"][job]["steps"] if str(s.get("name", "")).startswith(prefix)]
    if len(hits) != 1:
        # a workflow that does not have the step at all (the negative-control file, or a broken edit) fails the run here, said plainly
        print(f"  FAIL {job}: {len(hits)} steps named {prefix}*, want 1")
        print(f"security-shared guard tests: {fails + 1} FAILED")
        sys.exit(1)
    return hits[0]


new, old = load(NEW), load(OLD)

print("shape, new file")
for job in JOBS:
    check(f"{job}: hardened", shape(new, job), [])
check("T-11386: node/pnpm off the tool cache, licensed gitleaks off the shared cache", t11386(new), [])
if fails:
    # the mutation, scope and behaviour checks below read the hardened shape; on a file without it they would only crash
    print(f"security-shared guard tests: {fails} FAILED (the file under test is not hardened; the checks below need that shape)")
    sys.exit(1)
print("shape, negative control: the old file")
for job in JOBS:
    got = shape(old, job)
    check(f"{job}: the old file is flagged ({len(got)} findings)", len(got) >= 6, True)
got = t11386(old)
check(f"T-11386: the old file is flagged ({len(got)} findings)", len(got) >= 8, True)
print("shape, mutations of the new file are flagged")


def mutate(fn):
    d = copy.deepcopy(new)
    fn(d)
    return d


m1 = mutate(lambda d: d["jobs"]["trivy"]["steps"][1]["with"].pop("persist-credentials"))
check("trivy checkout without persist-credentials: flagged", "checkout does not set persist-credentials: false" in shape(m1, "trivy"), True)
m2 = mutate(lambda d: d["jobs"]["npm-audit"]["steps"][4].update(shell="bash"))
check("a step-level `shell: bash` in npm-audit: flagged", any("overrides the shell" in b for b in shape(m2, "npm-audit")), True)
m3 = mutate(lambda d: d["jobs"]["gitleaks"]["env"].pop("PATH"))
check("gitleaks without the fixed PATH: flagged", "job env PATH is not the fixed one" in shape(m3, "gitleaks"), True)
m4 = mutate(lambda d: d["jobs"]["trivy"]["steps"].pop(2))
check("trivy without the guard step: flagged", "third step is not the runner cache guard" in shape(m4, "trivy"), True)
m5 = mutate(lambda d: d["jobs"]["codeql"]["steps"][1]["with"].pop("persist-credentials"))
check("codeql checkout without persist-credentials: flagged", "checkout does not set persist-credentials: false" in shape(m5, "codeql"), True)
m6 = mutate(lambda d: [s for s in d["jobs"]["zap-baseline"]["steps"] if str(s.get("name", "")).startswith("ZAP summary")][0].update(shell="bash"))
check("a `shell: bash` back on the ZAP summary: flagged", any("overrides the shell" in b for b in shape(m6, "zap-baseline")), True)
m7 = mutate(lambda d: d["jobs"]["zap-baseline"]["steps"].pop(1))
check("zap-baseline without the guard step: flagged", "second step is not the runner cache guard" in shape(m7, "zap-baseline"), True)


def node_back_to_setup_node(d):
    st = d["jobs"]["npm-audit"]["steps"]
    i = [k for k, s in enumerate(st) if str(s.get("name", "")).startswith("node (pinned")][0]
    st[i] = {"uses": "actions/setup-node@v4", "with": {"node-version": "22"}}


m8 = mutate(node_back_to_setup_node)
check("actions/setup-node back in npm-audit: flagged",
      ("npm-audit still uses actions/setup-node (node from the runner's tool cache)" in t11386(m8), "npm-audit has no pinned node step" in t11386(m8)), (True, True))
m9 = mutate(lambda d: d["jobs"]["npm-audit"]["steps"].pop([k for k, s in enumerate(d["jobs"]["npm-audit"]["steps"]) if str(s.get("name", "")).startswith("tool guard")][0]))
check("npm-audit without the tool guard: flagged", "npm-audit has no tool guard step" in t11386(m9), True)
m10 = mutate(lambda d: [s for s in d["jobs"]["gitleaks"]["steps"] if str(s.get("uses", "")).startswith("gitleaks/gitleaks-action@")][0]["env"].pop("TMPDIR"))
check("the licensed action without TMPDIR under runner.temp: flagged", "the licensed action's TMPDIR is not runner.temp" in t11386(m10), True)
m11 = mutate(lambda d: d["jobs"]["gitleaks"]["env"].update(GITLEAKS_LICENSE="${{ secrets.GITLEAKS_LICENSE }}"))
check("the licence back in the gitleaks job env: flagged", "the gitleaks job env holds the licence itself" in t11386(m11), True)
m12 = mutate(lambda d: d["jobs"]["npm-audit"]["steps"][[k for k, s in enumerate(d["jobs"]["npm-audit"]["steps"]) if str(s.get("name", "")).startswith("node (pinned")][0]]["env"].update(NODE_SHA256_X64="0" * 63))
check("a node sha256 pin that is not 64 hex digits: flagged", "the node sha256 pins are not 64 hex digits" in t11386(m12), True)

print("scope: what this change does not touch")
for job in ("zap-baseline", "codeql"):
    check(f"{job}: if/runs-on/timeout/permissions unchanged",
          [new["jobs"][job].get(k) == old["jobs"][job].get(k) for k in ("if", "runs-on", "timeout-minutes", "permissions")], [True] * 4)


def by_uses(doc, job, prefix):
    return [s for s in doc["jobs"][job]["steps"] if str(s.get("uses", "")).startswith(prefix)]


def by_name(doc, job, prefix):
    return [s for s in doc["jobs"][job]["steps"] if str(s.get("name", "")).startswith(prefix)]


check("codeql: init and analyze unchanged",
      [by_uses(new, "codeql", u) == by_uses(old, "codeql", u) for u in ("github/codeql-action/init@", "github/codeql-action/analyze@")], [True, True])
check("zap-baseline: the scan step unchanged", by_name(new, "zap-baseline", "ZAP baseline scan") == by_name(old, "zap-baseline", "ZAP baseline scan"), True)
old_summary = dict(by_name(old, "zap-baseline", "ZAP summary")[0])
old_summary.pop("shell", None)
check("zap-baseline: the summary step unchanged but for its `shell: bash` line", by_name(new, "zap-baseline", "ZAP summary"), [old_summary])
check("gitleaks: the licensed action's uses and GITHUB_TOKEN unchanged",
      [(s["uses"], s["env"]["GITHUB_TOKEN"]) for s in by_uses(new, "gitleaks", "gitleaks/gitleaks-action@")],
      [(s["uses"], s["env"]["GITHUB_TOKEN"]) for s in by_uses(old, "gitleaks", "gitleaks/gitleaks-action@")])
check("gitleaks: needs/outputs/permissions/timeout unchanged",
      [new["jobs"]["gitleaks"].get(k) == old["jobs"]["gitleaks"].get(k) for k in ("outputs", "permissions", "timeout-minutes", "runs-on")],
      [True, True, True, True])
for job in ("npm-audit", "trivy"):
    check(f"{job}: needs/if/runs-on/timeout unchanged",
          [new["jobs"][job].get(k) == old["jobs"][job].get(k) for k in ("needs", "if", "runs-on", "timeout-minutes")], [True] * 4)
names = [s.get("uses") for s in new["jobs"]["npm-audit"]["steps"]]
gi = [i for i, s in enumerate(new["jobs"]["npm-audit"]["steps"]) if str(s.get("name", "")).startswith("runner cache guard")][0]
check("npm-audit: pnpm/action-setup unchanged and AFTER the guard; no actions/setup-node",
      [by_uses(new, "npm-audit", "pnpm/action-setup@") == by_uses(old, "npm-audit", "pnpm/action-setup@"),
       names.index("pnpm/action-setup@v4") > gi, "actions/setup-node@v4" not in names], [True, True, True])
tri = step_run(new, "trivy", "trivy fs")
check("trivy: no bare `command -v trivy` (the image's binary by absolute path)", "command -v trivy" not in tri and "/usr/local/bin/trivy" in tri, True)
gl = step_run(new, "gitleaks", "gitleaks (free binary fallback)")
check("gitleaks: the token reaches the one fetch through GIT_CONFIG_* and is unset before the scan binary",
      ("GIT_CONFIG_VALUE_0" in gl) and gl.index("unset READ_TOKEN") < gl.index("args=(detect"), True)
fb = [s for s in new["jobs"]["gitleaks"]["steps"] if str(s.get("name", "")).startswith("gitleaks (free binary fallback)")][0]
check("gitleaks: READ_TOKEN is set for pull_request_target only",
      fb["env"]["READ_TOKEN"], "${{ github.event_name == 'pull_request_target' && github.token || '' }}")

iso = {j: step_run(new, j, "isolate") for j in JOBS}
grd = {j: step_run(new, j, "runner cache guard") for j in JOBS}
check(f"the {len(JOBS)} isolate steps are one text", len(set(iso.values())), 1)
check(f"the {len(JOBS)} guard steps are one text", len(set(grd.values())), 1)
ISO, GUARD = iso["gitleaks"], grd["gitleaks"]

# ---------------------------------------------------------------- behaviour
T = tempfile.mkdtemp(prefix="sec-guard-")
try:
    RT, CACHE, BIN = f"{T}/runner-temp", f"{T}/gha-cache", f"{T}/bin"
    for d in (RT, f"{CACHE}/cargo/bin", f"{CACHE}/toolcache", BIN):
        os.makedirs(d)
    for t in ("bash", "git", "python3"):
        os.symlink(shutil.which(t), f"{BIN}/{t}")

    print("isolate step")
    ghenv = f"{T}/github_env"
    open(ghenv, "w").close()
    r = subprocess.run(["/usr/bin/env", "-i", f"PATH={SAFE}", f"RUNNER_TEMP={RT}", f"GITHUB_ENV={ghenv}", "/usr/bin/bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", ISO],
                       capture_output=True, text=True)
    check("fixed PATH: exit 0", r.returncode, 0)
    kv = dict(line.split("=", 1) for line in open(ghenv).read().splitlines() if line)
    want_keys = {"HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "npm_config_cache", "npm_config_store_dir",
                 "COREPACK_HOME", "CARGO_HOME", "RUSTUP_HOME", "YARN_CACHE_FOLDER", "NEXT_CACHE_DIR", "PLAYWRIGHT_BROWSERS_PATH", "GIT_CONFIG_GLOBAL"}
    check("writes the 14 variables to GITHUB_ENV", set(kv), want_keys)
    check("every value is under RUNNER_TEMP", all(v.startswith(RT + "/") for v in kv.values()), True)
    check("HOME is mode 700", oct(os.stat(kv["HOME"]).st_mode & 0o777), "0o700")
    check("GIT_CONFIG_GLOBAL is an empty file in HOME", (kv["GIT_CONFIG_GLOBAL"] == kv["HOME"] + "/.gitconfig", os.path.getsize(kv["GIT_CONFIG_GLOBAL"])), (True, 0))
    r = subprocess.run(["/usr/bin/env", "-i", f"PATH={CACHE}/cargo/bin:{SAFE}", f"RUNNER_TEMP={RT}", f"GITHUB_ENV={ghenv}", "/usr/bin/bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", ISO],
                       capture_output=True, text=True)
    check("a PATH with the cache dir first: exit 1", r.returncode, 1)
    check("a PATH with the cache dir first: names PATH", "PATH is not the fixed one" in r.stdout, True)

    print("guard step, real fixed PATH (the job's own shape; /gha-cache does not exist here, so only the unpatched text can run)")
    jobenv = dict(kv, PATH=SAFE, RUNNER_TEMP=RT, PYTHONNOUSERSITE="1")
    r = subprocess.run(["/usr/bin/env", "-i"] + [f"{k}={v}" for k, v in jobenv.items()] + ["/usr/bin/bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", GUARD],
                       capture_output=True, text=True)
    check("isolate output + fixed PATH: guard exit 0", r.returncode, 0)
    check("guard: says ok", "runner cache guard: ok, nothing from the runner's cache" in r.stdout, True)
    check("guard: prints the resolved path of bash, git, python3", len(re.findall(r"^runner cache guard: (bash|git|python3): ", r.stdout, flags=re.M)), 3)

    print("guard step, fixture cache root")
    a, b = "\ncache=/gha-cache\n", "\nsafe=/usr/bin:/bin:/usr/sbin:/sbin\n"
    assert GUARD.count(a) == 1 and GUARD.count(b) == 1, "the two patched lines must each occur once"
    PG = GUARD.replace(a, f"\ncache={CACHE}\n").replace(b, f"\nsafe={BIN}\n")
    for d in ("iso/home", "iso/config", "iso/cache", "iso/data", "iso/state", "iso/npm", "iso/pnpm", "iso/corepack"):
        os.makedirs(f"{RT}/{d}", exist_ok=True)
    open(f"{RT}/iso/home/.gitconfig", "w").close()
    base = dict(PATH=BIN, RUNNER_TEMP=RT, HOME=f"{RT}/iso/home", XDG_CONFIG_HOME=f"{RT}/iso/config", XDG_CACHE_HOME=f"{RT}/iso/cache",
                XDG_DATA_HOME=f"{RT}/iso/data", XDG_STATE_HOME=f"{RT}/iso/state", npm_config_cache=f"{RT}/iso/npm", npm_config_store_dir=f"{RT}/iso/pnpm",
                COREPACK_HOME=f"{RT}/iso/corepack", GIT_CONFIG_GLOBAL=f"{RT}/iso/home/.gitconfig", PYTHONNOUSERSITE="1", RUNNER_TOOL_CACHE=f"{CACHE}/toolcache")

    def run(**over):
        e = dict(base)
        e.update(over)
        args = ["/usr/bin/env", "-i"] + [f"{k}={v}" for k, v in e.items()] + ["/usr/bin/bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", PG]
        return subprocess.run(args, capture_output=True, text=True)

    def rc(**over):
        return run(**over).returncode

    r = run()
    check("clean job environment: exit 0", r.returncode, 0)
    check("clean: tools that are not on PATH are said so and are not a failure", "runner cache guard: gh: not on PATH" in r.stdout, True)
    write = lambda p, s: open(p, "w").write(s)
    write(f"{RT}/iso/home/.gitconfig", "[safe]\n\tdirectory = /home/runner/work/repo/repo\n")
    check("global git config with only safe.directory: green", rc(), 0)
    write(f"{CACHE}/cargo/bin/git", "#!/bin/sh\nexit 0\n")
    os.chmod(f"{CACHE}/cargo/bin/git", 0o755)
    r = run(PATH=f"{CACHE}/cargo/bin:{BIN}")
    check("a fake cache dir on PATH: red", r.returncode, 1)
    check("a fake cache dir on PATH: names PATH and the git that resolves into the cache",
          ("PATH is not the image's own dirs" in r.stdout, "git resolves into the runner's cache" in r.stdout), (True, True))
    os.remove(f"{CACHE}/cargo/bin/git")
    os.makedirs(f"{T}/bin2")
    write(f"{CACHE}/toolcache/python3", "#!/bin/sh\nexit 0\n")
    os.chmod(f"{CACHE}/toolcache/python3", 0o755)
    for t in ("bash", "git"):
        os.symlink(shutil.which(t), f"{T}/bin2/{t}")
    os.symlink(f"{CACHE}/toolcache/python3", f"{T}/bin2/python3")
    PG_SAVE = PG
    PG = GUARD.replace(a, f"\ncache={CACHE}\n").replace(b, f"\nsafe={T}/bin2\n")
    r = run(PATH=f"{T}/bin2")
    check("python3 is a symlink into the tool cache: red, names python3", (r.returncode, "python3 resolves into the runner's cache" in r.stdout), (1, True))
    PG = PG_SAVE
    write(f"{RT}/iso/home/.gitconfig", "[core]\n\tfsmonitor = /tmp/evil\n[safe]\n\tdirectory = /x\n")
    r = run()
    check("planted .gitconfig (core.fsmonitor): red, names it", (r.returncode, "core.fsmonitor" in r.stdout), (1, True))
    write(f"{RT}/iso/home/.gitconfig", "[core]\n\thooksPath = /tmp/hooks\n")
    check("planted .gitconfig (core.hooksPath): red", rc(), 1)
    write(f"{RT}/iso/home/.gitconfig", "")
    write(f"{T}/other.gitconfig", "[core]\n\tfsmonitor = /tmp/evil\n")
    r = run(GIT_CONFIG_GLOBAL=f"{T}/other.gitconfig")
    check("GIT_CONFIG_GLOBAL pointing at another file: red, names it", (r.returncode, "GIT_CONFIG_GLOBAL=" in r.stdout), (1, True))
    os.makedirs(f"{RT}/iso/config/gh")
    check("an empty gh config dir (what gh itself leaves): green", rc(), 0)
    write(f"{RT}/iso/config/gh/hosts.yml", "")
    check("a gh config file: red", rc(), 1)
    shutil.rmtree(f"{RT}/iso/config/gh")
    check("HOME outside RUNNER_TEMP: red", rc(HOME="/root"), 1)
    check("HOME in the cache: red", rc(HOME=f"{CACHE}/home"), 1)
    check("XDG_CACHE_HOME empty: red", rc(XDG_CACHE_HOME=""), 1)
    check("npm_config_cache in the cache: red", rc(npm_config_cache=f"{CACHE}/npm"), 1)
    check("RUNNER_TEMP empty: red", rc(RUNNER_TEMP=""), 1)
    check("NODE_OPTIONS set: red", rc(NODE_OPTIONS="--require=/tmp/x.js"), 1)
    check("BASH_ENV set: red", rc(BASH_ENV="/tmp/x.sh"), 1)
    check("LD_PRELOAD set: red", rc(LD_PRELOAD="/tmp/x.so"), 1)
    check("PYTHONNOUSERSITE not 1: red", rc(PYTHONNOUSERSITE="0"), 1)
    r = run(YARN_CACHE_FOLDER=f"{CACHE}/yarn")
    check("a variable pointing into the cache: red, names it", (r.returncode, "YARN_CACHE_FOLDER points into the cache" in r.stdout), (1, True))
    check("RUNNER_TOOL_CACHE inside the cache alone is exempt (the runner owns it): green", rc(RUNNER_TOOL_CACHE=f"{CACHE}/toolcache"), 0)
    os.makedirs(f"{T}/bin3")
    for t in ("git", "python3"):
        os.symlink(shutil.which(t), f"{T}/bin3/{t}")
    PG = GUARD.replace(a, f"\ncache={CACHE}\n").replace(b, f"\nsafe={T}/bin3\n")
    r = run(PATH=f"{T}/bin3")
    check("bash not on PATH: red, names bash", (r.returncode, "bash is not on PATH" in r.stdout), (1, True))

    print("tool guard of npm-audit (T-11386), fixture cache root")
    TG = step_run(new, "npm-audit", "tool guard")
    assert TG.count(a) == 1 and TG.count(b) == 1, "the two patched lines of the tool guard must each occur once"

    def script(path, body):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        write(path, "#!/bin/sh\n" + body + "\n")
        os.chmod(path, 0o755)

    NODE, PNPM = f"{RT}/node", f"{RT}/setup-pnpm/node_modules/.bin"
    script(f"{NODE}/bin/node", "echo v22.23.5")
    script(f"{NODE}/lib/node_modules/npm/bin/npm-cli.js", "exit 0")
    os.symlink("../lib/node_modules/npm/bin/npm-cli.js", f"{NODE}/bin/npm")
    script(f"{PNPM}/pnpm", "exit 0")
    TOOLNODE = f"{CACHE}/toolcache/node/22.23.5/x64/bin"
    script(f"{TOOLNODE}/node", "echo v22.23.5")
    os.symlink(f"{NODE}/bin/npm", f"{TOOLNODE}/npm")

    def tg(text=None, **over):
        e = dict(PATH=f"{NODE}/bin:{PNPM}:{BIN}", RUNNER_TEMP=RT, RUNNER_TOOL_CACHE=f"{CACHE}/toolcache", MANAGER="pnpm")
        e.update(over)
        body = text or TG.replace(a, f"\ncache={CACHE}\n").replace(b, f"\nsafe={BIN}\n")
        args = ["/usr/bin/env", "-i"] + [f"{k}={v}" for k, v in e.items()] + ["/usr/bin/bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", body]
        return subprocess.run(args, capture_output=True, text=True)

    r = tg()
    check("pnpm repo, node + npm + pnpm under RUNNER_TEMP: exit 0, says ok", (r.returncode, "tool guard: ok, node, npm, pnpm not from the runner's cache" in r.stdout), (0, True))
    check("prints the resolved path of node, npm and pnpm", len(re.findall(r"^tool guard: (node|npm|pnpm): ", r.stdout, flags=re.M)), 3)
    check("prints npm resolved through its link into RUNNER_TEMP",
          f"tool guard: npm: {NODE}/bin/npm -> {os.path.realpath(NODE)}/lib/node_modules/npm/bin/npm-cli.js" in r.stdout, True)
    check("npm repo with no pnpm on PATH: green", tg(PATH=f"{NODE}/bin:{BIN}", MANAGER="npm").returncode, 0)
    r = tg(PATH=f"{NODE}/bin:{BIN}")
    check("pnpm repo with no pnpm on PATH: red, names pnpm", (r.returncode, "pnpm is not on PATH" in r.stdout), (1, True))
    r = tg(PATH=f"{TOOLNODE}:{PNPM}:{BIN}")
    check("node from the tool cache first on PATH (what setup-node did): red, names the dir and node",
          (r.returncode, "PATH holds a dir that is neither a fixed one nor under RUNNER_TEMP" in r.stdout, "node resolves into the runner's cache" in r.stdout), (1, True, True))
    os.makedirs(f"{RT}/node2/bin")
    os.symlink(f"{TOOLNODE}/node", f"{RT}/node2/bin/node")
    os.symlink(f"{NODE}/bin/npm", f"{RT}/node2/bin/npm")
    r = tg(PATH=f"{RT}/node2/bin:{PNPM}:{BIN}")
    check("node under RUNNER_TEMP that links into the tool cache: red, names node", (r.returncode, "node resolves into the runner's cache" in r.stdout), (1, True))
    script(f"{T}/binp/pnpm", "exit 0")
    r = tg(TG.replace(a, f"\ncache={CACHE}\n").replace(b, f"\nsafe={BIN}:{T}/binp\n"), PATH=f"{NODE}/bin:{BIN}:{T}/binp")
    check("pnpm from an image dir instead of the pinned install (a corepack shim): red, names pnpm",
          (r.returncode, "pnpm is not the pinned install under RUNNER_TEMP" in r.stdout), (1, True))
    r = tg(PATH=f"{NODE}/bin::{PNPM}:{BIN}")
    check("an empty PATH entry (the current dir): red", (r.returncode, "PATH holds a dir that is neither a fixed one nor under RUNNER_TEMP: ''" in r.stdout), (1, True))
    r = tg(PATH=f"{PNPM}:{BIN}")
    check("no node on PATH: red, names node", (r.returncode, "node is not on PATH" in r.stdout), (1, True))
    check("RUNNER_TEMP empty: red", tg(RUNNER_TEMP="").returncode, 1)
finally:
    shutil.rmtree(T, ignore_errors=True)

print("security-shared guard tests: all ok" if fails == 0 else f"security-shared guard tests: {fails} FAILED")
sys.exit(1 if fails else 0)
