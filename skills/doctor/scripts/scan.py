"""SkillPool doctor: read-only inventory + usage scan of a Claude Code setup.

Collects skills, agents, instruction files, MCP servers and settings that
affect them, then mines ~/.claude/projects/**/*.jsonl for real usage
(Skill calls, typed slash commands, MCP tool calls, Agent subagent types).

Never writes anywhere but --out. Never records MCP env/headers or URL queries.
Console output is ASCII only; the report is UTF-8 JSON.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from itertools import combinations
from pathlib import Path
from urllib.parse import urlsplit

HOME = Path.home()
CLAUDE = HOME / ".claude"
SKIP_SKILL_DIRS = {"_shared", "synced"}
INSTRUCTION_NAMES = ["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", ".claude/CLAUDE.md"]
BUILTIN_COMMANDS = {
    "compact", "model", "plugin", "plugins", "reload-plugins", "resume", "remote-control", "goal", "clear",
    "usage-credits", "plan", "permissions", "config", "context", "cost", "doctor", "help", "init", "login",
    "logout", "mcp", "memory", "review", "status", "agents", "hooks", "ide", "skills", "export", "fast",
    "effort", "add-dir", "bug", "feedback", "rewind", "theme", "vim", "exit", "statusline", "usage",
    "commander", "loop", "schedule", "artifacts", "btw", "terminal-setup", "upgrade", "release-notes",
}
# Skills shipped inside Claude Code or provided by claude.ai: in the listing, not on disk.
BUNDLED_SKILLS = {
    "plugin-authoring", "artifact-design", "artifact-diagramming", "artifact-capabilities", "update-config",
    "keybindings-help", "code-review", "simplify", "fewer-permission-prompts", "loop", "schedule", "claude-api",
    "claude-in-chrome", "run", "init", "security-review", "dataviz", "debug", "batch",
    "design", "design-sync", "verify", "run-skill-generator", "doctor",
}
BUNDLED_PREFIXES = ("anthropic-skills:",)
BUILTIN_AGENTS = {"general-purpose", "Explore", "Plan", "fork", "claude-code-guide", "statusline-setup", "claude"}
SELF_PREFIX = "skillpool:"
DEFAULT_OUT = CLAUDE / "skillpool" / "reports"
SCRIPT_RE = re.compile(r"\.(m?js|cjs|ts|py)$", re.I)
PACKAGE_RE = re.compile(r"^@?[a-z0-9][a-z0-9._-]*(/[a-z0-9._-]+)?(@[\w.-]+)?$", re.I)
CMD_RE = re.compile(r"<command-name>/([^<\s]+)</command-name>")
CJK_RE = re.compile(r"[⺀-鿿가-힯＀-￯]")


def est_tokens(text: str) -> int:
    """Rough token estimate: CJK ~1 token/char, other ~4 chars/token."""
    if not text:
        return 0
    cjk = len(CJK_RE.findall(text))
    return cjk + max(0, len(text) - cjk) // 4


def read_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def parse_frontmatter(text: str) -> dict | None:
    if not text.startswith("---"):
        return None
    end = text.find("\n---", 3)
    if end < 0:
        return None
    meta: dict[str, str] = {}
    key = None
    for line in text[3:end].splitlines():
        m = re.match(r"^([A-Za-z0-9_-]+):\s*(.*)$", line)
        if m:
            key = m.group(1)
            meta[key] = m.group(2).strip().strip("'\"")
        elif key and line.startswith((" ", "\t")):
            meta[key] = (meta[key] + " " + line.strip()).strip()
    return meta


def norm_path(p: str | Path) -> str:
    return str(p).replace("\\", "/").rstrip("/").lower()


def is_ignored_project(root: Path) -> bool:
    """Home (its .claude is the user level) and temp/scratch folders are not projects."""
    n = norm_path(root)
    return n == norm_path(HOME) or "/appdata/local/temp/" in n + "/"


# ---------------------------------------------------------------- inventory


def read_skill(d: Path, source: str, plugin: str | None, scope: str | None, project: str | None) -> dict:
    md = d / "SKILL.md"
    text = md.read_text(encoding="utf-8", errors="replace")
    fm = parse_frontmatter(text)
    name = (fm or {}).get("name") or d.name
    desc = (fm or {}).get("description", "")
    dmi = (fm or {}).get("disable-model-invocation", "").lower() == "true"
    return {
        "name": f"{plugin}:{name}" if plugin else name,
        "dir": d.name,
        "source": source,
        "plugin": plugin,
        "scope": scope,
        "project": project,
        "path": str(md),
        "description": desc,
        # a skill with disable-model-invocation is not in the model's listing
        "listing_tokens": 0 if dmi else est_tokens(f"- {name}: {desc}"),
        "description_tokens": est_tokens(desc),
        "body_tokens": est_tokens(text),
        "frontmatter_ok": fm is not None and bool(desc),
        "name_matches_dir": (fm or {}).get("name", d.name) == d.name,
        "disable_model_invocation": dmi,
    }


def scan_skill_dir(root: Path, source: str, plugin: str | None = None, scope: str | None = None,
                   project: str | None = None) -> list[dict]:
    if not root.is_dir():
        return []
    return [read_skill(d, source, plugin, scope, project) for d in sorted(root.iterdir())
            if d.is_dir() and d.name not in SKIP_SKILL_DIRS and (d / "SKILL.md").is_file()]


def scan_plugin_skills(root: Path, manifest: dict, plugin: str, scope: str | None,
                       project: str | None) -> list[dict]:
    """A plugin's skills: `skills/*/SKILL.md`, or the folders its manifest's `skills` field names."""
    declared = manifest.get("skills")
    paths = [declared] if isinstance(declared, str) else declared if isinstance(declared, list) else ["./skills"]
    out: list[dict] = []
    for rel in paths:
        d = (root / str(rel)).resolve()
        if (d / "SKILL.md").is_file():
            out.append(read_skill(d, "plugin", plugin, scope, project))
        else:
            out += scan_skill_dir(d, "plugin", plugin, scope, project)
    return out


def scan_agent_dir(root: Path, source: str, plugin: str | None = None, project: str | None = None) -> list[dict]:
    out = []
    if not root.is_dir():
        return out
    for md in sorted(root.glob("*.md")):
        text = md.read_text(encoding="utf-8", errors="replace")
        fm = parse_frontmatter(text) or {}
        name = fm.get("name") or md.stem
        out.append({
            "name": f"{plugin}:{name}" if plugin else name,
            "source": source,
            "project": project,
            "path": str(md),
            "description": fm.get("description", "")[:400],
            "tools": fm.get("tools", ""),
            "model": fm.get("model", ""),
            "listing_tokens": est_tokens(fm.get("description", "")),
        })
    return out


def sanitize_mcp(name: str, cfg: dict, scope: str, origin: str) -> dict:
    kind = cfg.get("type") or ("stdio" if "command" in cfg else "http" if "url" in cfg else "?")
    target = ""
    if "command" in cfg:
        # args can carry secrets (--token abc): keep only the script or package being run
        target = Path(str(cfg["command"])).name
        args = [str(a) for a in cfg.get("args") or []]
        runner = target.lower().removesuffix(".cmd").removesuffix(".exe") in ("npx", "uvx", "bunx", "pnpm", "dlx")
        shown = [Path(a).name for a in args if SCRIPT_RE.search(a)]
        if runner:
            # the package is the first arg, or the one right after -y/--yes; never a flag's value
            shown += [a for i, a in enumerate(args)
                      if PACKAGE_RE.match(a) and (i == 0 or args[i - 1] in ("-y", "--yes"))][:1]
        if shown:
            target += " " + " ".join(shown[:2])
        if args:
            target += f" (+{len(args)} args)"
    elif "url" in cfg:
        u = urlsplit(str(cfg["url"]))
        target = f"{u.scheme}://{u.netloc}{u.path}"
    return {"name": name, "scope": scope, "origin": origin, "type": kind, "target": target}


def heading_outline(text: str, limit: int = 40) -> list[str]:
    out, in_code = [], False
    for ln in text.splitlines():
        if ln.lstrip().startswith("```"):
            in_code = not in_code
        elif not in_code and re.match(r"^#{1,6}\s", ln):
            out.append(ln.strip())
    return out[:limit]


def scan_instruction(path: Path, scope: str, project: str | None) -> dict | None:
    if not path.is_file():
        return None
    text = path.read_text(encoding="utf-8", errors="replace")
    return {
        "path": str(path),
        "scope": scope,
        "project": project,
        "tokens": est_tokens(text),
        "lines": text.count("\n") + 1,
        "headings": heading_outline(text),
        "sections": sections_of(text),
        "imports": re.findall(r"^\s*@(\S+)", text, re.M)[:20],
    }


def sections_of(text: str) -> list[dict]:
    """Top-level sections (# and ##) with their token cost, for `file#heading` references."""
    out: list[dict] = []
    title, buf = "(preamble)", []
    in_code = False
    for line in text.splitlines():
        if line.lstrip().startswith("```"):
            in_code = not in_code
        m = None if in_code else re.match(r"^(#{1,2})\s+(.*)$", line)
        if m:
            if buf and "".join(buf).strip():
                out.append({"heading": title, "tokens": est_tokens("\n".join(buf))})
            title, buf = m.group(2).strip(), [line]
        else:
            buf.append(line)
    if buf and "".join(buf).strip():
        out.append({"heading": title, "tokens": est_tokens("\n".join(buf))})
    return out[:40]


def load_settings(path: Path) -> dict:
    data = read_json(path) or {}
    keep = ["skillOverrides", "enabledPlugins", "disabledMcpjsonServers", "enabledMcpjsonServers",
            "enableAllProjectMcpServers", "deniedMcpServers", "allowedMcpServers", "disableClaudeAiConnectors"]
    return {k: data[k] for k in keep if k in data}


def inventory(projects: list[str]) -> dict:
    skills: list[dict] = []
    agents: list[dict] = []
    instructions: list[dict] = []
    mcp: list[dict] = []
    settings: dict[str, dict] = {}
    plugins: list[dict] = []

    # user level
    skills += scan_skill_dir(CLAUDE / "skills", "user")
    agents += scan_agent_dir(CLAUDE / "agents", "user")
    inst = scan_instruction(CLAUDE / "CLAUDE.md", "user", None)
    if inst:
        instructions.append(inst)
    for fname in ["settings.json", "settings.local.json"]:
        s = load_settings(CLAUDE / fname)
        if s:
            settings[f"user/{fname}"] = s
    user_enabled = (read_json(CLAUDE / "settings.json") or {}).get("enabledPlugins", {}) or {}

    # plugins
    installed = (read_json(CLAUDE / "plugins" / "installed_plugins.json") or {}).get("plugins", {})
    seen_installs = set()
    for key, entries in installed.items():
        pname = key.split("@")[0]
        for ent in entries if isinstance(entries, list) else [entries]:
            scope = ent.get("scope")
            proj = ent.get("projectPath")
            install_key = (key, scope, norm_path(proj or ""))
            if install_key in seen_installs:
                continue
            seen_installs.add(install_key)
            enabled = user_enabled.get(key) if scope == "user" else True
            root = Path(ent.get("installPath", ""))
            manifest = read_json(root / ".claude-plugin" / "plugin.json") or {}
            plugins.append({"key": key, "scope": scope, "project": proj, "version": ent.get("version"),
                            "enabled": bool(enabled), "path": str(root),
                            "description": str(manifest.get("description", ""))[:300]})
            if not enabled:
                continue
            skills += scan_plugin_skills(root, manifest, pname, scope, proj)
            agents += scan_agent_dir(root / "agents", "plugin", pname, proj)
            pm = read_json(root / ".mcp.json") or {}
            for n, cfg in (pm.get("mcpServers") or pm).items():
                if isinstance(cfg, dict):
                    mcp.append(sanitize_mcp(n, cfg, scope or "?", f"plugin:{pname}"))
    # one row per plugin skill; a plugin installed for several projects lists them all
    by_key: dict[tuple, dict] = {}
    for s in skills:
        k = (s["name"], s["path"])
        row = by_key.setdefault(k, s | {"projects": []})
        if s.get("project") and norm_path(s["project"]) not in {norm_path(p) for p in row["projects"]}:
            row["projects"].append(s["project"])
    skills = list(by_key.values())

    # ~/.claude.json MCP
    cj = read_json(HOME / ".claude.json") or {}
    for n, cfg in (cj.get("mcpServers") or {}).items():
        mcp.append(sanitize_mcp(n, cfg, "user", "~/.claude.json"))
    project_mcp_state = {}
    for p, v in (cj.get("projects") or {}).items():
        for n, cfg in (v.get("mcpServers") or {}).items():
            mcp.append(sanitize_mcp(n, cfg, "local", f"~/.claude.json projects[{p}]") | {"project": p})
        dis = v.get("disabledMcpServers") or []
        disj = v.get("disabledMcpjsonServers") or []
        if dis or disj:
            project_mcp_state[p] = {"disabledMcpServers": dis, "disabledMcpjsonServers": disj}

    # projects seen in transcripts (+ cwd)
    for proj in projects:
        root = Path(proj)
        if not root.is_dir() or is_ignored_project(root):
            continue
        skills += scan_skill_dir(root / ".claude" / "skills", "project", project=proj)
        agents += scan_agent_dir(root / ".claude" / "agents", "project", project=proj)
        for name in INSTRUCTION_NAMES:
            inst = scan_instruction(root / name, "project", proj)
            if inst:
                instructions.append(inst)
        for fname in ["settings.json", "settings.local.json"]:
            s = load_settings(root / ".claude" / fname)
            if s:
                settings[f"{proj}/.claude/{fname}"] = s
        pm = read_json(root / ".mcp.json") or {}
        for n, cfg in (pm.get("mcpServers") or {}).items():
            if isinstance(cfg, dict):
                mcp.append(sanitize_mcp(n, cfg, "project", f"{proj}/.mcp.json") | {"project": proj})

    # override state: user settings.json is effective everywhere; each project's
    # .claude/settings*.json narrows it there; ~/.claude/settings.local.json is
    # not a documented source, so its entries are reported, not applied.
    user_over = (settings.get("user/settings.json") or {}).get("skillOverrides", {}) or {}
    ignored_over = (settings.get("user/settings.local.json") or {}).get("skillOverrides", {}) or {}
    project_over: dict[str, dict] = defaultdict(dict)
    for src, st in settings.items():
        if not src.startswith("user/"):
            proj = src.split("/.claude/")[0]
            project_over[proj].update(st.get("skillOverrides") or {})
    for s in skills:
        if s["source"] == "plugin":
            continue  # skillOverrides does not apply to plugin skills
        bare = s["name"]
        s["override"] = user_over.get(bare, "on")
        if bare in ignored_over:
            s["override_ignored"] = {"file": "~/.claude/settings.local.json", "value": ignored_over[bare]}
        per_project = {p: o[bare] for p, o in project_over.items() if bare in o}
        if per_project:
            s["project_overrides"] = per_project

    return {"skills": skills, "agents": agents, "instructions": instructions, "mcp": mcp,
            "settings": settings, "plugins": plugins, "project_mcp_state": project_mcp_state}


# ---------------------------------------------------------------- usage


def parse_ts(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def scan_usage(days: int) -> dict:
    since = datetime.now(timezone.utc) - timedelta(days=days)
    since_epoch = since.timestamp()
    skill_hits: dict[str, dict] = defaultdict(lambda: {"count": 0, "by_model": 0, "by_user": 0, "last": "",
                                                       "sessions": set(), "cwds": Counter()})
    mcp_hits: dict[str, dict] = defaultdict(lambda: {"count": 0, "last": "", "sessions": set(),
                                                     "cwds": Counter(), "tools": Counter()})
    agent_hits: Counter = Counter()
    session_items: dict[str, set] = defaultdict(set)
    session_cwd: dict[str, str] = {}
    cwds: Counter = Counter()
    canon: dict[str, str] = {}
    files = 0
    root = CLAUDE / "projects"
    for f in root.rglob("*.jsonl"):
        try:
            if f.stat().st_mtime < since_epoch:
                continue
        except OSError:
            continue
        files += 1
        with f.open(encoding="utf-8", errors="replace") as fh:
            for line in fh:
                has_cmd = "<command-name>" in line
                if not (has_cmd or '"Skill"' in line or "mcp__" in line or '"Agent"' in line or '"cwd"' in line):
                    continue
                try:
                    d = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(d, dict):
                    continue
                ts = parse_ts(d.get("timestamp"))
                if ts is None or ts < since:
                    continue
                sid = d.get("sessionId") or f.stem
                cwd = d.get("cwd") or ""
                if cwd:
                    if "/appdata/local/temp/" in norm_path(cwd) + "/":
                        cwd = "(scratchpad)"  # a session's temp folder, not a project
                    else:
                        cwd = canon.setdefault(norm_path(cwd), cwd)  # D:\work and D:\Work are one folder
                if cwd and sid not in session_cwd:
                    session_cwd[sid] = cwd
                    cwds[cwd] += 1
                iso = ts.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
                msg = d.get("message")
                if not isinstance(msg, dict):
                    continue
                content = msg.get("content")
                if d.get("type") == "user" and isinstance(content, str) and has_cmd:
                    for name in CMD_RE.findall(content):
                        h = skill_hits[name]
                        h["count"] += 1
                        h["by_user"] += 1
                        h["last"] = max(h["last"], iso)
                        h["sessions"].add(sid)
                        h["cwds"][cwd] += 1
                        session_items[sid].add(f"skill:{name}")
                if d.get("type") != "assistant" or not isinstance(content, list):
                    continue
                for block in content:
                    if not isinstance(block, dict) or block.get("type") != "tool_use":
                        continue
                    name = block.get("name") or ""
                    inp = block.get("input") or {}
                    if name == "Skill" and isinstance(inp, dict) and inp.get("skill"):
                        sk = str(inp["skill"]).lstrip("/")
                        h = skill_hits[sk]
                        h["count"] += 1
                        h["by_model"] += 1
                        h["last"] = max(h["last"], iso)
                        h["sessions"].add(sid)
                        h["cwds"][cwd] += 1
                        session_items[sid].add(f"skill:{sk}")
                    elif name.startswith("mcp__"):
                        parts = name.split("__")
                        server = parts[1] if len(parts) > 2 else name
                        h = mcp_hits[server]
                        h["count"] += 1
                        h["last"] = max(h["last"], iso)
                        h["sessions"].add(sid)
                        h["cwds"][cwd] += 1
                        h["tools"]["__".join(parts[2:])] += 1
                        session_items[sid].add(f"mcp:{server}")
                    elif name in ("Agent", "Task") and isinstance(inp, dict):
                        agent_hits[str(inp.get("subagent_type") or "general-purpose")] += 1

    return {"days": days, "files": files, "session_cwd": session_cwd, "cwds": cwds, "skill_hits": skill_hits,
            "mcp_hits": mcp_hits, "agent_hits": agent_hits, "session_items": session_items}


def skill_alias(names: set[str]):
    """Maps a used name onto an inventory skill: `foo` -> `myplugin:foo` when exactly one plugin skill ends so."""
    by_bare: dict[str, list[str]] = defaultdict(list)
    for n in names:
        by_bare[n.split(":")[-1]].append(n)

    def alias(name: str) -> str:
        if name in names:
            return name
        hits = by_bare.get(name, [])
        return hits[0] if len(hits) == 1 else name
    return alias


def finalize_usage(raw: dict, alias) -> dict:
    merged: dict[str, dict] = {}
    for name, h in raw["skill_hits"].items():
        if name.startswith(SELF_PREFIX):
            continue  # the doctor's own runs are not usage
        key = alias(name)
        m = merged.setdefault(key, {"count": 0, "by_model": 0, "by_user": 0, "last": "",
                                    "sessions": set(), "cwds": Counter(), "aliases": set()})
        for f in ("count", "by_model", "by_user"):
            m[f] += h[f]
        m["last"] = max(m["last"], h["last"])
        m["sessions"] |= h["sessions"]
        m["cwds"].update(h["cwds"])
        if name != key:
            m["aliases"].add(name)

    def finish(hits: dict, extra: str | None = None) -> dict:
        out = {}
        for k, h in sorted(hits.items(), key=lambda kv: -kv[1]["count"]):
            row = {"count": h["count"], "last": h["last"], "sessions": len(h["sessions"]),
                   "top_cwds": [c for c, _ in h["cwds"].most_common(5) if c]}
            for key in ("by_model", "by_user"):
                if key in h:
                    row[key] = h[key]
            if h.get("aliases"):
                row["aliases"] = sorted(h["aliases"])
            if extra and extra in h:
                row["top_tools"] = [t for t, _ in h[extra].most_common(6)]
            out[k] = row
        return out

    pairs: Counter = Counter()
    for items in raw["session_items"].values():
        named = set()
        for i in items:
            kind, name = i.split(":", 1)
            if kind == "skill":
                if name in BUILTIN_COMMANDS or name.startswith(SELF_PREFIX):
                    continue
                name = alias(name)
            named.add(f"{kind}:{name}")
        for a, b in combinations(sorted(named), 2):
            pairs[(a, b)] += 1

    skills = finish(merged)
    return {
        "window_days": raw["days"],
        "files_scanned": raw["files"],
        "sessions": len(raw["session_cwd"]),
        "skills": {k: v for k, v in skills.items() if k not in BUILTIN_COMMANDS},
        "builtin_commands": {k: v["count"] for k, v in skills.items() if k in BUILTIN_COMMANDS},
        "mcp": finish(raw["mcp_hits"], "tools"),
        "agents": dict(raw["agent_hits"].most_common()),
        "co_usage": [{"a": a, "b": b, "sessions": n} for (a, b), n in pairs.most_common(60) if n >= 2],
        "cwds": [{"cwd": c, "sessions": n} for c, n in raw["cwds"].most_common(40)],
    }


# ---------------------------------------------------------------- checks




def checks(inv: dict, usage: dict) -> list[dict]:
    out: list[dict] = []

    def add(level: str, code: str, msg: str, **extra):
        out.append({"level": level, "code": code, "message": msg, **extra})

    by_name: dict[str, list[dict]] = defaultdict(list)
    for s in inv["skills"]:
        by_name[s["name"]].append(s)
    for n, rows in by_name.items():
        sources = Counter(r["source"] for r in rows)
        if sources.get("user") and sources.get("project"):
            add("warn", "shadowed-skill", f"'{n}' exists at user level and in {sources['project']} project(s)",
                projects=[r["project"] for r in rows if r["source"] == "project"])
        elif sources.get("project", 0) > 1:
            add("info", "copied-skill", f"'{n}' is copied into {sources['project']} projects (copies can drift)",
                projects=[r["project"] for r in rows if r["source"] == "project"])
        elif len(rows) > 1:
            add("warn", "duplicate-skill", f"'{n}' defined {len(rows)} times", paths=[r["path"] for r in rows])
    for s in inv["skills"]:
        if not s["frontmatter_ok"]:
            add("error", "bad-frontmatter", f"{s['name']}: missing frontmatter or description", path=s["path"])
        elif s["listing_tokens"] > 250:
            add("warn", "long-description", f"{s['name']}: description ~{s['listing_tokens']} tokens", path=s["path"])
        if not s["name_matches_dir"]:
            add("info", "name-dir-mismatch", f"{s['name']}: frontmatter name differs from folder '{s['dir']}'")

    known_bare = {s["name"] for s in inv["skills"]} | {s["dir"] for s in inv["skills"]}
    for src, st in inv["settings"].items():
        for n in (st.get("skillOverrides") or {}):
            if n not in known_bare:
                add("warn", "override-unknown-skill", f"{src}: skillOverrides names unknown skill '{n}'")
    if "user/settings.local.json" in inv["settings"]:
        add("warn", "user-settings-local",
            "~/.claude/settings.local.json is not in the documented settings precedence; its entries may be ignored",
            keys=list(inv["settings"]["user/settings.local.json"].keys()))

    used_skills = set(usage["skills"].keys())
    for s in inv["skills"]:
        if s["source"] == "project" or s["name"].startswith(SELF_PREFIX):
            continue
        if s.get("override") == "off":
            continue
        if s["name"] not in used_skills and s["dir"] not in used_skills:
            add("info", "unused-skill", f"{s['name']}: no use in {usage['window_days']} days",
                listing_tokens=s["listing_tokens"], source=s["source"], scope=s.get("scope"),
                project=s.get("project"))
    for s in inv["skills"]:
        if s.get("override") == "off" and (s["name"] in used_skills):
            add("info", "off-but-used", f"{s['name']}: override is off but it was used in the window")

    configured = {m["name"] for m in inv["mcp"]}
    mcp_by_name: dict[str, list[dict]] = defaultdict(list)
    for m in inv["mcp"]:
        if m["scope"] in ("user", "?"):
            mcp_by_name[m["name"]].append(m)
    for n, rows in mcp_by_name.items():
        if len(rows) > 1:
            # Claude Code drops a plugin's server that duplicates a manual one, keeping the manual
            # one's tool names (mcp__<name>__*); removing the manual one would rename the tools.
            add("info", "duplicate-mcp",
                f"MCP '{n}' is configured {len(rows)} times at user level (deduplicated at runtime; "
                f"keep the manual one unless nothing depends on its tool names)",
                origins=[r["origin"] for r in rows])
    for m in inv["mcp"]:
        if m["name"] not in usage["mcp"]:
            add("info", "unused-mcp", f"MCP '{m['name']}' ({m['origin']}): no calls in {usage['window_days']} days")
    for server, row in usage["mcp"].items():
        if server not in configured and not server.startswith("claude_ai_") and server != "claude-in-chrome":
            add("info", "mcp-used-not-configured",
                f"'{server}' tools were called but no MCP config exists (a mod-registered tool, a connector, or removed)",
                count=row["count"])

    for p in inv["plugins"]:
        if not p["enabled"]:
            add("info", "plugin-disabled", f"plugin {p['key']} installed but disabled")

    for s in inv["skills"]:
        if s.get("override_ignored"):
            add("warn", "override-ignored",
                f"{s['name']}: '{s['override_ignored']['value']}' in ~/.claude/settings.local.json has no effect "
                f"(effective: {s.get('override', 'on')})")
    for proj, state in inv["project_mcp_state"].items():
        for n in state.get("disabledMcpServers", []) + state.get("disabledMcpjsonServers", []):
            if n not in configured and n not in usage["mcp"]:
                add("info", "stale-mcp-toggle", f"{proj}: disables MCP '{n}', which is no longer configured")

    # CLAUDE.md shadows AGENTS.md in the same folder (verified on 2.1.296): AGENTS.md
    # is only read where there is no CLAUDE.md, unless CLAUDE.md imports it.
    inst_by_dir: dict[str, dict[str, dict]] = defaultdict(dict)
    for i in inv["instructions"]:
        p = Path(i["path"])
        inst_by_dir[norm_path(p.parent)][p.name] = i
    for files in inst_by_dir.values():
        cm, am = files.get("CLAUDE.md"), files.get("AGENTS.md")
        if cm and am and not any(Path(x).name == "AGENTS.md" for x in cm["imports"]):
            # often deliberate (AGENTS.md as the Codex/Cursor entry point), so info, not a warning
            add("info", "agents-md-shadowed",
                f"{am['path']} is not read by Claude Code: CLAUDE.md in the same folder takes precedence "
                f"(~{am['tokens']} tokens; only matters if it holds rules CLAUDE.md lacks)",
                path=am["path"], claude_md=cm["path"])

    agent_names = {a["name"] for a in inv["agents"]}
    from_elsewhere = [a for a in usage["agents"] if a not in agent_names and a not in BUILTIN_AGENTS]
    if from_elsewhere:
        add("info", "agent-types-not-on-disk",
            "agent types used in the window that no agents/*.md defines (registered by a mod, or removed)",
            names=from_elsewhere[:20])

    unknown_cmds = [k for k in usage["skills"] if k not in known_bare and k not in BUILTIN_COMMANDS
                    and k not in BUNDLED_SKILLS and not k.startswith(BUNDLED_PREFIXES)
                    and k.split(":")[0] not in {p["key"].split("@")[0] for p in inv["plugins"]}]
    if unknown_cmds:
        add("info", "used-but-missing", "skills/commands used in the window but not found now (removed or project-only)",
            names=unknown_cmds[:30])
    return out


# ---------------------------------------------------------------- main


def main() -> int:
    ap = argparse.ArgumentParser(description="SkillPool doctor scan (read-only)")
    ap.add_argument("--days", type=int, default=90)
    ap.add_argument("--cwd", default=None, help="current project folder to include")
    ap.add_argument("--out", default=str(DEFAULT_OUT),
                    help="report folder (default ~/.claude/skillpool/reports, outside the plugin so updates keep it)")
    args = ap.parse_args()

    raw = scan_usage(args.days)
    projects = [c for c, _ in raw["cwds"].most_common(40)]
    if args.cwd:
        projects.insert(0, args.cwd)
    seen, uniq = set(), []
    for p in projects:
        k = norm_path(p)
        if k not in seen:
            seen.add(k)
            uniq.append(p)
    inv = inventory(uniq)
    usage = finalize_usage(raw, skill_alias({s["name"] for s in inv["skills"]}))

    def in_listing(s: dict) -> bool:
        """Listed in every session: user skills not hidden, and user-scope plugin skills."""
        if s["source"] == "project" or (s["source"] == "plugin" and s.get("scope") in ("local", "project")):
            return False
        return s.get("override", "on") not in ("off", "user-invocable-only")

    listing = sum(s["listing_tokens"] for s in inv["skills"] if in_listing(s))
    result = {
        "generated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "timestamps": "usage.*.last are UTC (Z); generated_at is local time with offset",
        "cwd": args.cwd,
        "summary": {
            "skills": len(inv["skills"]),
            "skills_by_source": dict(Counter(s["source"] for s in inv["skills"])),
            "global_listing_tokens_est": listing,
            "agents": len(inv["agents"]),
            "instruction_files": len(inv["instructions"]),
            "mcp_servers": len(inv["mcp"]),
            "plugins": len(inv["plugins"]),
        },
        "inventory": inv,
        "usage": usage,
        "checks": checks(inv, usage),
    }

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"scan-{datetime.now():%Y%m%d-%H%M%S}.json"
    path.write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
    s = result["summary"]
    print(f"skills={s['skills']} agents={s['agents']} instructions={s['instruction_files']} "
          f"mcp={s['mcp_servers']} plugins={s['plugins']} sessions={usage['sessions']} "
          f"files={usage['files_scanned']} checks={len(result['checks'])}")
    print(f"report: {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
