#!/usr/bin/env python3
"""Guard test for the gitleaks, npm-audit and trivy jobs of .github/workflows/security-shared.yml (G-218 T-11229).
usage: bash tests/security-shared-guard.test.sh    (needs python3 with PyYAML)
       python3 -I tests/security-shared-guard.test.py [<new.yml> [<old.yml>]]
The new file is GL_WF or the workflow in this repo; the old file (the negative control) is GL_OLD or tests/fixtures/security-shared.before-t11229.yml,
the workflow as it was before the fresh-HOME change (main at 0cdfadf), kept byte for byte so the control cannot drift.

Part 1, shape: in the gitleaks, npm-audit and trivy jobs the first step is the isolate step, the checkout keeps no credentials,
the guard step follows it, the job env fixes PATH and PYTHONNOUSERSITE, the shell is an absolute path and no step overrides it.
The same checks FAIL on the old file (negative control) and on four mutations of the new one.
Part 2, behaviour: the isolate step and the guard step, extracted from the YAML, run in bash under a cleared environment. The
runner's cache root and the "image PATH" are fixture directories (the guard text is patched on exactly two lines, asserted), so
no root and no /gha-cache are needed. Green on a clean job, red on each way the cache can still reach the job."""
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
JOBS = ("gitleaks", "npm-audit", "trivy")
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
if fails:
    # the mutation, scope and behaviour checks below read the hardened shape; on a file without it they would only crash
    print(f"security-shared guard tests: {fails} FAILED (the file under test is not hardened; the checks below need that shape)")
    sys.exit(1)
print("shape, negative control: the old file")
for job in JOBS:
    got = shape(old, job)
    check(f"{job}: the old file is flagged ({len(got)} findings)", len(got) >= 6, True)
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

print("scope: what this change does not touch")
for job in ("zap-baseline", "codeql"):
    check(f"{job}: identical to the old file", new["jobs"][job] == old["jobs"][job], True)
check("gitleaks: needs/outputs/permissions/timeout unchanged",
      [new["jobs"]["gitleaks"].get(k) == old["jobs"]["gitleaks"].get(k) for k in ("outputs", "permissions", "timeout-minutes", "runs-on")],
      [True, True, True, True])
for job in ("npm-audit", "trivy"):
    check(f"{job}: needs/if/runs-on/timeout unchanged",
          [new["jobs"][job].get(k) == old["jobs"][job].get(k) for k in ("needs", "if", "runs-on", "timeout-minutes")], [True] * 4)
names = [s.get("uses") for s in new["jobs"]["npm-audit"]["steps"]]
gi = [i for i, s in enumerate(new["jobs"]["npm-audit"]["steps"]) if str(s.get("name", "")).startswith("runner cache guard")][0]
check("npm-audit: pnpm/action-setup and setup-node are unchanged and come AFTER the guard",
      [names.index("pnpm/action-setup@v4") > gi, names.index("actions/setup-node@v4") > gi], [True, True])
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
check("the three isolate steps are one text", len(set(iso.values())), 1)
check("the three guard steps are one text", len(set(grd.values())), 1)
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
finally:
    shutil.rmtree(T, ignore_errors=True)

print("security-shared guard tests: all ok" if fails == 0 else f"security-shared guard tests: {fails} FAILED")
sys.exit(1 if fails else 0)
