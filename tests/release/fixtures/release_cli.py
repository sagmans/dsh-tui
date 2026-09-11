"""Synthetic CLI boundary; never contacts npm or GitHub."""
import json
import os
from pathlib import Path
import sys

ARGS = sys.argv[1:]
TOOL = Path(sys.argv[0]).name
SCENARIO = os.environ.get("SCENARIO", "absent")
STATE = Path("state.json")
REGISTRY_FLAGS = ["--registry=https://registry.npmjs.org/", "--@example:registry=https://registry.npmjs.org/"]
TRUST = {"id": "test", "type": "github", "file": "release.yml", "repository": "example/tool",
         "environment": "npm-release", "permissions": ["createPackage"]}
with open(os.environ["CALL_LOG"], "a") as log:
    log.write(json.dumps([TOOL, *ARGS]) + "\n")
state = json.loads(STATE.read_text()) if STATE.exists() else {}


def output(value):
    print(json.dumps(value))
    sys.exit(0)


def save():
    STATE.write_text(json.dumps(state))


if TOOL == "git":
    if ARGS == ["status", "--porcelain", "--untracked-files=all"]:
        print("?? dirty" if SCENARIO == "dirty" else "")
    elif ARGS == ["rev-parse", "HEAD"]:
        print("a" * 40)
    elif ARGS == ["rev-parse", "--show-toplevel"]:
        print(Path.cwd())
    else:
        sys.exit(2)
    sys.exit(0)

if TOOL == "npm":
    if ARGS == ["--version"]:
        print("10.0.0" if SCENARIO == "old-npm" else "11.15.0")
        sys.exit(0)
    if not all(flag in ARGS for flag in REGISTRY_FLAGS):
        sys.exit(3)
    args = [arg for arg in ARGS if arg not in REGISTRY_FLAGS]
    if args == ["whoami", "--json"]:
        if SCENARIO == "auth-error":
            sys.exit(1)
        output("wrong" if SCENARIO == "wrong-user" else "example")
    if args[:2] == ["trust", "list"]:
        if SCENARIO == "extra-permission":
            TRUST["permissions"].append("stagePackage")
        if SCENARIO == "trust-conflict":
            TRUST["repository"] = "other/repo"
        output([TRUST] if state.get("trust") or SCENARIO != "absent" else [])
    if args[:2] == ["trust", "github"]:
        state["trust"] = True
        save()
        sys.exit(0)
    if args[:2] == ["access", "set"]:
        sys.exit(0)
    if args[:3] == ["access", "get", "status"]:
        output({"@example/tool": "private" if SCENARIO == "private-access" else "public"})
    if args[0] == "view":
        if args[1] == "@example/tool":
            if SCENARIO == "existing":
                output("@example/tool")
            if SCENARIO == "network-error":
                output({"error": {"code": "E503"}})
            if SCENARIO == "fake-404":
                print("E404", file=sys.stderr)
                sys.exit(1)
            print(json.dumps({"error": {"code": "E404"}}))
            sys.exit(1)
        metadata = json.loads(Path("package.json").read_text())
        metadata["dist"] = {"integrity": "bad" if SCENARIO == "bad-integrity" else os.environ["ARTIFACT_INTEGRITY"]}
        output(metadata)
    if args[0] == "publish":
        if SCENARIO == "publish-error":
            sys.exit(1)
        state["published"] = True
        save()
        sys.exit(0)
    sys.exit(2)

if TOOL == "gh":
    if ARGS == ["auth", "status", "--hostname", "github.com"]:
        sys.exit(0)
    if ARGS[:3] != ["api", "--hostname", "github.com"]:
        sys.exit(2)
    endpoint = ARGS[3]
    environment_endpoint = "repos/example/tool/environments/npm-release"
    policies_endpoint = environment_endpoint + "/deployment-branch-policies"
    rulesets_endpoint = "repos/example/tool/rulesets"
    if "--method" in ARGS:
        payload = json.load(sys.stdin)
        if endpoint == environment_endpoint:
            state["environment"] = {
                "can_admins_bypass": payload["can_admins_bypass"],
                "deployment_branch_policy": payload["deployment_branch_policy"],
                "protection_rules": [{"type": "required_reviewers", "reviewers": [
                    {"type": "User", "reviewer": {"id": 42, "login": "example"}}
                ]}],
            }
        elif endpoint == policies_endpoint:
            if SCENARIO == "policy-error":
                sys.exit(1)
            state["policies"] = [{"id": 7, **payload}]
        elif endpoint == rulesets_endpoint:
            state["ruleset"] = {"id": 8, "source_type": "Repository", **payload}
        else:
            sys.exit(2)
        save()
        output({"ok": True})
    if endpoint == "repos/example/tool":
        output({"full_name": "example/tool", "permissions": {"admin": True}})
    if endpoint == "users/example":
        output({"login": "example", "id": 42})
    if endpoint == environment_endpoint:
        if SCENARIO == "branch-policy":
            output({"can_admins_bypass": False,
                    "deployment_branch_policy": {"protected_branches": False, "custom_branch_policies": True},
                    "protection_rules": [{"type": "required_reviewers", "reviewers": [
                        {"type": "User", "reviewer": {"id": 42}}
                    ]}]})
        if "environment" in state:
            output(state["environment"])
        print("gh: Not Found (HTTP 404)", file=sys.stderr)
        sys.exit(1)
    if "--paginate" not in ARGS or "--slurp" not in ARGS:
        if endpoint == rulesets_endpoint + "/8":
            output(state["ruleset"])
        sys.exit(2)
    if endpoint == policies_endpoint:
        policies = state.get("policies", [])
        if SCENARIO == "branch-policy":
            policies = [{"id": 7, "name": "v*", "type": "branch"}]
        output([{"branch_policies": []}, {"branch_policies": policies}])
    if endpoint == rulesets_endpoint:
        output([[], [state["ruleset"]] if "ruleset" in state else []])
    sys.exit(2)

sys.exit(2)
