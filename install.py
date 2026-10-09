#!/usr/bin/env python3
"""Установка локального набора без пакетов системы и доступа к живой базе задач."""

import argparse
import json
import os
from pathlib import Path
import pwd
import platform
import re
import shutil
import subprocess
import sys
import tempfile


class InstallError(Exception):
    """Ошибка проверки или установки; чужие файлы не перезаписываются."""


def run_command(argv):
    try:
        result = subprocess.run(argv, check=False, capture_output=True, text=True, timeout=120)
    except FileNotFoundError as exc:
        label = "Claude Code CLI (claude)" if argv[0] == "claude" else argv[0]
        raise InstallError(f"{label} не найден; установите команду перед повторным запуском.") from exc
    except subprocess.TimeoutExpired as exc:
        raise InstallError("Команда превысила время ожидания; следующий запуск проверит завершённые шаги.") from exc
    if result.returncode:
        # Вывод CLI может содержать личные пути; итог называет команду и код.
        raise InstallError(f"Команда {argv[0]} завершилась с кодом {result.returncode}")
    return result.stdout


def json_list(command, argv):
    try:
        result = json.loads(command(argv))
    except ValueError as exc:
        raise InstallError("Claude Code returned invalid plugin-list JSON") from exc
    if not isinstance(result, list) or any(not isinstance(item, dict) for item in result):
        raise InstallError("Claude Code returned an unsupported plugin-list structure")
    return result


def runtime_target(suite_root, directory):
    source = suite_root / "tools/cockpitctl.py"
    if not source.is_file() or source.is_symlink():
        raise InstallError("Bundled tools/cockpitctl.py is missing or is a symlink")
    target = directory / "cockpitctl"
    for parent in [directory, *directory.parents]:
        if parent.is_symlink():
            raise InstallError("The runtime directory contains a symlink; choose another --runtime-dir")
    if target.is_symlink():
        if target.resolve() != source.resolve():
            raise InstallError("An existing cockpitctl symlink belongs to another source; choose another --runtime-dir")
    elif target.exists():
        raise InstallError("An existing cockpitctl file will not be overwritten; choose another --runtime-dir")
    return source, target


def load_plan(suite_root):
    plan = json.loads((suite_root / "install-plan.json").read_text(encoding="utf-8"))
    catalog = json.loads((suite_root / ".claude-plugin/marketplace.json").read_text(encoding="utf-8"))
    names = [item["name"] for item in plan["plugins"]]
    marketplace = plan.get("marketplace")
    if (plan.get("schemaVersion") != 1 or not isinstance(marketplace, str)
            or not re.fullmatch(r"[a-z][a-z0-9-]*", marketplace)
            or catalog.get("name") != marketplace or not names or len(set(names)) != len(names)
            or any(not re.fullmatch(r"[a-z][a-z0-9-]*", name) for name in names)
            or names != [item.get("name") for item in catalog.get("plugins", [])]):
        raise InstallError("План установки и локальный marketplace не согласованы")
    known = {"python", "git", "runtime", "machine-tools", "survey-files", "chmod", "peer-runtime"}
    for item, published in zip(plan["plugins"], catalog["plugins"]):
        source = Path(item["source"])
        if (source.is_absolute() or ".." in source.parts or not source.parts
                or published["source"] != "./" + item["source"]
                or not isinstance(item["requires"], list) or any(check not in known for check in item["requires"])):
            raise InstallError("Небезопасный путь или неизвестная проверка в плане установки")
    return plan


def dependency_checks(command, suite_root, plan, wanted, home):
    failed, optional = {}, []
    required = {check for item in plan["plugins"] if item["name"] in wanted for check in item["requires"]}
    if platform.system() not in ("Linux", "Darwin"):
        failed["host"] = "Нужен хост Linux или Darwin; установка модов не выполнена"
        return failed, optional
    try:
        version = command(["claude", "--version"])
        match = re.search(r"\b(\d+)\.(\d+)\.(\d+)\b", version)
        if not match or tuple(map(int, match.groups())) < tuple(plan["installation"]["claudeBaseline"]):
            raise InstallError("Нужен Claude Code с API модов версии исходного контракта 2.1.289 или новее")
        for argv, flags in (
                (["claude", "plugin", "install", "--help"], ("--scope",)),
                (["claude", "plugin", "enable", "--help"], ("--scope",)),
                (["claude", "plugin", "list", "--help"], ("--json",)),
                (["claude", "plugin", "marketplace", "list", "--help"], ("--json",)),
                (["claude", "plugin", "marketplace", "add", "--help"], ("--scope",)),
                (["claude", "plugin", "configure", "--help"], ("--values-stdin",))):
            help_text = command(argv)
            if any(flag not in help_text for flag in flags):
                raise InstallError("Claude Code не поддерживает нужные команды плагинов; обновите CLI")
    except InstallError as exc:
        failed["claude"] = str(exc)
        return failed, optional

    python = shutil.which("python3")
    if "python" in required:
        try:
            if python is None:
                raise InstallError("python3 не найден")
            version = json.loads(command([python, "-B", "-c", "import json,sys; print(json.dumps(list(sys.version_info[:2])))"]))
            if tuple(version) < tuple(plan["installation"]["pythonMinimum"]):
                raise InstallError("неподходящая версия")
        except (InstallError, ValueError, TypeError):
            failed["python"] = "Python 3.10+ не найден — установите Python 3.10+ и повторите sh install.sh"
    if "git" in required:
        try:
            command(["git", "--version"])
        except InstallError:
            failed["git"] = "git не найден — установите Git и повторите sh install.sh"
    if "machine-tools" in required and any(shutil.which(tool) is None for tool in ("ps", "df")):
        failed["machine-tools"] = "ps/df не найдены — установите системные утилиты процессов и дисков"
    if "chmod" in required and shutil.which("chmod") is None:
        failed["chmod"] = "chmod не найден — установите утилиту изменения прав"
    if "python" not in failed and "survey-files" in required:
        try:
            source = next(item["source"] for item in plan["plugins"] if item["name"] == "survey")
            helper = suite_root / source / "hooks/files.py"
            with tempfile.TemporaryDirectory(prefix="survey-read-", dir=home) as temporary:
                surveys = Path(temporary) / ".cockpit/surveys"
                surveys.mkdir(parents=True, mode=0o700)
                program = (
                    "import importlib.util,os,sys; assert hasattr(os, 'O_NOFOLLOW'); "
                    "assert all(f in os.supports_dir_fd for f in (os.open, os.stat, os.unlink)); "
                    "s=importlib.util.spec_from_file_location('survey_files', sys.argv[1]); "
                    "m=importlib.util.module_from_spec(s); s.loader.exec_module(m); "
                    "assert m.dispatch({'op':'list','root':sys.argv[2]}) == {'entries':[]}"
                )
                command([python, "-B", "-c", program, str(helper), temporary])
        except (InstallError, OSError):
            failed["survey-files"] = "Помощник Survey/dir_fd/O_NOFOLLOW недоступен — проверьте Python POSIX и целостность поставки"

    if "peer-runtime" in required and "python" not in failed:
        uv = home / ".local/bin/uv"
        uv_command = str(uv) if uv.is_file() and os.access(uv, os.X_OK) else shutil.which("uv")
        try:
            if not uv_command:
                raise InstallError("uv не найден")
            command([uv_command, "run", "--offline", "--no-project", "--no-python-downloads",
                     "--with", plan["installation"]["peerSdk"], "python", "-c",
                     "import sys; from mcp.server import Server; from importlib.metadata import version; "
                     "assert sys.version_info >= (3, 10); assert version('mcp') == '2.2.0'"])
        except InstallError:
            failed["peer-runtime"] = "uv/MCP SDK 2.2.0 недоступны — подготовьте uv с mcp==2.2.0 и повторите установку"

    # validate читает контракт мода; панели и наборы plugin test не запускаются.
    for item in plan["plugins"]:
        if item["name"] in wanted and not any(check in failed for check in item["requires"]):
            try:
                command(["claude", "plugin", "validate", str(suite_root / item["source"])])
            except InstallError:
                failed["mod:" + item["name"]] = "Claude Code отклонил контракт мода — обновите CLI и выполните plugin validate"

    if "github" in wanted:
        if shutil.which("gh") is None:
            optional.append("GitHub CLI — установите gh и выполните gh auth login")
        else:
            try:
                command(["gh", "auth", "status"])
            except InstallError:
                optional.append("GitHub — выполните gh auth login")
    if "peer-agents" in wanted:
        if not any(shutil.which(tool) for tool in ("codex", "agy")):
            optional.append("исполнители — установите codex или agy и войдите в учётную запись")
        else:
            optional.append("исполнители (авторизация и квота не проверены) — выполните quota_status в Claude Code")
    if "filetree" in wanted:
        if shutil.which("sftp") is None:
            optional.append("удалённые машины по SSH — установите OpenSSH с командой sftp")
        else:
            optional.append("удалённые машины по SSH (настройка не проверялась) — задайте SSH alias в настройке remotes мода filetree")
    if "machine" in wanted and shutil.which("sadf") is None:
        optional.append("история ресурсов sadf — установите sysstat")
    if any(name != "peer-agents" for name in wanted):
        optional.append("Nerd Font (шрифт терминала не проверялся) — выберите Nerd Font в своём терминале")
    return failed, optional


def verify_runtime(suite_root, target, home):
    visible = shutil.which("cockpitctl")
    if visible and Path(visible).resolve() != target.resolve():
        raise InstallError("cockpitctl в PATH принадлежит другому источнику — исправьте порядок PATH")
    if target.parent != home / ".local/bin" and not visible:
        raise InstallError("Каталог --runtime-dir отсутствует в PATH — добавьте его и повторите установку")
    with tempfile.TemporaryDirectory(prefix="cockpit-read-", dir=target.parent) as temporary:
        project = Path(temporary) / "project"
        project.mkdir()
        request = {"v": 1, "op": "snapshot", "requestId": "install-readiness",
                   "session": {"sessionId": "install-readiness", "cwd": str(project)}, "args": {}}
        # Новый процесс получает только безопасные служебные входы; живая БД недоступна.
        child_env = {"PATH": os.pathsep.join(os.get_exec_path()), "HOME": temporary,
                     "COCKPIT_STATE_DIR": str(Path(temporary) / "state"),
                     "GIT_CEILING_DIRECTORIES": temporary, "GIT_CONFIG_NOSYSTEM": "1",
                     "GIT_CONFIG_GLOBAL": os.devnull, "PYTHONDONTWRITEBYTECODE": "1"}
        try:
            response = subprocess.run([sys.executable, "-B", str(target), "rpc"], input=json.dumps(request),
                                      capture_output=True, text=True, timeout=30, cwd=project, env=child_env)
            data = json.loads(response.stdout)
            if (response.returncode != 0 or not isinstance(data, dict) or data.get("ok") is not True
                    or data.get("v") != 1 or not isinstance(data.get("result"), dict)
                    or data["result"].get("tasks") != []):
                raise InstallError("RPC рантайма не прошёл проверку — проверьте Python, Git и целостность поставки")
        except (OSError, ValueError, subprocess.TimeoutExpired) as exc:
            raise InstallError("RPC рантайма не прошёл проверку — проверьте Python, Git и целостность поставки") from exc


def print_summary(ready, skipped, optional):
    print("Итог установки:")
    print("поставлено: " + (", ".join(ready) if ready else "ничего"))
    if not skipped:
        print("пропущено: ничего")
    for name, reason in skipped.items():
        print(f"пропущено: {name} — {reason}")
    if not optional:
        print("не настроено: ничего")
    for reason in optional:
        print("не настроено: " + reason)


def main(argv=None, command=run_command, suite_root=None):
    suite_root = (suite_root or Path(__file__).resolve().parent).resolve()
    try:
        plan = load_plan(suite_root)
    except (InstallError, OSError, ValueError, KeyError, TypeError) as exc:
        print(f"Installation stopped: {exc}", file=sys.stderr)
        return 1
    names = tuple(item["name"] for item in plan["plugins"])
    marketplace = plan["marketplace"]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--only", choices=names, help="Установить один мод; по умолчанию весь состав плана")
    parser.add_argument("--runtime-dir", type=Path, help="User-owned cockpitctl directory (default: account home/.local/bin)")
    parser.add_argument("--home", type=Path, help="Домашний каталог получателя; install.sh передаёт HOME")
    args = parser.parse_args(argv)
    home = (args.home or Path(pwd.getpwuid(os.getuid()).pw_dir)).absolute()
    wanted = (args.only,) if args.only else names
    ready, skipped, optional = [], {}, []
    try:
        failed, optional = dependency_checks(command, suite_root, plan, wanted, home)
        for item in plan["plugins"]:
            if item["name"] in wanted:
                failures = [failed[key] for key in ("host", "claude", *item["requires"], "mod:" + item["name"]) if key in failed]
                if failures:
                    skipped[item["name"]] = "; ".join(dict.fromkeys(failures))
        if len(skipped) == len(wanted):
            print_summary(ready, skipped, optional)
            return 1
        # Сначала read-only проверки, затем только недостающие действия.
        marketplaces = json_list(command, ["claude", "plugin", "marketplace", "list", "--json"])
        matching = [item for item in marketplaces if item.get("name") == marketplace]
        if len(matching) > 1:
            raise InstallError(f"Duplicate {marketplace} marketplaces; no configuration was changed")
        if matching:
            previous = matching[0].get("path") or matching[0].get("sourcePath")
            if not isinstance(previous, str) or Path(previous).resolve() != suite_root:
                raise InstallError(f"{marketplace} already belongs to another or unverifiable source; it will not be replaced")
        installed = json_list(command, ["claude", "plugin", "list", "--json"])
        if "cockpit" in wanted and "cockpit" not in skipped:
            directory = args.runtime_dir or home / ".local/bin"
            directory = Path(os.path.abspath(directory))
            source, target = runtime_target(suite_root, directory)
            target.parent.mkdir(parents=True, exist_ok=True)
            if not target.is_symlink():
                target.symlink_to(source)
            try:
                verify_runtime(suite_root, target, home)
                print("Рантайм Задач подготовлен; запрос чтения во временном состоянии прошёл.")
            except InstallError as exc:
                skipped["cockpit"] = str(exc)

        if not matching and any(name not in skipped for name in wanted):
            command(["claude", "plugin", "marketplace", "add", str(suite_root), "--scope", "user"])
            print(f"Added the local {marketplace} marketplace.")
        else:
            print(f"Local {marketplace} marketplace is already registered.")
        for name in wanted:
            if name in skipped:
                continue
            identifier = f"{name}@{marketplace}"
            existing = next((item for item in installed if item.get("id") == identifier), None)
            if existing is None:
                command(["claude", "plugin", "install", identifier, "--scope", "user"])
                print(f"Installed {identifier}.")
            elif existing.get("enabled") is False:
                command(["claude", "plugin", "enable", identifier, "--scope", "user"])
                print(f"Enabled {identifier}.")
            else:
                print(f"Already installed: {identifier}.")
            ready.append(name)
        confirmed = json_list(command, ["claude", "plugin", "list", "--json"])
        for name in list(ready):
            identifier = f"{name}@{marketplace}"
            matches = [item for item in confirmed if item.get("id") == identifier]
            if len(matches) != 1 or matches[0].get("enabled") is not True:
                ready.remove(name)
                skipped[name] = "Claude Code не подтвердил включение — проверьте claude plugin list --json"
        print_summary(ready, skipped, optional)
        print("Сохраните каталог поставки на месте. Перезапустите Claude Code для загрузки модов.")
        return 1 if skipped else 0
    except (InstallError, OSError, ValueError, KeyError, TypeError) as exc:
        for name in wanted:
            if name not in ready and name not in skipped:
                skipped[name] = str(exc)
        print_summary(ready, skipped, optional)
        print(f"Installation stopped: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
