# Cockpit Tasks

[Русский](README.ru.md)

## What it is

Cockpit Tasks is a standalone task panel for Claude Code. It is for people
who give work to an agent and want to follow its queue, review completed work,
keep a backlog, and revisit task history. Search finds tasks by number or text.
The mod identifier is `cockpit`; its commands and state keys retain that name.
The panel labels and the descriptions in its configuration schema are in Russian.

## Task lifecycle

![Task lifecycle: owner, agent queue, current task, history, backlog and owner review](docs/diagrams/task-workflow.svg)

The diagram explains the workflow in English; the panel itself uses Russian labels.
`task_add` records work; `task_start` makes it current. After verification,
`task_done` closes the task in
history and creates an owner review card when `review` is not `"none"`.
`task_defer` saves a reason and moves unfinished work to the backlog.

The owner's edits and comments change the revision; the agent must read them
before closing or deferring the task. «Принято» sends acceptance to the agent
and keeps the task in history. «Есть замечания» returns the same available task
to the queue with the previous result and the owner's comment. If the original
task is unavailable, the response asks the agent to record the correction as
new work. `task_add` with `start: true` can record and start work in one call.

The diagram is also available as an editable
[draw.io source](docs/diagrams/task-workflow.drawio).

## Screenshots

Actual terminal captures from 8 October 2026. They show the interface before
the 0.16.98 release; task numbers and development comments are examples, and
the captures do not verify changes made after that date. The full-terminal
capture is cropped to the panel. EXIF and XMP metadata have been removed;
the retained pixels and text are unchanged.

| Agent queue | Expanded task description |
| --- | --- |
| <img src="docs/screenshots/task-queue.png" width="360" alt="Agent tab with current tasks and the queue"> | <img src="docs/screenshots/expanded-task.png" width="360" alt="Expanded task card with the full description"> |
| **Task details** | **History and comments** |
| <img src="docs/screenshots/task-details.png" width="360" alt="Task page with description and acceptance text"> | <img src="docs/screenshots/task-history.png" width="360" alt="Completed task with its comment history"> |

## Requirements

Use Linux or macOS, Claude Code with mod support, Python 3.10+, and Git.
The installer checks CLI capabilities and validates the mod contract. Version
2.1.289 is the source API baseline, not a promise about every older release.
The project directory does not need to be a Git repository.

A Nerd Font is optional. Choose `glyphs=plain` if icons do not render correctly.

## One-command installation

Keep this directory in a permanent location, open a terminal there, and run:

```sh
sh install.sh
```

The installer checks Python, Git, and Claude Code, creates
`~/.local/bin/cockpitctl` as a link to the bundled `tools/cockpitctl.py`, and
makes a real runtime read request in temporary state. It then registers the
local `cockpit-tasks` marketplace and installs only `cockpit` for the
current user. It uses no `sudo`, system package manager, or administrator rights.
Installation does not create a task database in your home directory.

Restart Claude Code. Keep the distribution directory in place: the runtime
link and local marketplace use its path. Running `sh install.sh` again skips
completed steps and enables the mod if it was disabled. An existing foreign
runtime file or marketplace is not replaced. The summary reports installed
mods under «поставлено», skipped mods under «пропущено», and the optional font
reminder under «не настроено».

## First steps

Enter `/tasks` to open the panel. Add a task with `/tasks add <text>`, replacing
`<text>` with your request, for example `/tasks add Check login error handling`.

The panel has four tabs:

- «Агенту» shows the agent's current work and task queue.
- «Мне» shows questions and work for the owner to review or decide.
- «Бэклог» keeps deferred tasks that can be returned to work.
- «История» shows completed tasks and results.

Use the search field below the tabs to find a task by number or words and
open its details. The panel normally opens when a session starts; `autoOpen`
controls that behavior.

## Settings

The task page keeps the full description and comments. Long descriptions can
have a cached Haiku summary for their cards; owner requests and acceptance text
are kept as written. `summarizeDescriptions=false` disables new model calls.
If the task runtime is unavailable, native task tools remain usable.

This table is generated from the mod's current `plugin.json` `userConfig`.
Defaults and the original Russian descriptions come directly from that schema.

| Setting | Default | Description from the mod |
| --- | --- | --- |
| `summarizeDescriptions` | `true` | Готовить сводку длинного описания дешёвой моделью один раз; полный текст остаётся на странице задачи |
| `autoOpen` | `true` | Показывать панель задач при старте сессии, сохраняя фокус в строке Claude Code |
| `redirectTodos` | `true` | Перенаправлять штатные TodoWrite и TaskCreate/TaskUpdate/TaskList/TaskGet на инструменты задач Cockpit |
| `compactTaskCalls` | `true` | Показывать вызовы инструментов задач Cockpit короткой строкой с номером и исходом, без отдельного блока результата |
| `resumeAfterCompact` | `false` | После /compact агент сам продолжает задачу, работу над которой ты прервал. Выключено по умолчанию: с этой настройкой /compact означает «сжать и продолжить» |
| `glyphs` | `"auto"` | Как в FileTree: auto, Nerd Font или запасные Unicode |
| `timeZone` | `""` | Пояс для времени комментариев и истории задач: имя IANA, например Europe/Kyiv. Пусто — пояс машины, где запущен Claude Code (при работе по SSH — пояс сервера) |

`autoOpen` opens the task panel at session start while keeping focus in the
Claude Code input. `redirectTodos` routes native TodoWrite and TaskCreate,
TaskUpdate, TaskList, and TaskGet calls to Cockpit tasks. `resumeAfterCompact`
lets the agent resume interrupted work after `/compact`; it defaults to false.
`glyphs` selects `auto`, Nerd Font with `nerd`, or ordinary Unicode with `plain`.
`timeZone` accepts an IANA time zone such as `Europe/Kyiv`; an empty value uses
the time zone of the machine running Claude Code.

View settings:

```sh
claude plugin configure cockpit@cockpit-tasks --json
```

Example configuration:

```sh
printf '%s\n' '{"glyphs":"plain","autoOpen":"false"}' | claude plugin configure cockpit@cockpit-tasks --values-stdin
```

The CLI input uses string values, including `"true"` and `"false"` for boolean
settings. Omitted keys retain their values. Restart Claude Code afterwards.

## Empty states

An empty «Агенту» tab lets you type a task in «Новая задача» or use
`/tasks add <text>`. An empty «Мне» tab means the agent does not currently need
your answer. Deferred tasks appear in the backlog; completed tasks appear in
history. An empty search result means there are no matches; clear the search
to return to the list.

If the panel reports an unavailable runtime, check Python 3.10+, Git, and
the `~/.local/bin/cockpitctl` link, then run `sh install.sh` from the
distribution again. A reference to the private `agentctl` installer in a mod
error message does not apply to this standalone distribution.

## Local data

Tasks and their history normally live in
`~/.local/state/agent-config/cockpit/cockpit.db`. The mod stores this database
on the machine and does not upload it to a server or shared storage. Claude
Code keeps panel state separately in its local mod storage. When using SSH,
the database lives on the machine running Claude Code.

If you set `COCKPIT_STATE_DIR` or `XDG_STATE_HOME`, the runtime uses that state
location. Accepted messages are also stored locally by default; this database
is not part of the distribution. The installation read check uses a temporary
directory and removes its state afterwards.

## Updates

Close Claude Code and update the distribution in the same directory. For a
Git checkout of the standalone repository, obtain the release with
`git pull --ff-only`. Then run from that directory:

```sh
sh install.sh
claude plugin marketplace update cockpit-tasks
claude plugin update cockpit@cockpit-tasks --scope user
```

Restart Claude Code. Reinstallation verifies the runtime; `plugin update`
updates the mod separately. The task database stays in its state directory,
and the mod identifier and setting keys stay the same.

## Removal

Close Claude Code and run:

```sh
claude plugin uninstall cockpit@cockpit-tasks --scope user
claude plugin marketplace remove cockpit-tasks
```

Remove the installer-created `~/.local/bin/cockpitctl` link if it still points
to this distribution's `tools/cockpitctl.py`. You can then remove the
distribution directory. The database remains in the state directory for a
future installation; deleting that data is a separate owner decision.

## Contents and license

This distribution includes only the Tasks mod, its Python runtime, local
marketplace, common installer, and required licenses. The other nine suite
mods, including the executor bridge, are not included. Some development
tests, the internal verification log, and compiler configuration are excluded
because the panel does not need them. This is an installation distribution,
not a complete development checkout of the original suite.

Distribution author: Roman Dmytriev. Copyright (c) 2026 Roman Dmytriev.

Licensed under [MIT](LICENSE). Preserved notices for included code are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
