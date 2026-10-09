#!/usr/bin/env python3
"""Проверить границу API, отдельное хранилище владельца и чистоту Client."""
import json
from pathlib import Path
import re

PLUGIN = Path(__file__).resolve().parents[1]


def main():
    register = (PLUGIN / "hooks/register.tsx").read_text(encoding="utf-8")
    assert "$.store" not in register, "В моде появился доступ к постоянному store"
    assert "$.env.set" not in register, "В моде появилась запись окружения"
    assert "as any" not in register, "В моде появился обход типов"
    # Единственный разрешённый вызов дешёвой модели — сводка описания, не решение владельца.
    summary_start = register.index('async function summarizeNextDescription(')
    summary_end = register.index('\nasync function readTaskList(', summary_start)
    summary = register[summary_start:summary_end]
    assert summary.count('$.model.complete(') == 1, 'Сводка использует ровно один путь вызова модели'
    assert '$.model.' not in register[:summary_start] + register[summary_end:], 'API модели появился вне сводки описания'
    for term in ("model: 'haiku'", "effort: 'low'", 'maxTokens: 256', 'timeoutMs: 8000',
                 "'task.summary.claim'", "'task.summary.report'", 'prompt: cleanTaskText(claimed.description)',
                 'epoch !== controller.generation', 'abort.signal.aborted', 'panelSecret(controller, current)'):
        assert term in summary, f'Сводка потеряла ограничение: {term}'
    assert '$.state.set' not in summary and 'update($' not in summary and '$.store' not in summary
    for render in re.findall(r"on\('ui.render'[\s\S]*?\n  \}\)", register):
        assert 'summarizeNextDescription(' not in render and 'startDescriptionTimer(' not in render, 'Отрисовка запускает модель'
    for path in (PLUGIN / "hooks").rglob("*"):
        if path.is_file() and path != PLUGIN / 'hooks/register.tsx':
            assert "$.model." not in path.read_text(encoding="utf-8"), f"В hooks запрещён API модели: {path.relative_to(PLUGIN)}"
    # Единственная реплика мода — продолжение после ручного сжатия (решение владельца 07.10). Оно меняет то, когда агент
    # ждёт человека, поэтому: выключено по умолчанию и включается только явной настройкой; возобновляет только ход,
    # прерванный владельцем; уходит от имени мода и только из пишущей копии; свободного текста задач в реплике нет.
    assert "$.session.append" not in register, "Цикл задач не дописывает сообщения сессии"
    assert re.findall(r"\$\.prompt\.(?!(?:fill|read)\b)\w+", register) == ["$.prompt.submit"], "Цикл задач отправляет реплику только после ручного сжатия"
    assert "asUser" not in register, "Реплика мода не выдаётся за слова владельца"
    manifest = json.loads((PLUGIN / ".claude-plugin/plugin.json").read_text(encoding="utf-8"))
    assert "titleModel" not in manifest["userConfig"], "Настройка выделения задач малой моделью удалена"
    assert manifest['userConfig']['summarizeDescriptions']['type'] == 'boolean'
    assert manifest['userConfig']['summarizeDescriptions']['default'] is True
    assert "options.summarizeDescriptions !== false" in register
    assert "controller.tab === 'owner'" in register
    assert manifest["userConfig"]["resumeAfterCompact"]["default"] is False, "Продолжение после сжатия выключено по умолчанию"
    # Прерванным считается и ход, который оборвала сама команда /compact (решение по TASK-198): конец такого хода
    # доходит до мода позже начала сжатия либо не доходит. Границы прежние: только ручное сжатие главной ленты, только
    # явная настройка, только пишущая копия той же сессии и только пока ход главной ленты не начался.
    assert "const manual = e.trigger === 'manual' && e.agentId === undefined" in register, "Право на продолжение даёт только ручное сжатие главной ленты"
    assert "const candidates = manual ? cutCandidates(controller.tracker, controller.engineWorking) : []" in register and "const marked = manual && await interruptedHere($, controller)" in register, "Отметка и идущие ходы снимаются до сжатия и только для ручного сжатия"
    compact = re.search(r"on\('session\.compact', async \(\$, e, next\) => \{[\s\S]*?\n  \}\)", register)
    assert compact and compact[0].index("const marked = manual && await interruptedHere($, controller)") < compact[0].index("await next(e)"), "Отметка сверяется до сжатия, пока привязка сессии прежняя"
    gate = "if (manual && options.resumeAfterCompact === true) {"
    assert register.count(gate) == 1 and register.count("armResume($, controller, paused)") == 1 and len(re.findall(r"\barmResume\(", register)) == 2, "Ожидание ставится в одном месте: ручное сжатие при явно включённой настройке"
    assert compact[0].index(gate) < compact[0].index("armResume($, controller, paused)") and "const paused = marked || cut || await interruptedHere($, controller)" in compact[0] and "const cut = cutByCompact(controller.tracker, candidates)" in compact[0], "Прерванным ход делает отметка конца либо то, что он шёл в момент запроса сжатия"
    # Реплика уходит не сразу: поставленную в очередь за идущим ходом реплику отменить нельзя, она провисела бы весь ход
    # и продолжила уже закрытую задачу. Ожидание отменяет начало хода главной ленты, смена сессии или каталога.
    arm = re.search(r"\nfunction armResume\([\s\S]*?\n\}", register)
    assert arm and "if (controller.readOnly) return" in arm[0] and "waitResume($, controller, RESUME_SETTLE_MS)" in arm[0] and "$.prompt." not in arm[0], "Ожидание ставит только пишущая копия; сама постановка реплику не отправляет"
    assert arm[0].index("if (controller.readOnly) return") < arm[0].index("controller.resumePending = {"), "Читающая копия ожидания не получает"
    wait = re.search(r"\nfunction waitResume\([\s\S]*?\n\}", register)
    assert wait and "$.clock.after(ms, () => {" in wait[0] and "void resumeAfterCompact($, controller)" in wait[0] and "$.prompt." not in wait[0], "Продолжение вызывается из ожидания по сроку"
    assert register.count("resumeAfterCompact($, controller)") == 1, "Продолжение вызывается только из ожидания после сжатия"
    resume = re.search(r"async function resumeAfterCompact\([\s\S]*?\n\}", register)
    assert resume and "const live = () => controller.resumePending === pending && !controller.readOnly && pending.epoch === controller.generation\n    && pending.mainTurns === controller.tracker.mainTurns" in resume[0], "Продолжает только пишущая копия той же сессии, пока ход главной ленты не начался"
    stale = "if (!live()) { drop('turn-or-session'); return }"
    assert resume[0].count(stale) == 2 and resume[0].index(stale) < resume[0].index("agentContext(") < resume[0].rindex(stale) < resume[0].index("$.prompt.submit("), "Начатый ход и смена сессии проверяются до чтения задачи и ещё раз перед отправкой"
    assert resume[0].count("$.prompt.submit(") == 1 and "$.prompt.submit({ text: compactResume(current.alias) })" in resume[0], "Текст реплики — только compactResume"
    assert resume[0].index("if (!pending.paused) { refuse('self-ended'); return }") < resume[0].index("agentContext("), "Ход, который агент закончил сам, не продолжается"
    # Идущий ход неизвестного вида реплику не получает: решение переносится, а по истечении переносов ход считается работой.
    assert "if (controller.engineWorking === true || pending.rechecks >= RESUME_RECHECKS) { drop('working'); return }" in resume[0] and resume[0].index("drop('working')") < resume[0].index("$.prompt.submit("), "В идущий ход реплика не отправляется"
    start = re.search(r"on\('turn\.start', async \(\$, e, next\) => \{[\s\S]*?\n  \}\)", register)
    assert start and "const started = turnStarted(controller.tracker, e.turnId, e.text)" in start[0] and "if (started === 'main') cancelResume(controller)\n    await " in start[0] and start[0].index("cancelResume(controller)") < start[0].index("await "), "Начало хода главной ленты отменяет ожидающее продолжение до первого await"
    tracker = (PLUGIN / "hooks/domain/compact-resume.ts").read_text(encoding="utf-8")
    began = re.search(r"export function turnStarted\([\s\S]*?\n\}", tracker)
    assert began and "const main = text.trim() !== ''" in began[0] and "tracker.mainTurns += 1\n  tracker.mark = null" in began[0], "Ход с текстом — работа главной ленты: счёт ходов растёт, прежнее прерывание снято"
    ended = re.search(r"export function turnCompleted\([\s\S]*?\n\}", tracker)
    assert ended and ended[0].index("if (agentId !== undefined) return 'side'") < ended[0].index("tracker.mark = ") and "if (started === false) tracker.mainTurns += 1" in ended[0], "Побочный запрос отметку не трогает; ход без текста, оказавшийся ходом главной ленты, считается начавшимся"
    assert "tracker.mark = reason === 'aborted' ? session : null" in ended[0] and tracker.count("tracker.mark = ") == 2, "Отметку ставит только прерванный ход главной ленты"
    cut = re.search(r"export function cutByCompact\([\s\S]*?\n\}", tracker)
    assert cut and "else if (tracker.ended.get(turnId) === 'aborted') cut = true" in cut[0] and "'answer'" not in cut[0], "Ход, закончившийся ответом за время сжатия, оборванным не считается"
    # Отметка прерванного хода — право на продолжение. Она принадлежит сессии и каталогу: записывается ключом сессии
    # только после прерванного хода главной ленты, сверяется с сессией сжатия и сбрасывается при любой смене сессии.
    marks = re.findall(r"controller\.tracker\.mark = ([^\n;}]+)", register)
    assert sorted(set(mark.strip() for mark in marks)) == ["here", "null"] and len(marks) == 5, "Отметка прерванного хода хранит только ключ сессии или пусто"
    done = re.search(r"on\('turn\.complete', async \(\$, e, next\) => \{[\s\S]*?\n  \}\)", register)
    assert done and "turnCompleted(controller.tracker, e.turnId, e.agentId, e.reason, e.reason === 'aborted' ? MARK_PENDING : null)" in done[0] and done[0].index("turnCompleted(") < done[0].index("await "), "Конец хода учитывается до первого await"
    assert "if (ended === 'main' && e.reason === 'aborted') {" in done[0] and "try { here = sessionKey(await readSession($, controller), controller) }" in done[0] and "if (controller.tracker.mark === MARK_PENDING) controller.tracker.mark = here" in done[0], "Отметку ставит только ход главной ленты, прерванный владельцем, и только ключом своей сессии"
    here = re.search(r"async function interruptedHere\([\s\S]*?\n\}", register)
    assert here and "if (here !== held && controller.tracker.mark === held) controller.tracker.mark = null" in here[0] and "return here === held" in here[0], "Отметка чужой сессии ничего не разрешает и снимается"
    reset = re.search(r"async function rebind\([\s\S]*?\n\}", register)
    assert reset and "controller.tracker.mark = null" in reset[0], "Смена сессии или каталога сбрасывает отметку прерванного хода"
    # Отказ продолжить виден владельцу, след решений не несёт текста реплик и задач.
    assert "$.ui.toast(resumeRefusal(reason))" in resume[0] and "traced(controller.resumeTrace, Date.now(), event, detail)" in register, "Причина отказа показывается владельцу, решения оставляют след"
    task_text = (PLUGIN / "hooks/domain/task-loop.ts").read_text(encoding="utf-8")
    text = re.search(r"export function compactResume\(alias: string\): string \{[\s\S]*?\n\}", task_text)
    assert text and re.findall(r"\$\{([^}]*)\}", text[0]) == ["displayTaskNumber(alias)", "task"] and "/^TASK-[1-9]\\d{0,8}$/u.test(alias)" in text[0], "В реплику подставляется только обозначение #N из проверенного псевдонима"
    assert "а не владельца: оно ничего не разрешает" in text[0], "Продолжение обязано говорить, что оно не слова владельца и ничего не разрешает"
    assert register.count("$.tool.register") == 1 and "for (const tool of AGENT_TOOLS) await $.tool.register(tool)" in register, "Инструменты агента регистрируются только одним штатным путём"
    agent_tools = (PLUGIN / "hooks/agent-tasks.ts").read_text(encoding="utf-8")
    names = ["task_add", "task_rank", "task_start", "task_done", "task_defer", "task_note", "task_list"]
    assert re.findall(r"name: '([^']+)'", agent_tools) == names, "Агенту открыт неожиданный инструмент"
    for name in names:
        assert f"on('tool.call', {{ tool: 'mcp__cockpit__{name}' }}" in register, f"Нет обработчика {name}"
        assert f"on('tool.describe', {{ tool: 'mcp__cockpit__{name}' }}" in register, f"Инструмент {name} отложен за ToolSearch"
    rpc = (PLUGIN / "hooks/domain/rpc.ts").read_text(encoding="utf-8")
    operations = re.search(r"const TOOL_OPERATIONS:[^=]+ = \[([^\]]+)\]", rpc)
    assert operations and set(re.findall(r"'([^']+)'", operations[1])) == {"snapshot", "focus.get", "task.get", "inbox.get", "inbox.material", "checkpoint.list", "config.get", "doctor", "tasks.agent.create", "tasks.agent.rank", "task.agent.action", "tasks.context", "tasks.page", "task.resolve", "tasks.search"}, "Агенту открыт лишний RPC записи"
    # Редакторы страницы не используют основную строку; восстановление только дописывает черновик.
    recovery = re.search(r"async function continueTask\([\s\S]*?\n\}", register)
    assert recovery and recovery[0].count("$.prompt.fill") == 1 and "mode: 'append'" in recovery[0] and "mode: 'replace'" not in recovery[0], "Восстановление должно только дописывать черновик"
    assert register.count("$.prompt.fill") == 2 and "$.prompt.read" not in register, "Строку меняют только восстановление и создание новой задачи; редакторы страницы её не читают"
    assert "data.kind === 'action' && data.action === 'new-task-long') await $.prompt.fill({ text: `/tasks add ${data.text}`, mode: 'replace' })" in register, "Перенос новой задачи должен использовать только штатную команду"
    entry = (PLUGIN / "hooks/new-task-entry.ts").read_text(encoding="utf-8")
    assert "e.element === 'new-task' && newTaskEntryVisible(controller)" in register and "isNew ? newTaskEntryVisible(controller)" in register, "Сообщение и вставка новой задачи должны принадлежать видимому полю"
    assert "state.tab === 'agent' && !state.readOnly && !state.page && (state.adding || state.emptyAgentList === true)" in entry, "Поле новой задачи доступно только в редактируемом списке агента: плюс либо пустой список"
    assert "controller.emptyAgentList = Boolean(state.snapshot) && agentCount === 0" in register, "Пустое поле не должно подменять отказ чтения или непустой список"
    for removed in ("longTaskComment", "stopLongComment", "controller.longComment", "page-description-long", "page-comment-long"):
        assert removed not in register, f"Вернулся перенос редактора страницы в строку ввода: {removed}"
    assert "if (e.origin.kind !== 'composer' && e.origin.kind !== 'bridge') return next(e)" in register, "Сводка задач добавляется только к реплике владельца"
    assert register.count("on('prompt.compose'") == 1 and "id: 'cockpit:agent-tasks', text: TASK_STEERING, scope: 'session'" in register, "Правила агента должны быть одной сессионной секцией"
    assert "e.traits.includes('print') || e.traits.includes('bare')" in register, "Правила списка попали в print/bare"
    assert "context: [...(e.context ?? []), summary]" in register and "submitted.drop === undefined" in register, "Сводка не сохраняет чужой контекст или расходует новости отклонённой реплики"
    task_loop = (PLUGIN / "hooks/domain/task-loop.ts").read_text(encoding="utf-8")
    assert "full ? 6000 : 1500" in task_loop and "loop.reminded" in task_loop, "Нет предела сводки или ограничения повторов страховки"
    assert "const below = await next(e)" in register and "return below" in register, "AbovePrompt не сохраняет нижний результат"
    owner_path = PLUGIN / "hooks/owner/engine.tsx"
    owner = owner_path.read_text(encoding="utf-8")
    assert not re.search(r"\$\.(?:env|fs|process|model)\.", owner), "Движок владельца вышел за state/store/prompt/session/ui/clock/tool"
    assert "as any" not in owner and "@ts-ignore" not in owner, "Обход типов в движке владельца"
    assert "return `owner-tasks:${live.root}`" in owner, "Хранилище владельца не изолировано по корню проекта"
    assert "held: HELD" in owner and not re.search(r"held:\s*(?!HELD)\w", owner), "Удержанный ответ пишется в состояние сессии"
    assert "$.command.register" not in owner and "$.ui.open" not in owner and "$.ui.close" not in owner, "Движок владельца управляет общей панелью или командами"
    for path in (PLUGIN / "hooks/domain").glob("*.ts"):
        source = path.read_text(encoding="utf-8")
        assert not re.search(r"\$\.[A-Za-z]", source), f"API хоста в domain/{path.name}"
        assert "as any" not in source, f"Обход типов в domain/{path.name}"
        assert not re.search(r"(?:from\s+['\"]claude-code|\b(?:process|fetch|Date\.now|crypto)\.)", source), f"Побочный эффект в domain/{path.name}"
    for path in (PLUGIN / "hooks").rglob("*.ts*"):
        if path not in (PLUGIN / "hooks/register.tsx", owner_path):
            source = path.read_text(encoding="utf-8")
            assert "$." not in source, f"API хоста в Client или чистом модуле: {path.name}"
            assert "as any" not in source, f"Обход типов в Client или чистом модуле: {path.name}"
            assert not re.search(r"\b(?:setInterval|setTimeout|fetch)\s*\(", source), f"Внешний эффект в Client или чистом модуле: {path.name}"
    assert "Input" not in (PLUGIN / "hooks/task-page.tsx").read_text(encoding="utf-8"), "Поле страницы попало в Client"
    rows = (PLUGIN / "hooks/rows.tsx").read_text(encoding="utf-8")
    assert not list((PLUGIN / "hooks/files").glob("*.ts")), "Вернулся собственный файловый адаптер"
    assert not list((PLUGIN / "hooks/ui").glob("*.ts*")), "Вернулась старая оболочка"
    source_rows = (PLUGIN.parents[0] / "filetree/hooks/rows.tsx").read_text(encoding="utf-8")
    assert rows == source_rows, "Движок рядов перестал быть прямой копией FileTree"
    for name in ("panel-actions.tsx", "panel-header.tsx"):
        assert (PLUGIN / "hooks" / name).read_bytes() == (PLUGIN.parent / "filetree/hooks" / name).read_bytes(), f"Общий модуль {name} разошёлся с FileTree"
    for mod in ("filetree", "machine", "github", "agentpane", "env", "survey"):
        assert (PLUGIN / "hooks/theme.ts").read_bytes() == (PLUGIN.parent / mod / "hooks/theme.ts").read_bytes(), f"Общая тема разошлась: {mod}"
    for name in ("layout.ts", "card-controls.tsx", "panel-actions.tsx"):
        assert (PLUGIN / "hooks" / name).read_bytes() == (PLUGIN.parent / "env/hooks" / name).read_bytes(), f"Копия редактора env разошлась: {name}"
    # В env действия живут на внешней рамке, название поля — значок; длинное замечание ограничено шириной.
    editor = (PLUGIN / "hooks/editor.tsx").read_text(encoding="utf-8")
    editor_changes = (
        ("widerThan }", "widerThan, truncateCells }"),
        ("\n  focusRevision?: number; focused?: boolean\n", "\n  focusRevision?: number; focused?: boolean\n  controls?: false\n"),
        (": state.focused ? props.caption ?? '' : ''", ": props.caption ?? ''"),
        ("${caption}", "${truncateCells(caption, props.width - 6)}"),
        ("{drawCardControls(ui", "{props.controls === false ? null : drawCardControls(ui"),
    )
    for before, after in editor_changes:
        assert editor.count(before) == 1, f"Изменилась исходная строка адаптации редактора: {before}"
        editor = editor.replace(before, after, 1)
    assert editor == (PLUGIN.parent / "env/hooks/editor.tsx").read_text(encoding="utf-8"), "Копия editor.tsx в env изменила что-то кроме оформления рамки"
    secret_views = sorted(PLUGIN.parent.glob("*/hooks/secret-view.ts"))
    assert secret_views, "Общий модуль secret-view.ts отсутствует"
    for path in secret_views[1:]:
        assert path.read_bytes() == secret_views[0].read_bytes(), f"Общий модуль secret-view.ts разошёлся: {path.parent.parent.name}"
    assert "ClientModule<RowsProps, Local>" in rows and "surface.every(" in rows
    assert "state.ref.stop()" in rows, "Client не останавливает локальные часы"
    hooks = json.loads((PLUGIN / "hooks/hooks.json").read_text(encoding="utf-8"))
    assert hooks == {"modules": ["./register.tsx"]}
    print("surface-check: API только в register.tsx и owner/engine.tsx; domain/Client чистые; store владельца изолирован; env.set/as any отсутствуют; копии FileTree совпали")


if __name__ == "__main__":
    main()
