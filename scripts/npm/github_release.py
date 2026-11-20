"""Create-only GitHub controls; conflicting existing policy needs human review."""

import json
import os
from dataclasses import dataclass

from execution import ReleaseError, mutate, read_json, require, run, setting

ACTION = "setup-github-release"
# Bind GitHub API authority to the same github.com host required by the package repository metadata.
HOST = "github.com"
# RepositoryRole 5 limits release-tag rule bypass to repository administrators.
ADMIN_ROLE_ID = 5
# Keep names within the helper's conservative identity subset.
SAFE_NAME = r"[A-Za-z0-9][A-Za-z0-9._-]*"
# Custom tag policies surface as this one protection rule; any other rule (a required reviewer, a wait
# timer, an app gate) is a control this helper did not create, so it is reported rather than accepted.
EXPECTED_PROTECTIONS = frozenset({"branch_policy"})
# Constrain tag authority to literal paths or a trailing wildcard rather than broader ruleset pattern syntax.
TAG_PATTERN = r"[A-Za-z0-9._/-]+\*?"


def _gh_command(gh_bin, endpoint, *args):
    """Build a pinned github.com API command so calls never drift to another host."""
    return [gh_bin, "api", "--hostname", HOST, endpoint, *args]


def _gh_get(gh_bin, endpoint, *, missing=False):
    """Fail closed on API failures so auth or outage errors never masquerade as absence."""
    result = run(_gh_command(gh_bin, endpoint), check=False)
    if missing and result.returncode != 0 and "(HTTP 404)" in result.stderr:
        return None
    require(result.returncode == 0, "GitHub inspection failed; no absence inferred")
    return read_json(result.stdout)


def _gh_pages(gh_bin, endpoint, key=None):
    """Collect every response page so conflicting controls on later pages cannot be missed."""
    value = read_json(run(_gh_command(gh_bin, endpoint, "--paginate", "--slurp")).stdout)
    require(isinstance(value, list), "unexpected GitHub pagination response")
    items: list[dict[str, object]] = []
    for page in value:
        entries = page.get(key) if key and isinstance(page, dict) else page
        if not isinstance(entries, list) or not all(isinstance(item, dict) for item in entries):
            raise ReleaseError("unexpected GitHub list response")
        items.extend(entries)
    return items


def _verify_repo_admin(target):
    """Confirm the authenticated caller administers the exact target repository."""
    repo = _gh_get(target.gh_bin, f"repos/{target.repo}")
    require(
        isinstance(repo, dict)
        and repo.get("full_name") == target.repo
        and isinstance(repo.get("permissions"), dict)
        and repo["permissions"].get("admin") is True,
        "expected repository administration access not verified",
    )


@dataclass(frozen=True)
class _GitHubControls:
    """Bundle GitHub API endpoints and policy payloads so pre-write and readback checks share one contract."""

    gh_bin: str
    environment_endpoint: str
    policies_endpoint: str
    rulesets_endpoint: str
    branch_policy: dict[str, bool]
    tag: str
    ruleset_name: str
    ruleset_payload: dict[str, object]

    def change(self, endpoint, method, payload):
        """Route mutations through the preview-aware runner with canonical JSON serialization."""
        mutate(
            ACTION,
            _gh_command(self.gh_bin, endpoint, "--method", method, "--input", "-"),
            data=json.dumps(payload, sort_keys=True),
        )

    def inspect_environment(self):
        """Verify any existing environment and tag policy match our contract without overwriting drift."""
        current = _gh_get(self.gh_bin, self.environment_endpoint, missing=True)
        policies: list[dict[str, object]] = []
        if current is not None:
            require(
                isinstance(current, dict)
                and current.get("can_admins_bypass") is False
                and current.get("deployment_branch_policy") == self.branch_policy,
                "existing environment conflicts; refusing overwrite",
            )
            protections = current.get("protection_rules", [])
            require(
                isinstance(protections, list) and all(isinstance(rule, dict) for rule in protections),
                "unexpected environment protections",
            )
            require(
                all(rule.get("type") in EXPECTED_PROTECTIONS for rule in protections),
                "existing environment protections conflict; expected tag policy only",
            )
            policies = _gh_pages(self.gh_bin, self.policies_endpoint, "branch_policies")
            require(
                len(policies) <= 1
                and all(policy.get("name") == self.tag and policy.get("type") == "tag" for policy in policies),
                "existing deployment policies conflict; branch and tag policies are distinct",
            )
        return current, policies

    def inspect_ruleset(self):
        """Confirm any matching repository ruleset is exact so inherited or drifted rules are not overwritten."""
        matches = [
            item for item in _gh_pages(self.gh_bin, self.rulesets_endpoint) if item.get("name") == self.ruleset_name
        ]
        require(len(matches) <= 1, "multiple named rulesets conflict")
        if matches:
            entry = matches[0]
            require(
                entry.get("source_type") == "Repository" and type(entry.get("id")) is int,
                "inherited or malformed ruleset conflicts",
            )
            details = _gh_get(self.gh_bin, f"{self.rulesets_endpoint}/{entry['id']}")
            require(
                isinstance(details, dict)
                and all(details.get(key) == value for key, value in self.ruleset_payload.items()),
                "existing ruleset conflicts; refusing overwrite",
            )
        return matches


def setup_github(target):
    """Make the admin-only signed tag push the publication approval, with no second reviewer gate.

    The environment admits only matching tags and the named ruleset admits only administrators to create
    them, so the tag push is the one human release decision. Re-adding a required reviewer is the rollback,
    and this helper then reports that environment as conflicting rather than accepting it silently.
    """
    _, environment = target.workflow()
    tag = setting("TAG_PATTERN", TAG_PATTERN)
    require(".." not in tag and "//" not in tag and not tag.startswith("/"), "invalid TAG_PATTERN")
    ruleset_name = setting("RULESET_NAME", SAFE_NAME)
    run([target.gh_bin, "auth", "status", "--hostname", HOST])

    _verify_repo_admin(target)
    environment_endpoint = f"repos/{target.repo}/environments/{environment}"
    branch_policy = {"protected_branches": False, "custom_branch_policies": True}
    environment_payload = {
        "can_admins_bypass": False,
        "deployment_branch_policy": branch_policy,
    }
    ruleset_payload: dict[str, object] = {
        "name": ruleset_name,
        "target": "tag",
        "enforcement": "active",
        "conditions": {"ref_name": {"include": [f"refs/tags/{tag}"], "exclude": []}},
        "rules": [{"type": "creation"}, {"type": "update"}, {"type": "deletion"}],
        "bypass_actors": [{"actor_id": ADMIN_ROLE_ID, "actor_type": "RepositoryRole", "bypass_mode": "always"}],
    }
    controls = _GitHubControls(
        gh_bin=target.gh_bin,
        environment_endpoint=environment_endpoint,
        policies_endpoint=f"{environment_endpoint}/deployment-branch-policies",
        rulesets_endpoint=f"repos/{target.repo}/rulesets",
        branch_policy=branch_policy,
        tag=tag,
        ruleset_name=ruleset_name,
        ruleset_payload=ruleset_payload,
    )

    current, policies = controls.inspect_environment()
    matches = controls.inspect_ruleset()
    if current is None:
        controls.change(controls.environment_endpoint, "PUT", environment_payload)
    if not policies:
        controls.change(controls.policies_endpoint, "POST", {"name": tag, "type": "tag"})
    if not matches:
        controls.change(controls.rulesets_endpoint, "POST", ruleset_payload)
    # Preview cannot establish installed controls; real writes need independent inspection before reporting success.
    if os.environ.get("DRY_RUN", "0") == "1":
        print("GitHub preview only; no controls changed.")
    else:
        current, policies = controls.inspect_environment()
        matches = controls.inspect_ruleset()
        require(
            current is not None and len(policies) == 1 and len(matches) == 1,
            "GitHub readback incomplete; inspect partial state before retrying",
        )
        print("GitHub environment, tag policy, and named ruleset readback verified.")
