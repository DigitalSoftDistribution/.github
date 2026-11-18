#!/usr/bin/env python3
"""Routing test for the `ci` job of .github/workflows/ci-shared.yml (G-218 T-13997).
usage: bash tests/ci-shared-routing.test.sh    (needs python3 with PyYAML)
       python3 -I tests/ci-shared-routing.test.py [<workflow.yml>]

The `runs-on`, `concurrency` and `if` values of the workflow are evaluated by a small evaluator of the GitHub expression
subset they use (GitHub docs, expressions: && and || return an operand; null, false, 0 and '' are falsy; == between strings
ignores case; contains, startsWith and format; an unset configuration variable is ''). Checked:
  1. runner: push to the default branch -> main_runner; merge_group -> mq_runner, else vars.CI_MQ_RUNNER, else `runner`;
     a trusted lane (coolify-ci-main / -deploy / -hotfix, any case, anywhere in the value) is never chosen; a caller that
     names another runner keeps it; pull_request, schedule and other branches stay on `runner`.
  2. guard step: runs before checkout on merge_group only, exits 1 on every trusted value and 0 otherwise (run in bash).
  3. concurrency: one group per caller workflow + PR + inputs with cancel-in-progress on pull_request only; push and
     merge_group get a group of their own run and are never cancelled; the group never equals a caller's own group.
  4. drafts: skip_heavy_on_draft defaults to true; a draft PR runs `draft`, not `ci`; ready PRs, push, merge_group run `ci`.
Negative control: the same checks must FAIL on five mutations of the workflow (one per guarded property)."""
import copy
import os
import re
import subprocess
import sys
import tempfile

try:
    import yaml
except ImportError:
    sys.exit("ci-shared routing tests: needs PyYAML (pip install pyyaml)")

HERE = os.path.dirname(os.path.abspath(__file__))
WF = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "..", ".github", "workflows", "ci-shared.yml")
TOKEN = re.compile(r"\s*(?:(?P<num>\d+(?:\.\d+)?)|(?P<str>'(?:[^']|'')*')|(?P<op>==|!=|&&|\|\||!|\(|\)|,)|(?P<id>[A-Za-z_][A-Za-z0-9_.\-]*))")


def tokens(src):
    pos, out = 0, []
    while pos < len(src):
        if src[pos:].strip() == "":
            break
        m = TOKEN.match(src, pos)
        if not m or m.end() == pos:
            raise ValueError(f"cannot read expression at {src[pos:pos + 30]!r}")
        kind = m.lastgroup
        out.append((kind, m.group(kind)))
        pos = m.end()
    return out


def truthy(v):
    return not (v is None or v is False or v == "" or (isinstance(v, (int, float)) and not isinstance(v, bool) and v == 0))


def text(v):
    return "" if v is None else ("true" if v is True else "false" if v is False else str(v))


def number(v):
    if v is None:
        return 0.0
    if isinstance(v, bool):
        return 1.0 if v else 0.0
    if isinstance(v, (int, float)):
        return float(v)
    try:
        return float(v) if v.strip() else 0.0
    except ValueError:
        return float("nan")


def equal(a, b):
    if isinstance(a, str) and isinstance(b, str):
        return a.lower() == b.lower()
    if type(a) is type(b):
        return a == b
    return number(a) == number(b)


FUNCS = {
    "format": lambda f, *a: re.sub(r"\{(\d+)\}", lambda m: text(a[int(m.group(1))]), f).replace("{{", "{").replace("}}", "}"),
    "contains": lambda s, i: text(i).lower() in text(s).lower(),
    "startswith": lambda s, i: text(s).lower().startswith(text(i).lower()),
}


class Expr:
    """Recursive descent over the token list; precedence ! > == != > && > ||."""

    def __init__(self, src, ctx):
        self.t, self.i, self.ctx = tokens(src), 0, ctx

    def peek(self):
        return self.t[self.i] if self.i < len(self.t) else (None, None)

    def take(self, want=None):
        tok = self.peek()
        if want is not None and tok[1] != want:
            raise ValueError(f"expected {want!r}, got {tok[1]!r}")
        self.i += 1
        return tok

    def run(self):
        v = self.or_()
        if self.i != len(self.t):
            raise ValueError(f"trailing tokens {self.t[self.i:]!r}")
        return v

    def or_(self):
        v = self.and_()
        while self.peek()[1] == "||":
            self.take()
            r = self.and_()
            v = v if truthy(v) else r
        return v

    def and_(self):
        v = self.cmp()
        while self.peek()[1] == "&&":
            self.take()
            r = self.cmp()
            v = r if truthy(v) else v
        return v

    def cmp(self):
        v = self.unary()
        if self.peek()[1] in ("==", "!="):
            op = self.take()[1]
            r = self.unary()
            v = equal(v, r) if op == "==" else not equal(v, r)
        return v

    def unary(self):
        if self.peek()[1] == "!":
            self.take()
            return not truthy(self.unary())
        return self.primary()

    def primary(self):
        kind, val = self.take()
        if val == "(":
            v = self.or_()
            self.take(")")
            return v
        if kind == "num":
            return float(val)
        if kind == "str":
            return val[1:-1].replace("''", "'")
        if kind == "id" and val in ("true", "false", "null"):
            return {"true": True, "false": False, "null": None}[val]
        if kind == "id" and self.peek()[1] == "(":
            self.take("(")
            args = [] if self.peek()[1] == ")" else [self.or_()]
            while self.peek()[1] == ",":
                self.take()
                args.append(self.or_())
            self.take(")")
            return FUNCS[val.lower()](*args)
        if kind == "id":
            cur = self.ctx
            for part in val.split("."):
                cur = cur.get(part) if isinstance(cur, dict) else None
            return cur
        raise ValueError(f"unexpected token {val!r}")


def value(raw, ctx):
    """A workflow value: one whole ${{ }} gives the expression's value, mixed text gives a string."""
    if isinstance(raw, bool) or raw is None:
        return raw
    s = str(raw)
    whole = s.count("${{") == 1 and re.fullmatch(r"\s*\$\{\{(.*?)\}\}\s*", s, re.S)
    if whole:
        return Expr(whole.group(1), ctx).run()
    return re.sub(r"\$\{\{(.*?)\}\}", lambda m: text(Expr(m.group(1), ctx).run()), s, flags=re.S)


def cond(raw, ctx):
    """An `if:` value: evaluated as an expression with or without ${{ }}."""
    s = str(raw).strip()
    if s.startswith("${{") and s.endswith("}}"):
        s = s[3:-2]
    return truthy(Expr(s, ctx).run())


def doc_on(doc):
    """PyYAML reads the bare key `on` as the boolean True (YAML 1.1)."""
    return doc[True] if True in doc else doc["on"]


def ctx_of(doc, event, ref="refs/heads/feature", pr=None, draft=False, run_id=1000, inputs=None, vars_=None, workflow="CI"):
    defaults = {k: v.get("default") for k, v in doc_on(doc)["workflow_call"]["inputs"].items()}
    defaults.update(inputs or {})
    ev = {"repository": {"default_branch": "main"}}
    if pr is not None:
        ev["pull_request"] = {"number": pr, "draft": draft}
    return {"github": {"event_name": event, "ref": ref, "event": ev, "run_id": run_id, "workflow": workflow},
            "inputs": defaults, "vars": dict(vars_ or {})}


TRUSTED = ("coolify-ci-main", "coolify-ci-main-bi", "Coolify-CI-Deploy", "coolify-ci-hotfix-1", " coolify-ci-main", "x-coolify-ci-deploy")
# The workflow-level groups the callers use today (11 repos read 17.11) and the keyflow-wholesale-nexus form.
CALLER_GROUPS = ("ci-${{ github.ref }}", "ci-${{ github.event.pull_request.number || github.ref }}",
                 "${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}")


def job(doc, name):
    return doc["jobs"][name]


def check_runner(doc):
    ro, bad = job(doc, "ci")["runs-on"], []
    if "\n" in str(ro):
        bad.append("runs-on is not one line after YAML folding")
    mq = {"CI_MQ_RUNNER": "coolify-ci-mq"}
    cases = [
        ("push to main", dict(event="push", ref="refs/heads/main"), "coolify-ci-main"),
        ("push to main, main_runner ''", dict(event="push", ref="refs/heads/main", inputs={"main_runner": ""}), "coolify-ci"),
        ("push to a branch", dict(event="push"), "coolify-ci"),
        ("schedule", dict(event="schedule", ref="refs/heads/main"), "coolify-ci"),
        ("pull_request", dict(event="pull_request", pr=7), "coolify-ci"),
        ("pull_request with CI_MQ_RUNNER", dict(event="pull_request", pr=7, vars_=mq), "coolify-ci"),
        ("push to main with CI_MQ_RUNNER", dict(event="push", ref="refs/heads/main", vars_=mq), "coolify-ci-main"),
        ("merge_group, nothing set", dict(event="merge_group", ref="refs/heads/gh-readonly-queue/main/pr-7-abc"), "coolify-ci"),
        ("merge_group, CI_MQ_RUNNER", dict(event="merge_group", vars_=mq), "coolify-ci-mq"),
        ("merge_group, input beats var", dict(event="merge_group", inputs={"mq_runner": "coolify-ci-mq-2"}, vars_=mq), "coolify-ci-mq-2"),
        ("merge_group, caller runner kept", dict(event="merge_group", inputs={"runner": "ubuntu-latest"}, vars_=mq), "ubuntu-latest"),
    ]
    for t in TRUSTED:
        cases.append((f"merge_group, var {t!r}", dict(event="merge_group", vars_={"CI_MQ_RUNNER": t}), "coolify-ci"))
        cases.append((f"merge_group, input {t!r}", dict(event="merge_group", inputs={"mq_runner": t}), "coolify-ci"))
    for label, kw, want in cases:
        got = value(ro, ctx_of(doc, **kw))
        if got != want:
            bad.append(f"runner {label}: want {want!r} got {got!r}")
    return bad


def run_guard(step, mq):
    with tempfile.NamedTemporaryFile("w", suffix=".sh", delete=False) as f:
        f.write(step["run"])
    try:
        p = subprocess.run(["/usr/bin/env", "-i", "PATH=/usr/bin:/bin", f"MQ_RUNNER={mq}", "RUNNER_NAME=test", "bash",
                            "--noprofile", "--norc", "-eo", "pipefail", f.name], capture_output=True, text=True, timeout=20)
    finally:
        os.unlink(f.name)
    return p.returncode, p.stdout + p.stderr


def check_guard(doc):
    steps = job(doc, "ci")["steps"]
    i = next((k for k, s in enumerate(steps) if s.get("name") == "Merge queue runner guard"), None)
    if i is None:
        return ["guard step missing"]
    step, bad = steps[i], []
    co = next((k for k, s in enumerate(steps) if str(s.get("uses", "")).startswith("actions/checkout")), None)
    if co is None or i > co:
        bad.append("guard step is not before checkout")
    for label, kw, want in [
        ("merge_group", dict(event="merge_group"), True),
        ("pull_request", dict(event="pull_request", pr=7, vars_={"CI_MQ_RUNNER": "coolify-ci-main"}), False),
        ("push to main", dict(event="push", ref="refs/heads/main"), False),
        ("merge_group, caller runner", dict(event="merge_group", inputs={"runner": "ubuntu-latest"}), False),
    ]:
        if cond(step["if"], ctx_of(doc, **kw)) != want:
            bad.append(f"guard if on {label}: want {want}")
    for t in TRUSTED:
        for kw in (dict(vars_={"CI_MQ_RUNNER": t}), dict(inputs={"mq_runner": t})):
            rc, out = run_guard(step, value(step["env"]["MQ_RUNNER"], ctx_of(doc, "merge_group", **kw)))
            if rc != 1 or "trusted lane" not in out:
                bad.append(f"guard on {t!r}: want rc 1 naming a trusted lane, got rc {rc}")
    for ok in ("", "coolify-ci-mq", "coolify-ci"):
        rc, out = run_guard(step, value(step["env"]["MQ_RUNNER"], ctx_of(doc, "merge_group", vars_={"CI_MQ_RUNNER": ok})))
        if rc != 0:
            bad.append(f"guard on {ok!r}: want rc 0, got rc {rc}: {out.strip()[:120]}")
    return bad


def check_concurrency(doc):
    c = job(doc, "ci").get("concurrency")
    if not isinstance(c, dict):
        return ["ci job has no concurrency"]

    def g(**kw):
        return value(c["group"], ctx_of(doc, **kw))

    def cancel(**kw):
        return truthy(value(c.get("cancel-in-progress", False), ctx_of(doc, **kw)))

    bad = []
    pr12 = dict(event="pull_request", ref="refs/pull/12/merge", pr=12, run_id=1)
    pr12b, pr13 = dict(pr12, run_id=2), dict(event="pull_request", ref="refs/pull/13/merge", pr=13, run_id=3)
    main1 = dict(event="push", ref="refs/heads/main", run_id=4)
    mq1 = dict(event="merge_group", ref="refs/heads/gh-readonly-queue/main/pr-12-abc", run_id=6)
    if g(**pr12) != g(**pr12b):
        bad.append("two runs of PR 12 are not one group")
    if not cancel(**pr12):
        bad.append("pull_request does not cancel the superseded run")
    if g(**pr12) == g(**pr13):
        bad.append("PR 12 and PR 13 share a group")
    if g(**pr12) == g(**dict(pr12b, inputs={"node-version": "20"})):
        bad.append("two calls with other inputs share a group")
    for label, a in (("push to main", main1), ("merge_group", mq1)):
        if cancel(**a):
            bad.append(f"{label} cancels in progress")
        if g(**a) == g(**dict(a, run_id=a["run_id"] + 100)):
            bad.append(f"two {label} runs share a group")
        if g(**a) in (g(**pr12), g(**pr13)):
            bad.append(f"{label} is grouped with a PR run")
    for cg in CALLER_GROUPS:
        for kw in (pr12, main1, mq1):
            if value(cg, ctx_of(doc, **kw)) == g(**kw):
                bad.append(f"group equals the caller group {cg!r}")
    return bad


def check_drafts(doc):
    bad = []
    if doc_on(doc)["workflow_call"]["inputs"]["skip_heavy_on_draft"].get("default") is not True:
        bad.append("skip_heavy_on_draft does not default to true")
    for label, kw, want_ci in [
        ("draft PR", dict(event="pull_request", pr=5, draft=True), False),
        ("ready PR", dict(event="pull_request", pr=5, draft=False), True),
        ("push to main", dict(event="push", ref="refs/heads/main"), True),
        ("merge_group", dict(event="merge_group"), True),
        ("draft PR, input false", dict(event="pull_request", pr=5, draft=True, inputs={"skip_heavy_on_draft": False}), True),
    ]:
        ctx = ctx_of(doc, **kw)
        ci_runs, draft_runs = cond(job(doc, "ci")["if"], ctx), cond(job(doc, "draft")["if"], ctx)
        if ci_runs != want_ci or draft_runs == want_ci:
            bad.append(f"{label}: ci runs {ci_runs}, draft runs {draft_runs}; want ci {want_ci}")
    return bad


def mutations(doc):
    out = {}
    d = copy.deepcopy(doc)
    del d["jobs"]["ci"]["concurrency"]
    out["no concurrency"] = (d, check_concurrency)
    d = copy.deepcopy(doc)
    d["jobs"]["ci"]["concurrency"]["cancel-in-progress"] = True
    out["cancel-in-progress always true"] = (d, check_concurrency)
    d = copy.deepcopy(doc)
    ro = d["jobs"]["ci"]["runs-on"]
    d["jobs"]["ci"]["runs-on"] = re.sub(r"&& !contains\([^)]*\)\s*", "", ro)
    out["no trusted filter in runs-on"] = (d, check_runner) if d["jobs"]["ci"]["runs-on"] != ro else (doc, lambda _: [])
    d = copy.deepcopy(doc)
    d["jobs"]["ci"]["steps"] = [s for s in d["jobs"]["ci"]["steps"] if s.get("name") != "Merge queue runner guard"]
    out["no guard step"] = (d, check_guard)
    d = copy.deepcopy(doc)
    doc_on(d)["workflow_call"]["inputs"]["skip_heavy_on_draft"]["default"] = False
    out["skip_heavy_on_draft default false"] = (d, check_drafts)
    return out


def main():
    doc = yaml.safe_load(open(WF, encoding="utf-8"))
    fails = 0
    print(f"ci-shared routing test: {WF}")
    for name, fn in (("runner", check_runner), ("guard", check_guard), ("concurrency", check_concurrency), ("drafts", check_drafts)):
        bad = fn(doc)
        print(f"  {'ok  ' if not bad else 'FAIL'} {name}")
        for b in bad:
            print(f"       {b}")
        fails += bool(bad)
    if fails:
        print(f"FAILED: {fails} (negative control skipped: the workflow itself fails)")
        return 1
    print("negative control (each mutation must fail):")
    for name, (d, fn) in mutations(doc).items():
        bad = fn(d)
        print(f"  {'ok  ' if bad else 'FAIL'} {name}: {len(bad)} finding(s){' - ' + bad[0] if bad else ''}")
        fails += not bad
    print("PASS" if not fails else f"FAILED: {fails}")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
