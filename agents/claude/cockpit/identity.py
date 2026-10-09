"""Идентичность проекта по common dir, checkout — по каноническому корню."""

import os
import subprocess
from dataclasses import dataclass

from . import CockpitError


@dataclass(frozen=True)
class Identity:
    kind: str
    project_path: str
    worktree_path: str


def registered(db, cwd: str):
    directory = os.path.realpath(cwd)
    if not os.path.isdir(directory):
        raise CockpitError("INVALID_REQUEST", "session.cwd должен указывать на существующий каталог.")
    rows = db.execute("""SELECT p.identity_kind,p.canonical_path,w.local_path FROM worktrees w
        JOIN projects p ON p.project_id=w.project_id ORDER BY length(w.local_path) DESC""")
    for kind, project, root in rows:
        if os.path.commonpath((root, directory)) != root:
            continue
        # Вложенный новый Git-репозиторий ещё может не быть зарегистрирован.
        # Его маркер запрещает заимствовать свидетельство внешнего дерева.
        child = directory
        while child != root:
            if os.path.lexists(os.path.join(child, ".git")):
                return None
            child = os.path.dirname(child)
        return Identity(kind, project, root)
    return None


def resolve(cwd: str) -> Identity:
    directory = os.path.realpath(cwd)
    if not os.path.isdir(directory):
        raise CockpitError("INVALID_REQUEST", "session.cwd должен указывать на существующий каталог.")
    try:
        common = subprocess.run(
            ["git", "-C", directory, "rev-parse", "--git-common-dir"],
            capture_output=True, text=True, encoding="utf-8", timeout=2,
        )
        if common.returncode != 0:
            return Identity("directory", directory, directory)
        root = subprocess.run(
            ["git", "-C", directory, "rev-parse", "--show-toplevel"],
            capture_output=True, text=True, encoding="utf-8", timeout=2,
        )
    except (OSError, subprocess.TimeoutExpired, UnicodeError) as exc:
        raise CockpitError("DB_UNAVAILABLE", "Не удалось вычислить Git-идентичность проекта.") from exc
    common_path = os.path.realpath(os.path.join(directory, common.stdout.rstrip("\n")))
    worktree_path = os.path.realpath(root.stdout.rstrip("\n")) if root.returncode == 0 else directory
    return Identity("git", common_path, worktree_path)
