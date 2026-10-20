"""Tests for scripts/skillpool.py, run against a throwaway home folder.

    python tests/test_skillpool.py        (or pytest)
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import skillpool as sp  # noqa: E402

scan = sp.scan


def fresh_home() -> Path:
    """Point every path the script uses at an empty temporary home."""
    home = Path(tempfile.mkdtemp(prefix="skillpool-test-"))
    claude = home / ".claude"
    (claude / "skills").mkdir(parents=True)
    for mod in (sp, scan):
        mod.HOME, mod.CLAUDE = home, claude
    sp.SP_HOME = claude / "skillpool"
    for name, sub in (("PROFILES", "profiles"), ("POOL", "pool"), ("SESSIONS", "sessions"), ("EMPTY", "empty"),
                      ("RUN_DIR", "run"), ("BACKUP_DIR", "backups"), ("CONFIG_FILE", "config.json")):
        setattr(sp, name, sp.SP_HOME / sub)
    sp.CACHE_FILE = sp.SP_HOME / "cache" / "listing.json"
    return home


def make_skill(folder: Path, name: str) -> Path:
    d = folder / name
    d.mkdir(parents=True)
    (d / "SKILL.md").write_text(f"---\nname: {name}\ndescription: test skill {name}\n---\nbody\n", encoding="utf-8")
    return d


def project(home: Path) -> Path:
    p = home / "work" / "app"
    (p / ".git").mkdir(parents=True)
    return p


def quiet(fn, *args):
    """Run a command function, keeping its console output out of the test log."""
    import contextlib
    import io
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        return fn(*args)


def test_links_never_touch_their_targets():
    home = fresh_home()
    target = make_skill(home / "elsewhere", "keep")
    link = home / "links" / "keep"
    sp.make_link(link, target)
    assert sp.is_link(link) and (link / "SKILL.md").is_file()
    sp.remove_link(link)
    assert not link.exists() and (target / "SKILL.md").is_file()
    real = home / "links" / "real"
    real.mkdir(parents=True)
    for fn in (lambda: sp.make_link(real, target), lambda: sp.remove_link(real)):
        try:
            fn()
            raise AssertionError("a real folder was replaced or removed")
        except sp.UserError:
            pass
    assert real.is_dir()


def test_new_profile_and_save_rules_need_force():
    home = fresh_home()
    quiet(sp.cmd_new, "docs", "Docs work", None)
    md = sp.PROFILES / "docs" / "CLAUDE.md"
    text = md.read_text(encoding="utf-8")
    assert sp.INDEX_START in text and sp.MEMORY_HEADING in text
    draft = home / "draft.md"
    draft.write_text(text.replace("(這個 profile 的做事方式", "Short sentences. (這個 profile 的做事方式"),
                     encoding="utf-8")
    assert quiet(sp.cmd_save, draft, "docs", False) == 3
    assert "Short sentences" not in md.read_text(encoding="utf-8")
    assert "Short sentences" in (sp.RUN_DIR / "diff-docs-CLAUDE.md.diff").read_text(encoding="utf-8")
    assert quiet(sp.cmd_save, draft, "docs", True) == 0
    saved = md.read_text(encoding="utf-8")
    assert "Short sentences" in saved and saved.count(sp.INDEX_START) == 1
    # a draft without the index block still ends up with one
    draft.write_text("# docs\nonly rules\n", encoding="utf-8")
    quiet(sp.cmd_save, draft, "docs", True)
    assert sp.INDEX_START in md.read_text(encoding="utf-8")
    # profile.json: new is written, a change needs --force
    j = home / "profile-other.json"
    j.write_text(json.dumps({"description": "other"}), encoding="utf-8")
    assert quiet(sp.cmd_save, j, None, False) == 0 and (sp.PROFILES / "other" / "CLAUDE.md").is_file()
    j.write_text(json.dumps({"description": "changed"}), encoding="utf-8")
    assert quiet(sp.cmd_save, j, None, False) == 3
    assert json.loads((sp.PROFILES / "other" / "profile.json").read_text(encoding="utf-8"))["description"] == "other"


def test_pool_skills_are_linked_into_the_profile():
    home = fresh_home()
    make_skill(sp.POOL, "alpha")
    quiet(sp.cmd_new, "docs", "", None)
    own = make_skill(sp.PROFILES / "docs" / ".claude" / "skills", "mine")
    prof = sp.get_profile("docs")
    prof["data"]["skills"] = {"use": ["alpha"]}
    assert sp.sync_skills(prof) == ["linked alpha"]
    assert sp.is_link(sp.profile_skill_dir(prof) / "alpha")
    prof["data"]["skills"] = {"use": []}
    assert sp.sync_skills(prof) == ["unlinked alpha"]
    assert (sp.POOL / "alpha" / "SKILL.md").is_file() and (own / "SKILL.md").is_file()
    assert sp.own_skills(prof) == ["mine"]
    del home


def test_memory_index_lists_projects():
    home = fresh_home()
    quiet(sp.cmd_new, "docs", "", None)
    prof = sp.get_profile("docs")
    proj = project(home)
    sp.note_project(prof, proj)
    key = sp.project_key(proj)
    (prof["dir"] / "memory" / key).mkdir(parents=True)
    (prof["dir"] / "memory" / key / "MEMORY.md").write_text("- a fact\n", encoding="utf-8")
    sp.update_index(prof)
    text = (prof["dir"] / "CLAUDE.md").read_text(encoding="utf-8")
    assert f"memory/{key}/MEMORY.md" in text and str(proj) in text
    sp.update_index(prof)
    assert (prof["dir"] / "CLAUDE.md").read_text(encoding="utf-8") == text
    assert sp.memory_dir(prof, proj) == prof["dir"] / "memory" / key


def test_referenced_skills_only_count_real_references():
    text = ("Use `/deliver` for the pipeline, then /codex-implement.\n"
            "Publish with .agents/skills/wiki-ask/SKILL.md.\n"
            "Plays a loop sound; see https://example.com/loop and src/loop/a.ts and D:/Tool/schedule.\n"
            "Run /unknown-thing.\n")
    known = {"deliver", "codex-implement", "wiki-ask", "loop", "schedule"}
    assert sp.referenced_skills(text, known) == ["codex-implement", "deliver", "wiki-ask"]


def test_project_mcp_only_approved_servers():
    home = fresh_home()
    proj = project(home)
    (proj / ".mcp.json").write_text(json.dumps({"mcpServers": {"a": {"command": "x"}, "b": {"command": "y"}}}),
                                    encoding="utf-8")
    (proj / ".claude").mkdir()
    (proj / ".claude" / "settings.local.json").write_text(json.dumps({"enabledMcpjsonServers": ["a"]}),
                                                         encoding="utf-8")
    names = lambda mode: sorted(n for n, o, _ in sp.raw_mcp_sources(proj, mode) if o == "project")  # noqa: E731
    assert names("approved") == ["a"] and names("all") == ["a", "b"] and names("none") == []


def test_rm_moves_the_folder_and_keeps_pool_skills():
    home = fresh_home()
    make_skill(sp.POOL, "alpha")
    j = home / "docs.json"
    j.write_text(json.dumps({"skills": {"use": ["alpha"]}}), encoding="utf-8")
    quiet(sp.cmd_save, j, None, False)
    assert sp.is_link(sp.PROFILES / "docs" / ".claude" / "skills" / "alpha")
    assert quiet(sp.cmd_rm, "docs", False) == 3 and (sp.PROFILES / "docs").is_dir()
    assert quiet(sp.cmd_rm, "docs", True) == 0
    assert not (sp.PROFILES / "docs").exists()
    assert (sp.POOL / "alpha" / "SKILL.md").is_file()
    assert list((sp.BACKUP_DIR / "profiles").glob("*/docs/profile.json"))


def test_pool_add_and_remove():
    home = fresh_home()
    make_skill(sp.CLAUDE / "skills", "beta")
    assert quiet(sp.cmd_pool, ["add", "beta"], False) == 3 and (sp.CLAUDE / "skills" / "beta").is_dir()
    assert quiet(sp.cmd_pool, ["add", "beta", "--force"], False) == 0
    assert (sp.POOL / "beta" / "SKILL.md").is_file() and not (sp.CLAUDE / "skills" / "beta").exists()
    j = home / "docs.json"
    j.write_text(json.dumps({"skills": {"use": ["beta"]}}), encoding="utf-8")
    quiet(sp.cmd_save, j, None, False)
    assert quiet(sp.cmd_pool, ["remove", "beta", "--force"], False) == 0
    assert (sp.CLAUDE / "skills" / "beta" / "SKILL.md").is_file()
    assert not (sp.PROFILES / "docs" / ".claude" / "skills" / "beta").exists()


def test_session_links_attach_switch_and_sweep():
    home = fresh_home()
    proj = project(home)
    quiet(sp.cmd_new, "docs", "", None)
    quiet(sp.cmd_new, "spine", "", None)
    link = sp.SESSIONS / "m-abc"
    quiet(sp.cmd_session, ["attach", "--link", str(link), "--cwd", str(proj), "docs"])
    assert sp.same_path(sp.link_target(link), sp.PROFILES / "docs")
    import contextlib
    import io
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        sp.cmd_session(["attach", "--link", str(link), "--cwd", str(proj), "spine", "--context"])
    assert sp.same_path(sp.link_target(link), sp.PROFILES / "spine")
    lines = buf.getvalue().splitlines()
    assert any(line.startswith("memory: ") for line in lines)
    ctx = json.loads(next(line for line in lines if line.startswith("context-json: "))[len("context-json: "):])
    assert ctx["context"].startswith("# SkillPool profile: spine")
    quiet(sp.cmd_session, ["attach", "--link", str(link), "--cwd", str(proj), "--empty"])
    assert sp.same_path(sp.link_target(link), sp.EMPTY)
    try:
        sp.cmd_session(["attach", "--link", str(home / "outside"), "--cwd", str(proj), "docs"])
        raise AssertionError("a link outside the sessions folder was made")
    except sp.UserError:
        pass
    # a mod link whose heartbeat is old goes; the profile it pointed at stays
    quiet(sp.cmd_session, ["attach", "--link", str(link), "--cwd", str(proj), "docs"])
    beat = sp.SESSIONS / "m-abc.alive"
    beat.write_text("x", encoding="utf-8")
    old = time.time() - sp.STALE_SECONDS - 60
    os.utime(beat, (old, old))
    sp.make_link(sp.SESSIONS / "l-999999", sp.PROFILES / "spine")  # a launcher that is gone
    assert sorted(sp.sweep_sessions()) == ["l-999999", "m-abc"]
    assert (sp.PROFILES / "docs" / "CLAUDE.md").is_file() and (sp.PROFILES / "spine" / "CLAUDE.md").is_file()


def test_validate():
    assert sp.validate({"skills": {"use": ["a"], "off": ["b"]}, "mcp": {"only": [], "project": False},
                        "plugins": {"off": ["x"]}}) == []
    assert sp.validate({"skills": {"only": ["a"]}})  # the v0.3 key is gone
    assert sp.validate({"memory": "native"})  # memory is always the profile's


def hook_output(env: dict, event: dict) -> dict | None:
    import contextlib
    import io
    saved = {k: os.environ.get(k) for k in env}
    os.environ.update({k: v for k, v in env.items() if v is not None})
    for k, v in env.items():
        if v is None:
            os.environ.pop(k, None)
    stdin, sys.stdin = sys.stdin, io.StringIO(json.dumps(event))
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf):
            sp.cmd_hook(["session-start"])
    finally:
        sys.stdin = stdin
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
    text = buf.getvalue().strip()
    return json.loads(text)["hookSpecificOutput"] if text else None


def test_hook_gives_the_profile_and_this_projects_memory():
    home = fresh_home()
    proj = project(home)
    quiet(sp.cmd_new, "docs", "Docs work", None)
    prof = sp.get_profile("docs")
    mem = sp.memory_dir(prof, proj)
    mem.mkdir(parents=True)
    (mem / "MEMORY.md").write_text("- [Codeword](codeword.md) - the codeword is quince\n", encoding="utf-8")
    sp.note_project(prof, proj)
    out = hook_output({"AGENT_PROFILE": "docs", sp.ENV_ADD_DIR_MD: None}, {"cwd": str(proj), "source": "compact"})
    ctx = out["additionalContext"]
    assert out["hookEventName"] == "SessionStart"
    assert "quince" in ctx and "## 規則" in ctx and sp.INDEX_START not in ctx and str(mem).replace("\\", "/") in ctx
    # Claude Code loads the CLAUDE.md itself when the variable is on: only the memory then
    ctx2 = hook_output({"AGENT_PROFILE": "docs", sp.ENV_ADD_DIR_MD: "1"}, {"cwd": str(proj)})["additionalContext"]
    assert "quince" in ctx2 and "## 規則" not in ctx2
    assert hook_output({"AGENT_PROFILE": None}, {"cwd": str(proj)}) is None
    # a long index is cut, with a nudge to tidy it
    (mem / "MEMORY.md").write_text("".join(f"- line {i}\n" for i in range(250)), encoding="utf-8")
    long_ctx = hook_output({"AGENT_PROFILE": "docs"}, {"cwd": str(proj)})["additionalContext"]
    assert "- line 199" in long_ctx and "- line 200" not in long_ctx and "250" in long_ctx
    assert sp.resolve(prof, proj)["settings"]["autoMemoryEnabled"] is False


if __name__ == "__main__":
    failed = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"pass {name}")
            except Exception as e:  # report every failure, not just the first
                failed += 1
                print(f"FAIL {name}: {type(e).__name__}: {e}")
    sys.exit(1 if failed else 0)
