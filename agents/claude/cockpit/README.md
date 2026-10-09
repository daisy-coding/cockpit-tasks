# Cockpit M1/M2: локальное durable core

Python 3.12, только стандартная библиотека. Режим `observe`, без демона и
адаптеров Claude внутри рантайма. Этот документ — фактический контракт реализованных
операций M1/M2. Проектные схемы описывают более широкий будущий runtime
и не валидируют данный envelope.

## Сводка описания карточки (задача #233)

Миграция 12→13 добавляет `task_description_summaries`, не меняя прежних строк,
таблиц, фокуса и ревизии задачи. Ключ кеша — `task_id` и SHA-256 полного описания.
В нём хранятся сессия захвата, `summary` (до 300 знаков либо NULL) и признак
завершённой попытки. Возврат к прежнему содержимому использует прежний кеш.

Аттестованная панель вызывает `task.summary.claim` с `taskId` и `expectedRevision`.
Короткий безопасный текст (до 300 знаков) или уже захваченная редакция отвечают
`{claimed:false}`. Победитель атомарно записывает захват до вызова модели и
получает `{claimed:true,descriptionHash,description}`; описание проходит тот же
`shown(...,4000,multiline=True)`, что `task.get`, до отправки в модель.

`task.summary.report` принимает `taskId`, `descriptionHash` и `summary` (строка
или NULL при отказе) только от захватившей сессии. Посторонний, пустой, незаконченный
или слишком длинный ответ оставляет NULL. Проверка связи с исходником требует
двух общих корней значимых слов; это фильтр постороннего ответа, не доказательство
смысловой точности. Повтор отчёта не переписывает первый результат. Изменённое
описание не получает старую сводку. Сбой/перезапуск после захвата не запускает
модель снова: карточка продолжает показывать начало текста.

Необязательный `metrics` сохраняет длительность вызова и четыре счётчика токенов
из `ModelUsage`. При отказе без ответа сохраняется только длительность; неизвестный
расход остаётся NULL. Принимаются только ограниченные целые числа, никакие строки
или тексты запроса в метрики не попадают. Повтор отчёта не меняет измерения.
Это фактический расход токенов, а не цена в валюте: денежный замер требует живого
вызова выбранной модели и её тарифа. Тестовый хост не доказывает такой замер.

Сводка маскируется перед сохранением и выдачей. `task.get`, строки `tasks.page`
и `snapshot.workingTasks` несут необязательное поле `summary` рядом с прежним
`description`. Полный текст страницы задачи сохраняется. CLI без свидетельства
и `actor:agent` не могут записывать сводку.

## Запуск и база

```sh
python3 tools/cockpitctl.py status
python3 tools/cockpitctl.py inbox --limit 10
python3 tools/cockpitctl.py show <inboxId>
python3 tools/cockpitctl.py tasks --limit 10
python3 tools/cockpitctl.py tasks --candidates
python3 -m agents.claude.cockpit context --cwd /absolute/checkout
python3 -m agents.claude.cockpit context --cwd /absolute/checkout --cursor 123
python3 tools/cockpitctl.py show <taskId>
python3 tools/cockpitctl.py doctor
python3 tools/cockpitctl.py config get capture-mode
python3 tools/cockpitctl.py config set capture-mode off
python3 tools/cockpitctl.py config get gate
python3 tools/cockpitctl.py config set gate observe
python3 tools/cockpitctl.py config get queue
python3 tools/cockpitctl.py config set queue paused
python3 tools/cockpitctl.py gate stats --days 7
python3 tools/cockpitctl.py gate recent --limit 10
python3 tools/cockpitctl.py triage <inboxId> --expected-revision 1 --type blocking --task <taskId>
python3 tools/cockpitctl.py triage <inboxId> --expected-revision 2 --status triaged
python3 tools/cockpitctl.py confirm <taskId> --expected-revision 0
python3 tools/cockpitctl.py checkpoint add <taskId> "Проверка пройдена" --kind tests-passed --expected-revision 1
python3 tools/cockpitctl.py checkpoint list <taskId> --limit 5
python3 tools/cockpitctl.py detour --title "Срочное исправление" --expected-revision 1
python3 tools/cockpitctl.py return --expected-revision 2
```

Файл CLI исполняемый; работает через симлинк на `tools/cockpitctl.py`.
Глобальный `--cwd <каталог>` перед подкомандой задаёт проект человеческого CLI;
по умолчанию используется текущий каталог. CLI использует sessionId `cli`.
Команды просмотра не создают задачу и не меняют фокус.
Команда модуля `context` печатает JSON-сводку `tasks.context` без envelope;
при доменном отказе печатает envelope ошибки и возвращает exit 1. Запускается
из корня репозитория (либо с доступным Python-пакетом); без `--cwd` берёт
текущий каталог. Это отдельная команда только чтения внутри рантайма:
внешний `tools/cockpitctl.py` и перечень команд стража мода не изменены.
`tasks` и `show <taskId>` показывают приоритет `P0`…`P3`, закрепление знаком
`*` и исполнителя. `show <inboxId>` по-прежнему читает исходное указание;
идентификатор задачи проверяется после `NOT_FOUND` для Inbox.
Ревизия для записи обязательна: у triage это `triageRevision` пункта, у
confirm/checkpoint add — ревизия задачи, у detour/return — ревизия фокуса.
`checkpoint list --expected-revision N` необязателен и проверяет актуальность
задачи при чтении. `triage --type unknown` задаёт неопределённый вид,
`--clear-task`/`--clear-resource` снимают соответствующую привязку;
`--task ID`/`--resource ID` задают её. `detour --task ID` выбирает существующую
задачу вместо создания новой. `checkpoint add --source` принимает SourceKind
из контракта ниже; по умолчанию `user`, вид по умолчанию `note`.

База: `${COCKPIT_STATE_DIR}/cockpit.db`, иначе
`${XDG_STATE_HOME:-~/.local/state}/agent-config/cockpit/cockpit.db`.
Каталог `0700`, база/WAL/SHM `0600`; символические ссылки на каталог и файлы
базы отвергаются. Файлы должны принадлежать текущему пользователю и не иметь
жёстких ссылок. Данные, тексты и БД не входят в portable-конфиг или Git.

Версия схемы SQLite — **`13`** (`SCHEMA_VERSION`), миграции транзакционные, идемпотентные, по `user_version`.
Миграция 1 сохранена; миграция 2 добавляет к задачам `certainty` и
`certainty_source`, таблицы `inbox_observations`, `checkpoints`, `focus_stack`
и производное представление `inbox_state`. Все старые задачи (включая
no-source, done и cancelled) получают `observed`/`engine`, поскольку M1
создавал их автоматически. Старые оригиналы, диапазоны, фокус, ревизии,
журнал и сохранённые ответы не переписываются. Старые пункты Inbox остаются
без классификации: фокус на момент их захвата неизвестен.
Миграция 3 добавляет `project_config`, `worktree_leases`, `gate_observations`:
проектный флаг, одну аренду на рабочее дерево и неизменяемый журнал стража.
Миграции 1 и 2 сохранены; данные версии 2, включая классификации, отметки,
стек и кэш RPC, не переписываются. Для существующих проектов страж выключен.
Миграция 4 добавляет происхождение к наблюдениям Inbox, уверенности задач,
отметкам, стеку отхода и настройкам, а также `session_attestations` с SHA-256
свидетельства, составной привязкой и временем регистрации. Все существующие
строки получают `cli`: их происхождение не проверялось. Миграции 1–3 и
сохранённые ответы остаются дословными; представление Inbox дополняется
происхождением действующего наблюдения и последнего разбора.
Миграция 5 добавляет сессию и рабочее дерево автора наблюдения Inbox,
представление `authorized_inbox_observations` и обновляет выбор действующего
наблюдения. Строки и кэш версии 4 сохраняются; старым наблюдениям автор
не приписывается, поэтому они не могут снять причину стража как решение панели.
Миграция 6 добавляет `task_steps`, порядок очереди, накопленные часы и признак
скрытой карточки. Исходники, отметки и версии прежних ответов остаются неизменными.
Миграция 7 добавляет `description`, `assignee`, `priority`, `priority_source`,
`priority_pinned`, `priority_provenance` и таблицу `task_lists` для критериев
приёмки и ограничений. В ней вид списка (`acceptance`/`constraints`) и позиции
`0..9`, как у шагов, задают устойчивый порядок. У прежних задач описание пустое,
списки пустые, исполнитель NULL, приоритет 2, источник `model`, закрепление 0,
происхождение `cli`. В `project_config` добавлены `queue_mode=run` и отдельное
`queue_provenance=cli`. Прежние столбцы, шаги, фокус, события, ревизии и
сохранённые ответы версии 6 не меняются; миграции 1–6 сохранены. Все DDL и
смена `user_version` входят в одну транзакцию; повторное открытие не меняет данные.
Миграция 8 добавляет `stage`, `adopted_by`, `dismiss_reason`, `dismissed_at`.
Прежние строки получают `stage=task`, остальные новые поля — NULL.
Отзыв свидетельств хранится отдельно в `attestation_revocations`: привязка
отозванной сессии, `revoked_by=owner`, `revoking_session_id`, `revoked_at`.
Отпечатки `session_attestations` остаются неизменяемыми. Листовая таблица
`checkpoints` перестраивается с прежними данными, порядком и триггерами, чтобы
разрешить происхождение `tool`. Миграции 1–7, прежние значения, источники,
ревизии и сохранённые ответы не переписываются. Переход 7→8 и откат сбоя DDL
проверены на базе с задачами, отметкой и сохранёнными ответами.
Миграция 9 однократно переводит в `stage=candidate` старые активные задачи
`inferred/provider`, которые владелец не принимал, не подтверждал и не правил.
Задачи с контрольными точками, фокусом любого рабочего дерева или записью в
стеке отхода остаются задачами. Подтверждения и правки учитываются по журналу
`task.confirmed`, `task.edited`, `task.panel.*` и `adopted_by=owner`.
Меняется только `stage`: даты создания, ревизии, порядок, поля и сохранённые
ответы не переписываются. Обычное истечение кандидатов через 24 часа сохраняется.
Проверены переход 8→9, полный откат при сбое и неизменное повторное открытие.
Миграции 1–8 сохранены дословно.
Миграция 10 закрывает прежних незакрытых кандидатов: для `stage=candidate`,
`status=active|paused`, `dismiss_reason IS NULL` ставит `dismiss_reason=expired`
и `dismissed_at` в UTC. Причина `expired` уже существует и обозначает потерю
актуальности предложения; она не приписывает владельцу отказ. Стадия остаётся
`candidate`, статус, ревизия, даты создания/обновления и все прочие поля сохраняются.
Ранее отклонённые и терминальные записи остаются прежними. Закрытые кандидаты
исключены из snapshot, но доступны отдельным `task.get`; исходники и связи остаются.
Миграции 1–9 сохранены дословно. Таблица задач перестраивается с тем же rowid,
порядком столбцов, ограничениями и индексами, разрешая происхождение `tool`
в `certainty_provenance` и `priority_provenance`; прежние значения не меняются.
На время этой транзакции SQLite foreign keys выключаются только на её соединении:
полный `foreign_key_check` обязан пройти **до commit**, после commit/rollback
`foreign_keys=ON` возвращается. Все источники, события, свидетельства,
отзывы и сохранённые ответы остаются побайтно прежними.
Добавляются отдельные `task_agent_notes` (неизменяемые заметки `agent/tool`)
и `task_closures` (время последнего завершения). Для старых выполненных задач
время завершения первоначально берётся из `updated_at`: более точной прежней
отметки нет. Переход 9→10, откат при ошибке и неизменное повторное открытие
проверяются новым набором; включённые foreign keys проверяются после открытия.
Миграция 11 добавляет только `task_owner_comments` и её индекс. Контрольные точки
`kind=note`, `source=user`, `provenance=panel` копируются с прежними идентификаторами,
текстами и временем создания; `updated_at=created_at`, `revision=0`, `deleted=0`.
Исходные контрольные точки, все старые строки, определения существующей схемы,
события и кэш ответов не меняются. Миграции 1–10 сохранены дословно;
перестройки таблиц и отключения foreign keys при переходе 10→11 нет.
Создание таблицы, копирование и смена версии входят в одну транзакцию;
сбой полностью откатывается, повторное открытие копии не дублирует.
Миграция 12 добавляет только `attestation_usage`: составную привязку свидетельства
и `last_used_at`. Прежние отпечатки, отзывы, задачи, комментарии, события,
сохранённые ответы и определения существующей схемы не изменяются.
Для прежних свидетельств начальное `last_used_at=created_at`: прежнее успешное
использование не измерялось, поэтому миграция не продлевает ключ задним числом.
Старый ключ может сразу оказаться просроченным; мод создаёт новую привязку.
Новая таблица, заполнение и смена версии транзакционные; сбой полностью
откатывается, повторное открытие неизменно. Таблицы не перестраиваются,
foreign keys не выключаются, снимок для перехода 11→12 не требуется.
При обновлении более старой базы снимок перед перестройкой миграции 10 сохраняется.
Будущая версия отвергается с `DB_UNAVAILABLE`. WAL, `foreign_keys=ON`,
`busy_timeout=2000`, `synchronous=FULL`. Каждая запись проходит через
`BEGIN IMMEDIATE`; доменное изменение, события и ответ идемпотентности
фиксируются одним commit. Никаких внешних эффектов; Git используется только
для чтения идентичности, вне транзакции записи.

Обычное открытие обеспечивает права и применяет миграции. `doctor` требует
уже созданную базу текущей версии, проверяет фактические права и ничего не
исправляет. Без `panelSecret` он не сохраняет ответ в `requests`: повтор нового
`requestId` вычисляет диагностику заново. Вызов со свидетельством записывает
привязку/использование ключа и сохраняет прежний повтор ответа; его счётчики
измерены до записи этого ответа. WAL/SHM могут отсутствовать
после закрытия последнего соединения — это штатно.

При записи нового ответа `requests.committed_at` используется для попутной
уборки: удаляются до 200 ответов старше суток, в той же транзакции. Свежие
ответы сохраняются; повтор сохранённого ответа уборку не запускает. Старая
строка может оставаться до следующих записей, и пока она есть, прежний повтор
доступен. Уборка идёт с головы журнала по `rowid` и останавливается на восьми
свежих строках подряд: отбор по времени без индекса читал бы весь журнал вместе
с ответами при каждой записи. Схема/pragma не меняются, `VACUUM` не выполняется.

Виды `snapshot`, `tasks.search`, `tasks.page`, `task.get`, `task.resolve`,
`focus.get`, `inbox.get`, `inbox.material`, `checkpoint.list`, `gate.stats`,
`gate.recent`, `config.get` не сохраняют ответы в `requests`: повтор вида
возвращал устаревшую картину и стоил мегабайтов журнала на каждый вызов панели;
вычислить вид заново дешевле и вернее. Каждый вызов, включая повтор и ключ
исторического вида, проходит общий ingress: привязку сессии, проверку
свидетельства и обновление срока его использования при успехе. Существующий
ключ с другим телом по-прежнему даёт `IDEMPOTENCY_CONFLICT`; новый ключ вида
не создаёт строки и не запускает уборку. Исторические строки не переписываются.
`tasks.context` сохраняет прежнее состояние и `cursor` при повторе, все записи
остаются в журнале. Подробный разбор сохранён во внутреннем отчёте о журнале запросов.

Проверка/установка прав с открытием файлов выполняется **до** sqlite3.connect.
После открытия соединения разрешён только lstat для диагностики: на POSIX
закрытие постороннего FD того же файла снимает fcntl-блокировки процесса,
включая SQLite SHM. Это давало SIGBUS при холодном параллельном старте.
Регрессия store.test.py проверяет владение реальной SHM-блокировкой через
отдельный процесс; до исправления она детерминированно падала. Новые WAL/SHM
получают 0600 от SQLite с закрытым umask и уже закрытой по правам базой.

## JSON RPC

Дополнение 0.8.0: `task.get` возвращает карточку; `inbox.material` — только
материал после `shown`/`plain`. `task.create(title, steps?, …)`, `task.edit`, `tasks.rank`,
`task.action(taskId, expectedRevision, expectedFocusRevision, action, step?)`
и `tasks.extract(inboxId, tasks)` требуют зарегистрированного panelSecret.
Действия: current/done/defer/restore/up/down/delete/step. Удаление — скрытие
с сохранением источников и отметок. С версии хранилища 8 выделение создаёт кандидатов. Оно атомарно, ограничено источником
той же сессии и дедуплицируется по inboxId. Карточки содержат шаги,
queuePosition, sourcePhrase, lastCheckpoint, needsDecision и active clock.
Начало работы ставит первый незавершённый шаг выполняемым; переключение
останавливает прежние часы и возвращает прежний шаг в pending.
Возврат к отложенной карточке делает её активной. session.end останавливает
часы, session.rebind возобновляет активную карточку и читает до 100 задач.
Версия envelope остаётся v1; миграции 1–5 не изменены.

`cockpitctl rpc` принимает один JSON в UTF-8, максимум **1 048 576 байт**.
Чтение stdin ограничено лимитом плюс один байт. Второй JSON, дубликаты ключей,
NaN/Infinity, недопустимый Unicode и лишние поля отвергаются.

```json
{"v":1,"op":"capture.prompt","requestId":"delivery-123","session":{"sessionId":"conversation-1","cwd":"/absolute/checkout"},"args":{"text":"Исходное указание\r\n"}}
```

Все пять полей обязательны; `panelSecret` и `actor` необязательны.
`actor` принимает `owner` (по умолчанию) или `agent` и допустим только
с правильным `panelSecret`. Поле без свидетельства — `INVALID_REQUEST`,
неверное свидетельство — `ATTESTATION_FAILED`. Явное поле `actor` входит
в отпечаток идемпотентности; отпечатки прежних запросов без поля не меняются.
`session` содержит только `sessionId`, `cwd`;
`cwd` — абсолютный существующий каталог, используется только для идентичности.
В зарегистрированном дереве выбирается самый длинный канонический предок из
`worktrees.local_path`, с границей каталога. Подкаталог и симлинк внутрь дерева
сохраняют привязку и ключ. Другое дерево или вложенный Git-репозиторий имеют
отдельную привязку; новый `.git` внутри предка исключает заимствование его ключа.
Git нужен только для ещё неизвестного дерева, вне транзакции записи.
`binding.worktreePath` возвращает канонический корень, по которому мод хранит
свидетельство независимо от текущего подкаталога; кэш чтения использует тот же предок.
`args` — объект с точным набором полей операции. requestId, sessionId,
deliveryId и ссылки на сущности — непустые идентификаторы до 100 code points:
первая ASCII-буква/цифра, остальные ASCII-буквы/цифры и `_.:-`.

```json
{"v":1,"ok":true,"result":{}}
{"v":1,"ok":false,"error":{"code":"REVISION_CONFLICT","message":"Ревизия задачи устарела; получите свежий snapshot."}}
```

stdout содержит ровно один JSON и завершающий перевод строки. Успех и ошибки
контракта возвращают exit `0`; неожиданный сбой процесса — ненулевой exit с
коротким сообщением в stderr. Трассировки клиенту не выводятся. Человеческий
CLI возвращает `1` при доменной ошибке, argparse — `2` при неверном синтаксисе.

Идемпотентность глобальна в пределах базы. Ключ — requestId; SHA-256 считается
по UTF-8 `json.dumps(request, sort_keys=True, ensure_ascii=False,
separators=(",",":"), allow_nan=False)`. Unicode/CRLF не нормализуются.
Для запроса со свидетельством перед вычислением сохраняемого отпечатка
`panelSecret` удаляется и добавляется только `panelProof:true`. Значение
секрета и его SHA-256 в `requests` не входят; ответ регистрации — только
`{attested:true}`. Признак отделяет запрос панели от запроса CLI, чтобы
повтор без секрета не получил сохранённый ответ панели. Правильность
свидетельства проверяется до чтения кэша, внутри той же `BEGIN IMMEDIATE`.
Для журналируемых операций повтор того же запроса возвращает сохранённый
ответ без повтора доменного действия;
успешное подписанное чтение кэша обновляет только время использования свидетельства.
Другой запрос с сохранённым ключом — `IDEMPOTENCY_CONFLICT`. Сохранённые ответы
могут быть историческими; виды вычисляются заново, даже если старый ответ есть
в журнале. Доменный отказ журналируемой операции также кэшируется;
невалидный envelope, `DB_UNAVAILABLE`, `ATTESTATION_FAILED` и `ATTESTATION_CONFLICT` не кэшируются. После восстановления
БД можно повторить прежний ключ. JSON-аргументы и свободные reason никогда
не становятся командами shell.

Коды ошибок: `INVALID_REQUEST`, `UNKNOWN_OP`, `IDEMPOTENCY_CONFLICT`,
`REVISION_CONFLICT`, `NOT_FOUND`, `DB_UNAVAILABLE`, `NOT_IMPLEMENTED`, `ATTESTATION_FAILED`, `ATTESTATION_CONFLICT`, `TASK_LIMIT_REACHED`.
Недопустимый переход статуса — `INVALID_REQUEST`. Межпроектная ссылка и
inbox из другого checkout — `NOT_FOUND`.

Для совместимости с модом M1 поле **`schemaVersion:1`** в Snapshot и Doctor
сохраняется как версия формы RPC-проекции. Фактическую версию SQLite
сообщает **`storageSchemaVersion:13`**. Envelope остаётся `v=1`.
Сохранённый ответ журналируемой операции M1 при повторе прежнего requestId
сохраняет прежний набор полей, без добавленных полей M2. Его title/preview также проходят shown на
выходе: старый task.update мог записать неотфильтрованный title в кэш.
Сами строки requests, текст исходника и hash идемпотентности не меняются.

## Свидетельство панели и происхождение

`session.attest` принимает пустые args и обязательное поле envelope
`panelSecret`: 64 строчных hex-символа, представляющих 32 случайных байта.
Мод генерирует их через `crypto.getRandomValues`, хранит только в памяти
контроллера модуля и передаёт через stdin. В сессионном `$.state` под
`cockpit.attestations` хранится только несекретная отметка владения:
`ownerRoot`, `loadId`, `epoch`, `runtimeSessionId`. Секрет не записывается в state,
store, проекцию панели, уведомления или логи. При первом чтении старого состояния
0.9.1 поле `secret` удаляется перезаписью всего значения; свой обработчик
`state.set` отклоняет запись с этим полем. После перезагрузки у владеющей копии
нет ключа в памяти: она сразу перепривязывается к новой эпохе
`<Claude sessionId>.cockpit-<n>-<8 hex>` и регистрирует новое свидетельство
без промежуточного отказа и сообщения владельцу.
`#` недопустим в идентификаторе RPC. Проект, рабочее дерево,
карточки и порядок очереди остаются прежними; фокус переносит `session.rebind`.
Копия с другим корнем загрузки становится только читающей.
Рантайм хранит SHA-256 строки свидетельства
с привязкой `sessionId/projectId/worktreeId` и временем. Сравнение —
`hmac.compare_digest`. Первый записавший побеждает: другой секрет для
той же привязки при регистрации даёт `ATTESTATION_CONFLICT`, тот же — идемпотентный успех.
Отпечатки нельзя менять или удалять через операции рантайма.
Конфликт сохраняется как `security.attestation-conflict` в журнале событий:
только идентификаторы привязки, requestId и время, без секрета и его хэша.
Повтор requestId не дублирует событие. Отказ
регистрации не сохраняется в кэше requests; сигнал остаётся после отката действия.

Отказы аттестации сохраняют envelope `{code,message}` и прежние коды.
Сообщение начинается с одной из диагностических меток:
`[attestation-unregistered]` — нет регистрации составной привязки,
`[attestation-mismatch]` — предъявленный ключ не совпал, действующий не изменён,
`[attestation-revoked]` — правильный ключ уже отозван,
`[attestation-expired]` — прошло семь суток с последнего успешного использования
либо свидетельству больше четырнадцати суток с регистрации. Предельный возраст не
продлевается использованием: без автоотзыва прежних эпох он ограничивает жизнь
утёкшего ключа, которым продолжают пользоваться.
Мод переносит только эту известную причину, а не произвольный текст ответа.
Неиспользуемое свидетельство действует **7 суток** с регистрации или последнего
успешного подписанного RPC, включая успешный повтор из кэша. Ровно на границе
оно отвергается до кэша с `ATTESTATION_FAILED` и `[attestation-expired]`;
ошибки, неправильный ключ и чтения без ключа срок не продлевают.
Повторная регистрация просроченной точной привязки не оживляет ключ: мод создаёт
независимую эпоху с новым ключом. Семь суток допускают паузу на выходные и
ограничивают жизнь забытых загрузок; активная сессия сохраняет доступ.
Истечение не добавляет отзыв и не изменяет неизменяемый отпечаток.
Контракт явного отзыва принят владельцем; воспроизведение прежнего автоотзыва —
[ячейка расследования](../../../.debug/cases/cockpit-live-attestation/CASE.md).

Перед агентской записью мод перечитывает несекретную отметку владения хоста.
Новый `loadId` лишает прежний контроллер права использовать свой кэш;
он отзывает собственный ключ, если тот ещё в его памяти, остаётся только
читающим и сообщает о текущей загрузке. После отказа
агентской записи `ready` сбрасывается, причина сохраняется. Агентский путь
не получает права самостоятельно вращать эпоху, повторять действие как CLI
или выдавать себя за владельца. Новая владеющая загрузка использует прежний
путь перепривязки и аттестации; вторая копия с другим корнем остаётся читающей.
После `[attestation-expired]` следующая попытка проходит переаттестацию мода;
сама отклонённая запись не повторяется автоматически и не меняет actor.

`provenance` равен `panel` при правильном свидетельстве и `actor: owner`,
`tool` при правильном свидетельстве и `actor: agent`, и `cli` без свидетельства.
Агенту доступны все чтения, `tasks.agent.create`, `tasks.agent.rank`, `task.agent.action`,
`checkpoint.add` (источник принудительно `agent`), а для совместимости —
`candidate.adopt`, `candidate.dismiss` с причиной `answered` или `duplicate`.
Прочие записи, включая `task.edit`, `task.confirm`, `task.reopen`,
`config.set`, `inbox.triage`, приоритет и удаление, дают `INVALID_REQUEST`
с названием запрещённой операции. Предъявленный неверный,
чужой или незарегистрированный секрет даёт явный `ATTESTATION_FAILED`,
без записи действия и без автоматического повторения как CLI. Неверный
формат даёт `INVALID_REQUEST`. Обычный терминальный CLI человека и вызов
агента одинаково имеют `cli`; отметка SourceKind `user` сама по себе
человека не удостоверяет. Происхождение видно в snapshot, CLI и моде
словами «панель» / «командная строка». У Inbox отдельно видны `provenance`
классификации и `triageProvenance` последнего действия разбора; у задачи —
`certaintyProvenance`. `focusStack` в snapshot показывает происхождение frames.
Проектный config.get/set возвращает происхождение настройки; человеческий
config set capture-mode сохраняет `cli` у глобальной настройки.

После горячей перезагрузки мод читает несекретную отметку владения и меняет эпоху. Повторный `session.rebind` с той же
составной привязкой, включая смену reason на start/resume/clear/compact,
не сбрасывает регистрацию; session.end также сохраняет отпечаток. Мод
при утрате ключа создаёт одну новую эпоху и регистрирует новое свидетельство.
Если оба пути отказали, владелец видит: «Задачи временно недоступны: панель не
смогла подтвердить себя рантайму. Перезапустите сессию.» Код конфликта остаётся
в журнале рантайма. Установленная и отладочная копии с разными корнями загрузки
не конкурируют: вторая читает snapshot и не регистрирует свидетельство.
При неподтверждённой регистрации каждая успешная перепривязка повторяет
регистрацию; неизвестный исход сохраняет прежний секрет и requestId.
Известный отказ без конфликта получает новый requestId с тем же секретом,
чтобы сохранённая ошибка не препятствовала регистрации после восстановления рантайма.
Новая регистрация возможна при реальной смене sessionId или канонического
проекта/рабочего дерева, после соответствующего session.rebind. Указание
другого cwd внутри того же канонического дерева новой привязкой не является.
Это консервативный путь восстановления: причина lifecycle-события сама
по себе не служит разрешением заменить первый отпечаток.

`session.attest` **не отзывает другие свидетельства**. Основа, меньшие и большие
эпохи независимы; номер эпохи служит модулю для выбора нового sessionId,
не предоставляет права отзывать соседей. Первая регистрация точной привязки
по-прежнему неизменяема; другой ключ для неё даёт `ATTESTATION_CONFLICT`.
`session.revoke` принимает пустые args, правильный `panelSecret` целевой
привязки и обязательный явный `actor: owner` от панели. Отзывается ровно
предъявленная `sessionId/projectId/worktreeId`; аргумента чужой цели нет.
Без ключа, с неверным или чужим ключом — `ATTESTATION_FAILED`, без изменения
действующей регистрации или отзывов. Агент с `actor: agent`/`tool` и
неявный actor получают `INVALID_REQUEST`. Успех возвращает `{revoked:true}`.
При завершении, замене привязки или обнаружении новой загрузки мод явно
отзывает только собственный прежний ключ. После потери ключа новая загрузка
ничего не отзывает и регистрирует независимое свидетельство.
`session.end` и `session.rebind` сами по себе не отзывают ключ: это делает мод
отдельным подписанным вызовом. Все ранее записанные `attestation_revocations`,
включая прежний автоотзыв, сохраняют силу. Отозванное свидетельство даёт `ATTESTATION_FAILED`
до чтения кэша и без записи действия; событие
`security.attestation-revoked-use` содержит только идентификаторы и время.
Повтор requestId не дублирует сигнал. `doctor.counts.attestation_revocations`
и человеческий doctor показывают число отзывов. Отпечатки не меняются и не удаляются.

Агент и мод работают под одним пользователем ОС. Права `0600` не скрывают
от агента файл: секрет остаётся в сессионном состоянии хоста, переноса в файл нет.
Полностью исключить подделку между такими процессами нельзя. Цель этой
проверки — сузить подделку через RPC и сделать конфликт обнаружимым;
она не удостоверяет личность человека. Процесс, опередивший мод при старте
сессии, может занять свидетельство. Попытка мода зарегистрировать свой
секрет обнаруживает это конфликтом и явным предупреждением о возможной подмене.
Чтение памяти, перехват stdin, подмена мода/рантайма и прямое редактирование
базы тем же пользователем остаются остаточным риском. Совещательный текстовый
запрет команд в моде остаётся дополнительным слоем; страж только наблюдает.

## Точные операции M1/M2

`?` означает необязательное поле. Других RPC-операций нет.

| op | args | result |
| --- | --- | --- |
| `capture.prompt` | `{text:string, deliveryId?:ID, kind?:string}` | `{inboxId:UUID, captured:true, captureMode:"full-local"\|"off"}` |
| `task.bind` | `{reason?:string, resourcePath?:absolute-path, staleRead?:boolean}` | `{bound:"existing"\|"created"\|"created-no-source", task:Task, focusRevision:integer}`; при observe также `gate` и `observation`, как у gate.check |
| `focus.get` | `{}` | `Focus` |
| `focus.set` | `{taskId:UUID, expectedRevision:integer}` | `Focus` |
| `task.update` | `{taskId:UUID, expectedRevision:integer, status?:Status, title?:string}` | `{task:Task}` |
| `task.get` | `{taskId:ID}` | `{task:Task,comments:OwnerComment[]}` — полная карточка и до 100 актуальных комментариев текущего worktree |
| `task.comment.add` | `{taskId:ID,text:string}` | `{taskId:ID,comment:OwnerComment}`; только аттестованная панель, явный `actor=owner` |
| `task.comment.edit` | `{taskId:ID,commentId:ID,expectedRevision:integer,text:string}` | `{taskId:ID,comment:OwnerComment}`; ревизия комментария |
| `task.comment.delete` | `{taskId:ID,commentId:ID,expectedRevision:integer}` | `{taskId:ID,commentId:ID,revision:integer,deleted:true}`; мягкое удаление |
| `task.create` | `{title:string, steps?:string[], description?:string, acceptance?:string[], constraints?:string[], assignee?:Assignee\|null, priority?:Priority}`; требуется `panelSecret` | `{task:Task, focus:Focus}` |
| `task.edit` | `{taskId:ID, expectedRevision:integer, title?:string, description?:string, acceptance?:string[], constraints?:string[], assignee?:Assignee\|null, priority?:Priority, pinned?:boolean}`; хотя бы одно изменяемое поле, требуется `panelSecret` | `{task:Task}` |
| `tasks.rank` | `{items:{taskId:ID, expectedRevision:integer, priority:Priority}[], source:"model"\|"jev"}`; требуется `panelSecret` | `{changed:{taskId:ID,priority:Priority}[], skipped:{taskId:ID,reason:"pinned"\|"stale"\|"terminal"\|"not-found"\|"candidate"}[]}` |
| `task.action` | `{taskId:ID, expectedRevision:integer, expectedFocusRevision:integer, action:"current"\|"done"\|"defer"\|"restore"\|"up"\|"down"\|"delete"\|"step", step?:integer}`; требуется `panelSecret` | `{task:Task, focus:Focus}` |
| `tasks.agent.create` | `{tasks:{title:string,description?:string,place?:"top"\|"bottom"}[]}`; 1..20, `panelSecret`, `actor:agent` | `{tasks:AgentTaskReference[]}` — ровно одна позиция на каждый вход |
| `tasks.agent.rank` | `{order:ID[]}`; 1..30 уникальных открытых задач очереди своего worktree, `panelSecret`, `actor:agent` | `{order:ID[],pinned:ID[]}` — полный порядок и закреплённые владельцем |
| `task.agent.action` | `{taskId:ID,expectedRevision:integer,expectedFocusRevision:integer,action:"current"\|"done"\|"defer"\|"note",note?:string}`; `panelSecret`, `actor:agent` | `{task:Task,focus:Focus,note:AgentTaskNote\|null}` |
| `task.reopen` | `{taskId:ID,expectedRevision:integer}`; `panelSecret`, `actor:owner` (по умолчанию) | `{task:Task,focus:Focus}` |
| `tasks.context` | `{cursor?:integer}`; без свидетельства, как snapshot | `TaskContext` |
| `tasks.extract` | `{inboxId:ID, tasks:{title:string,steps:string[],sourcePhrase?:string,description?:string,acceptance?:string[],constraints?:string[]}[]}`; требуется `panelSecret`, владелец | `{tasks:Task[], focus:Focus, dropped:integer, duplicates:{title:string,taskId:ID}[]}`; до трёх кандидатов |
| `candidate.adopt` | `{taskId:ID, expectedRevision:integer}`; требуется `panelSecret`, владелец или агент | `{task:Task}` |
| `candidate.dismiss` | `{taskIds:ID[], reason:"answered"\|"owner"\|"duplicate"}`; требуется `panelSecret`, до 20 ID без повторов | `{dismissed:ID[], skipped:ID[]}`; агенту только answered/duplicate |
| `inbox.material` | `{inboxId:ID}` | `{inboxId:ID, material:string\|null}` |
| `extraction.report` | `{inboxId:ID, code:ExtractionCode}` | `{recorded:true, code:ExtractionCode, extraction:ExtractionStats}` |
| `snapshot` | `{limits?:{tasks?:integer, inbox?:integer}}` | `Snapshot` |
| `inbox.get` | `{inboxId:UUID}` | `Inbox` |
| `session.rebind` | `{reason:"start"\|"resume"\|"clear"\|"compact"}` | `Snapshot` с лимитами по умолчанию |
| `session.attest` | `{}`; обязательный `panelSecret` в envelope | `{attested:true}` |
| `session.revoke` | `{}`; действующий `panelSecret` целевой привязки, явный `actor: owner` | `{revoked:true}` |
| `doctor` | `{}` | `Doctor` |
| `inbox.triage` | `{inboxId:ID, expectedRevision:integer, type?:InboxType\|null, taskId?:ID\|null, resourceId?:ID\|null, status?:TriageStatus}` | `InboxPreview` |
| `task.confirm` | `{taskId:ID, expectedRevision:integer}` | `{task:Task}` |
| `checkpoint.add` | `{taskId:ID, expectedRevision:integer, kind:CheckpointKind, text:string, source?:SourceKind}` | `{checkpoint:Checkpoint, taskRevision:integer}` |
| `checkpoint.list` | `{taskId:ID, expectedRevision?:integer, limit?:integer}` | `{taskId:ID, taskRevision:integer, checkpoints:Checkpoint[]}` |
| `focus.detour` | `{expectedRevision:integer, taskId?:ID, title?:string}` (ровно одно из taskId/title) | `Detour` |
| `focus.return` | `{expectedRevision:integer}` | `Return` |
| `gate.check` | `{resourcePath:absolute-path, staleRead?:boolean}` | прежние `bound`, `task`, `focusRevision`, а также `{gate:GateSummary, observation:GateObservation\|null}` |
| `gate.stats` | `{days?:integer}` | `GateSummary`, за всё время или последние N суток в текущем проекте |
| `gate.recent` | `{limit?:integer}` | `{mode:"off"\|"observe", observations:GateObservation[]}` текущего проекта |
| `config.get` | `{key:"gate"}` | `{key:"gate", value:"off"\|"observe", provenance:Provenance}` |
| `config.set` | `{key:"gate", value:"off"\|"observe"}` | `{key:"gate", value:"off"\|"observe", provenance:Provenance}` |
| `config.get` | `{key:"queue"}` | `{key:"queue", value:"run"\|"paused", provenance:Provenance}` |
| `config.set` | `{key:"queue", value:"run"\|"paused"}` | `{key:"queue", value:"run"\|"paused", provenance:Provenance}` |
| `session.end` | `{}` | `{released:integer}` — число снятых аренд текущей составной привязки |

`kind` у capture.prompt по умолчанию `prompt`, непустая строка до 100 code points;
`reason` для bind — до 1000 code points, может быть пустым, не сохраняется.
deliveryId — метаданные, не второй ключ дедупликации: новый requestId даёт
новый Inbox даже при одинаковом тексте или deliveryId. Без deliveryId
назначается UUID. `text` допускает пустую строку; размер ограничен envelope.

```text
Binding = {projectId:UUID, worktreeId:UUID, sessionId:ID, worktreePath:absolutePath}
Source = {inboxId:UUID, start:integer, end:integer, sha256:string}
Task = {
  taskId:UUID, projectId:UUID, worktreeId:UUID,
  alias:string, title:string, status:Status, revision:integer,
  stage:"candidate"|"task", adoptedBy:"owner"|"agent"|null,
  dismissReason:"answered"|"owner"|"expired"|"duplicate"|null, dismissedAt:timestamp|null,
  origin:"ad-hoc"|"no-source", createdAt:timestamp, updatedAt:timestamp,
  source:Source|null, certainty:Certainty, certaintySource:SourceKind, certaintyProvenance:Provenance,
  description:string, acceptance:string[], constraints:string[], assignee:Assignee|null,
  priority:Priority, prioritySource:PrioritySource, priorityPinned:boolean,
  queuePosition:integer|null, steps:TaskStep[], sourcePhrase:string|null,
  lastCheckpoint:Checkpoint|null, needsDecision:boolean,
  elapsedMs:integer, activeSince:timestamp|null, deleted:boolean
}
Focus = {task:Task|null, revision:integer}
TaskSummary = Omit<Task, "description"|"acceptance"|"constraints"> & {description?:string}
TaskStep = {position:integer, title:string, status:"pending"|"active"|"done"|"blocked"}
Assignee = "claude"|"codex"|"antigravity"|"human"
Priority = 0|1|2|3
PrioritySource = "user"|"model"|"jev"
QueueMode = "run"|"paused"
InboxClassification = {
  type:InboxType|null, classifiedBy:"rule"|"user"|"jev"|null,
  scope:{taskId:ID|null, resourceId:ID|null},
  policyVersion:string|null, confidence:number|null, mode:"shadow"|"active"|null,
  observedAt:timestamp|null, triageStatus:TriageStatus, triageRevision:integer,
  provenance:Provenance, triageProvenance:Provenance
}
InboxPreview = {
  inboxId:UUID, capturedAt:timestamp, length:integer, preview:string|null,
  ...InboxClassification
}
Snapshot = {
  binding:Binding, focus:Focus, inboxCounts:{total:integer, untriaged:integer},
  inboxTriageCounts:{untriaged:integer, blocking:integer},
  tasks:TaskSummary[], inbox:InboxPreview[], candidates:TaskSummary[], candidateCount:integer,
  captureMode:"full-local"|"redacted"|"off", schemaVersion:1, storageSchemaVersion:13,
  focusStack:{taskId:ID,depth:integer,provenance:Provenance}[],
  gate:GateSummary, queue:QueueMode, extraction:ExtractionStats
}
Inbox = {
  inboxId:UUID, binding:Binding, deliveryId:ID, kind:string,
  captureMode:"full-local"|"off", text:string|null, sha256:string,
  length:integer, status:"untriaged", capturedAt:timestamp, ...InboxClassification
}
Certainty = "observed"|"inferred"|"confirmed"|"verified"
SourceKind = "user"|"claude"|"agent"|"engine"|"tool"|"provider"
Provenance = "panel"|"cli"|"tool"
InboxType = "info"|"proposal"|"question"|"decision"|"approval"|"conflict"|"blocking"
TriageStatus = "untriaged"|"triaged"|"rejected"
CheckpointKind = "commit"|"tests-passed"|"note"|"detour"|"return"
Checkpoint = {
  checkpointId:UUID, taskId:ID, kind:CheckpointKind, text:string,
  source:SourceKind, createdAt:timestamp, provenance:Provenance
}
Detour = {focus:Focus, stackDepth:integer, checkpoint:Checkpoint}
ReturnPacket = {taskId:ID, title:string, checkpoints:Checkpoint[], inbox:InboxPreview[]}
Return = {focus:Focus, stackDepth:integer, checkpoint:Checkpoint, returnPacket:ReturnPacket}
Permission = {present:boolean, mode:string|null, ok:boolean}
Doctor = {
  integrityCheck:string[],
  foreignKeyCheck:{table:string,rowId:integer|null,parent:string,fkIndex:integer}[],
  schemaVersion:1, storageSchemaVersion:13,
  permissions:{directory:Permission,files:{"cockpit.db":Permission,
    "cockpit.db-wal":Permission,"cockpit.db-shm":Permission}},
  counts:{projects:integer,worktrees:integer,sessions:integer,inbox:integer,
    tasks:integer,task_sources:integer,focus:integer,events:integer,
    requests:integer,config:integer,inbox_observations:integer,
    checkpoints:integer,focus_stack:integer,project_config:integer,
    worktree_leases:integer,gate_observations:integer,session_attestations:integer,
    task_steps:integer,task_lists:integer,attestation_revocations:integer,attestation_usage:integer,
    task_agent_notes:integer,task_closures:integer,task_owner_comments:integer,
    "extraction.<ExtractionCode>":integer,"extraction.last-success-at":string},
  extraction:ExtractionStats
}
GateSummary = {
  mode:"off"|"observe", counts:{ALLOW:integer,BIND:integer,BLOCK:integer},
  blockReasons:{"foreign-lease":integer,"stale-read":integer,
    "blocking-inbox":integer,"pending-decision":integer}
}
GateObservation = {
  observationId:integer, outcome:"ALLOW"|"BIND"|"BLOCK", reasons:GateReason[],
  taskId:ID, resource:{resourceId:ID,path:string|null}, sessionId:ID, observedAt:timestamp
}
GateReason = "foreign-lease"|"stale-read"|"blocking-inbox"|"pending-decision"
ExtractionCode = "extracted"|"no-tasks"|"skipped-gate"|"no-attestation"|"model-timeout"|"model-unparsable"|"runtime-rejected"|"error"
ExtractionStats = {
  counts:Record<ExtractionCode,integer>, lastSuccessAt:timestamp|null,
  consecutiveFailures:integer, lastReason:ExtractionCode|null, ownerRequests:integer
}
```

Время — UTC ISO 8601 с микросекундами и `Z`; SHA-256 — 64 hex-символа.
Пути базы/проекта, remote URL и raw prompts не входят в Snapshot/Doctor,
кроме явно разрешённых preview в Snapshot. В events нет ни preview, ни
title, ни свободных args: только идентификаторы, фиксированный тип и время.

Лимиты Snapshot по умолчанию `tasks=10`, `inbox=10`, диапазон `0..100`,
bool не считается integer. Список задач, Inbox и его счётчики — текущего worktree.
Перед пределом задач идут текущая, очередь, остальные открытые, затем закрытые.
Очередь не включает ждущие решения и задачи стека отхода; она и остальные
открытые сортируются по `priority`, `queuePosition` и номеру alias по возрастанию.
Закрытые идут по времени закрытия убывая, при равенстве — по номеру alias убывая;
для done берётся `task_closures.closed_at`, при отсутствии записи и для cancelled — `updatedAt`.
Малый предел сохраняет начало этого же порядка. Inbox сначала содержит неразобранные,
затем разобранные записи; внутри групп rowid убывает, то есть сохраняется порядок
зафиксированных записей. Откат системных часов не подменяет последний source.
Inbox/get доступен любой сессии того же worktree, в том числе после clear.

Ревизия задачи начинается с `0`, ревизия отсутствующего фокуса — `0`,
первого назначенного фокуса — `1`. `focus.set.expectedRevision` относится
к Focus, **не** к Task. Успешный set увеличивает ревизию фокуса, в том числе
при повторном выборе той же задачи с новым ключом. task.update увеличивает
ревизию задачи, даже если передано прежнее значение. Требуется хотя бы одно
из status/title; заголовок — непустая строка до 300 code points.

Status: `active`, `paused`, `done`, `cancelled`. Из active/paused разрешены
все четыре; done/cancelled терминальны (переход в другой статус запрещён).
Заголовок терминальной задачи можно уточнить. При done/cancelled фокус этой
задачи очищается, его строка и возрастающая ревизия сохраняются. Так старая
ревизия не становится актуальной снова после очистки. Терминальную задачу
поставить в фокус нельзя. focus.set может явно выбрать задачу того же
проекта, созданную в другом worktree; автоматическое восстановление всегда
ограничено текущим worktree.

## Задачи ведёт основной агент

Основной агент сам записывает поручения, выбирает текущую работу, откладывает
и завершает её через инструмент мода. Владелец может создать и изменить задачу
через панель. Принимать или отклонять каждое новое поручение не требуется.
Малая модель больше не является источником обычных новых задач: рантайм
не вызывает модели, а старое выделение оставлено только как совместимый API.

`tasks.agent.create` принимает 1..20 элементов с непустым `title` до 300
code points, необязательным `description` до 4000 и `place: top|bottom`
(по умолчанию `bottom`). Другие поля запрещены.
Создаёт активную `stage=task`, `inferred/agent/tool`, без источника Inbox
(`origin=no-source`, `source=null`), без смены фокуса и без закрепления.
Новая задача встаёт внизу среди незакреплённых; `top` ставит её в первое
свободное место. Пачка `top` сохраняет входной порядок. При пустой очереди
приоритет 2/model; иначе используется приоритет занимаемого места.
`inferred` выражает вывод агента о необходимой работе и отличается от
`confirmed/user/panel` владельца; выполнение само по себе не подтверждает
его постановку от имени человека.

Нормализация для **новой** операции: casefold, удаление всех Unicode-знаков
пунктуации (категории P), свёртка пробелов. Сравниваются открытые задачи всего
проекта, включая отложенные и соседние worktree, без кандидатов, скрытых
и терминальных задач. Внутри пакета дубли тоже объединяются. Тексты агента
проходят существующее маскирование до записи в БД и сравнения; исходный текст
владельца существующая операция не переписывает. В описании агента сохраняются
переводы строк после маскирования всего текста и очистки каждой строки.
Совпавшая задача возвращается
со своим названием, alias и ревизией; описание дубля не заменяется.

`tasks.agent.rank` задаёт относительный порядок переданных задач; неуказанные
незакреплённые остаются ниже в прежнем взаимном порядке. Закреплённые владельцем
`priorityPinned` сохраняют места в общей очереди независимо от их места во входе.
Остальные занимают свободные координаты `(priority, queuePosition)` вокруг них,
в том числе между разными группами приоритета. Старые совпадающие координаты
нормализуются без изменения места якорей или их приоритета. Схема остаётся 12.
Текущая, отложенные, закрытые, отменённые, удалённые, кандидаты, чужие и неизвестные
taskId отклоняются целиком с `INVALID_REQUEST`; пустой список и повторы запрещены.
Изменённые координаты поднимают ревизию задачи, источник свободных мест —
`model/tool`; журнал получает `task.agent.ranked` и `tasks.agent.ranked` без текстов.
Повтор `requestId` возвращает прежний ответ без новых записей; другой вход с
тем же ключом даёт `IDEMPOTENCY_CONFLICT`. Отказ хранилища откатывает весь пакет.
Непосредственная перестановка владельца `up/down` закрепляет обе переставленные
задачи; `tasks.rank` с явным `actor: owner` закрепляет изменённые задачи и пишет
новость владельца. Старый вызов панели без actor сохраняет контракт model/jev.

```text
AgentTaskReference = {taskId:ID,alias:"TASK-N",title:string,revision:integer,duplicate:boolean}
```

Ответ содержит одну позицию на каждый вход, в том же порядке. Если уже есть
5000 открытых задач проекта (`MAX_PROJECT_OPEN_TASKS`), отказ
`TASK_LIMIT_REACHED` происходит даже для пакета дублей. Если новые
уникальные элементы превысят 5000, весь вызов
откатывается: ни частичных задач, ни событий. При 4999 открытых допустим один
новый элемент вместе с дублями в рамках лимита 20 элементов.
Невалидная форма/длина или `actor:owner` дают `INVALID_REQUEST`, отсутствие
свидетельства — `ATTESTATION_FAILED`; неверная привязка проверяется прежним механизмом.

`task.agent.action` всегда требует текущие ревизии задачи **и фокуса**.
`current` выбирает её текущей, возвращает прежнюю текущую в активную очередь
и останавливает её часы; отложенная выбранная задача становится активной.
`done` завершает работу, останавливает часы и снимает фокус только если задача
была текущей. Следующую задачу рантайм не выбирает. `defer` ставит paused и
также снимает собственный фокус. `note` меняет ревизию и время обновления,
сохраняя статус и фокус; доступна также для завершённой карточки.
`note` обязательна для действия note, непустая, до 1000 code points.
Для done необязательна короткая заметка о результате до 500 code points;
для current/defer поле note запрещено. Заметки не меняют title, description,
acceptance, constraints или checkpoints владельца и хранятся отдельно:

```text
AgentTaskNote = {
  noteId:ID,taskId:ID,kind:"note"|"result",text:string,createdAt:timestamp,
  source:"agent",provenance:"tool"
}
```

Статус, заметка, события и сохранённый ответ фиксируются одной транзакцией.
Запрещены delete, cancel, restore, перемещение, изменение полей поручения,
приоритета и его закрепления: `INVALID_REQUEST`. Устаревшая ревизия задачи
или фокуса — `REVISION_CONFLICT`; чужая/удалённая карточка — `NOT_FOUND`;
действие кроме note над терминальной задачей — `INVALID_REQUEST`.
Повтор requestId возвращает прежний ответ и не добавляет вторую заметку.

`task.reopen` принадлежит только аттестованному владельцу: выполненная (`done`)
задача снова активна в конце своей группы приоритета, без назначения фокуса.
История, заметки, выполненные шаги и закреплённый приоритет сохраняются.
Отменённая или уже открытая задача даёт `INVALID_REQUEST`; скрытая — `NOT_FOUND`.
Панель может использовать прежний `task.action(action=restore)` с обеими
ревизиями: для done он выполняет тот же возврат. Возврат paused остаётся
прежним действием. Агенту оба пути возврата завершённой задачи недоступны.

## Комментарии владельца

Операции `task.comment.add`, `task.comment.edit`, `task.comment.delete` принимают
обычный envelope `v=1`, `requestId`, `session:{sessionId,cwd}`, `args` и
действительное `panelSecret`, с явным `actor:"owner"`. CLI не может писать
комментарии (`ATTESTATION_FAILED`); аттестованный `actor:"agent"` и панель без
явного actor получают `INVALID_REQUEST`. Неверное или отозванное свидетельство
даёт `ATTESTATION_FAILED` до выдачи сохранённого ответа.

```text
OwnerComment = {
  commentId:ID,text:string,createdAt:timestamp,updatedAt:timestamp,revision:integer
}
```

Текст обязателен: от 1 до 4000 знаков Unicode, не только пробелы. Поля запросов
проверяются строго; `expectedRevision` — неотрицательное целое в диапазоне SQLite,
именно ревизия комментария. Новая запись имеет revision=0 и одинаковые createdAt
и updatedAt. Правка и удаление увеличивают её ревизию на единицу и меняют updatedAt;
createdAt и порядок сохраняются. Ревизия задачи и фокус от комментариев не меняются.
Комментировать, править и удалять комментарии можно у задач во всех статусах
`active`, `paused`, `done`, `cancelled`, включая кандидатов: комментарии не меняют стадию.

Чужая задача, рабочее дерево или проект, отсутствующий/удалённый комментарий,
комментарий другой задачи и удалённая задача дают `NOT_FOUND`; устаревшая ревизия —
`REVISION_CONFLICT`. Проверка допуска, запись, событие и ответ атомарны.
Повтор requestId не повторяет запись и возвращает её сохранённый ответ;
другие args под тем же requestId дают `IDEMPOTENCY_CONFLICT`.
Изменения фиксируются без текста в событиях `task.owner.commented`,
`task.owner.comment-edited`, `task.owner.comment-deleted`; entity_id — taskId,
поэтому `tasks.context.ownerChanges` выдаёт действия `commented`, `comment-edited`,
`comment-deleted` с идентификатором задачи и прежним курсорным протоколом.

Фильтр секретов и управляющих символов применяется до сохранения новых текстов
и при каждой выдаче, включая старый кэш. Мягкое удаление сохраняет строку с
deleted=1 в локальной БД; история редакций отдельно не ведётся. `task.get.comments`
и `tasks.context.current.ownerComments` содержат только неудалённые комментарии:
до 100 последних по `(created_at,rowid)`, в ответе по возрастанию, без истории и признака удаления.
У удалённой задачи comments пусты.

Для совместимости в сводке оставлено `ownerNotes`, но перенесённые контрольные
точки из него исключаются независимо от дальнейшей правки или удаления копии.
Та же отметка исключается из `checkpoint.list`, `lastCheckpoint`, фокуса,
snapshot и пакета возврата. Это сохраняет неизменяемый оригинал в БД и не
возвращает агенту прежний текст через другой путь чтения. `ownerNotes` содержит
только прежние заметки, которые не перенесены в комментарии, включая добавленные
через совместимый `checkpoint.add` после миграции. Для нового редактируемого
дополнения панель использует `task.comment.add`.

Сохранённые ответы чтения остаются побайтно прежними в requests, но перед
выдачей из них удаляются перенесённые отметки; comments и ownerComments заново
выбираются из текущей БД. Повтор старого чтения не раскрывает прежнюю редакцию
или удалённый комментарий. Остальные поля сохранённого ответа и его курсор
не обновляются: для новых ownerChanges нужен новый requestId с текущим cursor.
Большая история `tasks.context`, включая сохранённые ответы, ограничивается
при выдаче: свежий хвост и добавочные счётчики пропущенных записей. Сам JSON
сохранённого ответа в БД не переписывается. TypeScript-парсер принимает схему 11, проверяет форму комментариев, предел,
уникальность идентификаторов, порядок дат и маскирует тексты повторно.
Отсутствие comments/ownerComments в ответе старого рантайма поддерживается
для совместимости; рантайм схемы 11 выдаёт эти массивы всегда.

## Сводка для контекста

`tasks.context` читает состояние текущего worktree; не требует panelSecret,
не меняет фокус, задачи, кандидатов или часы. Успешное чтение
сохраняет только служебную привязку сессии и ответ идемпотентности.
Snapshot не получил новых полей, его candidates/candidateCount сохранены.

```text
TaskContextEntry = {taskId:ID,alias:"TASK-N",title:string,priorityPinned?:boolean}
TaskContext = {
  binding:Binding,
  current:(TaskContextEntry & {
    revision:integer,description:string,acceptance:string[],constraints:string[],
    ownerNotes:Checkpoint[],ownerNotesOmitted:integer,
    ownerComments:OwnerComment[],agentNotes:AgentTaskNote[],agentNotesOmitted:integer
  })|null,
  queue:(TaskContextEntry & {description:string})[],
  deferred:TaskContextEntry[],closed:TaskContextEntry[],
  counts:{total:integer,open:integer,active:integer,queued:integer,deferred:integer,
    done:integer,cancelled:integer,closedLast24h:integer,projectOpen:integer},
  ownerChanges:{eventId:integer,taskId:ID,action:OwnerTaskChangeAction,createdAt:timestamp}[],
  ownerChangesOmitted:integer,cursor:integer
}
OwnerTaskChangeAction = "created"|"edited"|"reordered"|"deferred"|"deleted"|
  "reopened"|"noted"|"completed"|"current"|"restored"|"step"|
  "commented"|"comment-edited"|"comment-deleted"
```

`current` содержит полное описание, списки владельца, актуальные ownerComments,
неперенесённые checkpoints с kind=note/source=user и отдельные заметки агента.
Каждый из массивов `ownerNotes`, `agentNotes`, `ownerChanges` содержит последние
100 записей и не больше 128 КиБ JSON в UTF-8, в прежнем хронологическом порядке.
`ownerNotesOmitted`/`agentNotesOmitted` внутри current и корневой
`ownerChangesOmitted` сообщают число остальных записей (0, если поместились все).
Выборка заметок и изменений ограничена ещё в SQL; полный ответ с envelope и
переводом строки ограничен `SNAPSHOT_RESPONSE_BYTES` (3 МиБ), при необходимости
убираются старые записи этих массивов с увеличением соответствующих счётчиков.
Те же ограничения применяются к историческому ответу после освежения комментариев
и фильтрации текста, не меняя хранимый JSON. Прежний парсер мода принимает
добавочные счётчики и сохраняет прежнюю форму контекста. Очередь —
до 30 активных задач без текущей, в прежнем порядке `(priority,queuePosition,alias_no)`;
description здесь означает первую строку описания. Отложенные — до 10 в том
же порядке, выполненные за последние 24 часа — до 10 последними закрытыми
вперёд. Более поздняя правка описания выполненной задачи не меняет её время
завершения. Скрытые, кандидаты и старые служебные заглушки в списки и локальные
числа не входят. Числа полные, независимо от лимитов списков;
active включает текущую, open=active+deferred. projectOpen считает все открытые
stage=task проекта (включая служебные записи) по тому же правилу, что лимит создания.

Без cursor возвращается текущее состояние и новая отметка, ownerChanges пуст.
При следующем чтении передайте cursor прошлого ответа: получите последние действия
аттестованного владельца после него, по eventId, включая удалённые карточки;
число пропущенных действий находится в `ownerChangesOmitted`. События в БД
не удаляются этим ограничением.
created — завёл, edited — изменил поручение/дописал описание, reordered —
изменил порядок (запись для каждой поменявшей позицию карточки), deferred —
отложил, deleted — скрыл, reopened — вернул выполненную, noted — добавил
отметку владельца, completed/current/restored/step — остальные действия панели.
Изменения агента не входят в ownerChanges. События `task.owner.*` не содержат
текстов. Курсор — неотрицательный идентификатор последнего события текущего
worktree (0 при пустом журнале), включая события агента. Чужая, отсутствующая,
будущая отметка или неправильный тип дают `INVALID_REQUEST`; отметка привязана
к worktree и сохраняется при смене сессии. История до миграции не переименовывается
и не выдаётся за новые действия владельца. Для свежести используйте новый requestId:
повтор ключа сводки намеренно возвращает прежнее состояние и прежний cursor.
Все тексты, в том числе первая строка описания и заметки исторического ответа,
проходят прежние shown/plain/redact; исходный фильтр и его шаблоны не менялись.

## Кандидаты: совместимость

Задача — поручение, которое переживает текущий ход. `tasks.extract` создаёт
`stage=candidate`, `inferred/provider/panel`, с исходной фразой и шагами pending.
Берутся первые три карточки входного списка, остальные входят в `dropped`.
Нормализация названия объединяет регистр, пробелы и конечную пунктуацию.
Совпадение с незавершённой задачей или действующим кандидатом всего проекта
не создаёт строку и возвращается в `duplicates`. Проверка и создание атомарны.
Описание, acceptance и constraints имеют те же пределы, что task.create.

Кандидат имеет `queuePosition=null` (в БД служебное 0), без часов и фокуса.
Он исключён из snapshot.tasks, очереди, up/down и стража; tasks.rank пропускает
его с reason=candidate. Редактирование, завершение, откладывание, подтверждение,
контрольные точки и выбор кандидата в фокус запрещены. Доступны только принятие
и отклонение; отдельный task.get сохраняет возможность прочитать исходник.

`candidate.adopt` проверяет ревизию и стадию, ставит `stage=task`, `adoptedBy`
по actor и позицию в конце группы приоритета текущего дерева, без смены фокуса.
Владелец получает confirmed/user/panel; агент сохраняет inferred/provider.
`candidate.dismiss` атомарно обрабатывает до 20 уникальных ID текущего дерева;
принятые и ранее отклонённые входят в skipped. Неизвестная или чужая ссылка
откатывает всю пачку. Причина и время сохраняются вместе с исходником и связями.

Возраст не меньше 24 часов исключает кандидата из выдачи. Следующая успешная
запись в этом проекте лениво ставит expired и увеличивает ревизию; чтения и
повторы сохранённого ответа этого не делают. Таймеров и демона нет.
Snapshot содержит `candidates` — до пяти новых первыми, и `candidateCount`
в текущем дереве; у кандидата в summary есть первая строка безопасного описания.
Обычный CLI tasks показывает задачи, `tasks --candidates` — предложения из этой
проекции (до пяти, с учётом --limit). Раздел панели «ПРЕДЛОЖЕНО N» с кнопками
«Принять» и «Отклонить» относится к прежнему интерфейсу; в новом потоке
постановкой занимается основной агент. tasks.extract/candidate.adopt/candidate.dismiss
сохранены с прежним поведением: новый явный вызов выделения после миграции
может создать совместимого кандидата. Отключение вызовов и показов выполняет мод.
Исторические ответы RPC, включая
прежние результаты выделения, возвращаются в сохранённой форме.

## Поручение, приоритет и очередь

`task.create` и `task.edit` принимают описание до **4000 code points**,
критерии приёмки `acceptance` и ограничения `constraints` — упорядоченные
списки до **10 строк**, каждая до **300 code points**. Строки сохраняются
дословно, включая Unicode и управляющие знаки; пустая строка описания и
пустой список очищают соответствующее поле. Пустые строки внутри списка
допустимы. Заголовок остаётся непустым, не только пробельным, до 300 code points.
`assignee` равен `claude`, `codex`, `antigravity`, `human` или NULL; явный
NULL снимает назначение. `priority` — целое `0..3`, bool не допускается:
0 — срочно, 1 — высокий, 2 — обычный, 3 — когда-нибудь.

Без явного приоритета создание получает 2/`model`/`priorityPinned=false`.
Явный приоритет панели ставит `prioritySource=user` и закрепляет значение.
`task.edit` требует свидетельство зарегистрированной панели, ревизию задачи
и хотя бы одно из title/description/acceptance/constraints/assignee/priority/pinned.
Успех увеличивает ревизию задачи на один, даже при прежнем значении; фокус,
шаги, источник, уверенность и часы не меняются. Неуказанные поля сохраняются.
Редактирование относится только к текущему worktree; скрытая карточка даёт
`NOT_FOUND`, терминальная допускает уточнение полей без открытия статуса.
Ответ — полная карточка. `pinned:true` закрепляет текущий приоритет и ставит
источник `user`; `pinned:false` снимает закрепление с источником `user`.
Если одновременно переданы priority и pinned, явный pinned применяется
после приоритета: priority с pinned:false оставляет приоритет незакреплённым.
Происхождение изменения приоритета хранится в `priority_provenance`.

`tasks.rank` принимает **0..50** элементов без повторов taskId и источник
`model` или `jev`. Вся пачка, события и идемпотентный ответ фиксируются
атомарно. Операция относится ко всем задачам текущего проекта, включая соседние
worktree. Для каждой ссылки проверяются последовательно: отсутствие/другой
проект/скрытая карточка → `not-found`, done/cancelled → `terminal`, закрепление
→ `pinned`, несовпадение ревизии → `stale`. Эти элементы пропускаются без
отказа всей пачки. У остальных меняются приоритет, источник и происхождение,
ревизия увеличивается на один; они входят в changed даже при прежнем значении
приоритета. Порядок changed и skipped внутри каждого списка соответствует
порядку входных элементов. Статусы, фокус, шаги и часы не меняются. После
снятия закрепления модель или Jev может снова изменить приоритет. Сам рантайм
не вызывает модель и не запускает Jev.

Порядок всех выборок очереди — `(priority, queuePosition, alias_no)` по
возрастанию. `up`/`down` обменивают позиции только внутри одного приоритета,
сохраняя прежнее исключение фокуса, frames отхода, ожиданий решения и неактивных
карточек. На границе группы или вне очереди возвращается `INVALID_REQUEST`
с сообщением о группе приоритета; успешного действия с нулевым перемещением нет.

Проектная настройка `queue` по умолчанию `run`, второе значение — `paused`.
Она доступна через config.get/set и `cockpitctl config get|set queue`.
Snapshot содержит её независимо от лимитов. Происхождение очереди и стража
независимо: CLI может менять не заданную панелью настройку очереди, даже
когда gate поставлен панелью, и наоборот. Для перезаписи настройки именно
очереди с происхождением `panel` требуется правильное свидетельство.
В этом этапе настройка хранит намерение владельца: фонового исполнителя и
автоматического запуска/остановки работ нет; явные операции остаются доступны.

Task и полные карточки task.get/ответов операций содержат description,
acceptance, constraints, assignee, priority, prioritySource, priorityPinned.
В `snapshot.tasks` подробных текстов description/acceptance/constraints нет;
полная задача `snapshot.focus.task` их сохраняет. Все показы новых текстов,
включая повтор сохранённого ответа, проходят `shown`/`plain`: секретоподобные
значения маскируются до обрезки, метки pasted_content и управляющие знаки
удаляются из проекций. В events по-прежнему только идентификаторы, фиксированные
типы и время. Кэш прежних журналируемых запросов возвращается в прежней форме без добавления
полей версии 8; строки requests не переписываются. Парсер мода принимает
необязательные новые поля и версии хранилища 5/6/7/8, сохраняя отсутствие полей
в исторических ответах. Парсер также принимает схемы 9/10, новые операции
агента и форму tasks.context; новых обязательных полей Snapshot не добавлено.

## BIND и идентичность

Мод вызывает `gate.check` перед изменением файла при наблюдении. Сам runtime
не перехватывает инструменты и ничего не блокирует. `task.bind`/`gate.check`
при текущей задаче возвращают existing. Без задачи возвращаются
`bound:unbound`, `task:null` и прежняя ревизия фокуса: реплика не превращается
в задачу. Старые `observed`/`engine`/`cli` записи без шагов и подтверждения
считаются служебными и исключаются из snapshot/фокуса, включая выдачу старого
кэша RPC. Сами данные и кэш не переписываются. `task.confirm` ставит `confirmed`/`user`
и увеличивает ревизию задачи; её статус и исходник остаются прежними.
`tasks.extract` создаёт кандидатов `inferred`/`provider`/`panel` из результата
малой модели с неизменяемой связью с оригиналом. Прежнее поле `source` — ссылка на исходное указание;
`certaintySource` — кто поставил текущую отметку уверенности.

UUID проекта связан с realpath Git common dir; вне Git — с realpath каталога.
UUID worktree связан с realpath checkout root. Подкаталоги и симлинки одного
Git checkout имеют те же IDs; совпадающие названия каталогов не объединяют
проекты. Remote URL не запрашивается и не сохраняется. TASK-n выдаётся
последовательно в пределах проекта под write lock.

focus хранится по worktree. session.rebind присоединяет его к новому
sessionId, увеличивает ревизию при смене сессии и пишет session.<reason>.
Сессии имеют составную привязку sessionId/projectId/worktreeId: переход
разговора в другой checkout не переписывает происхождение старых указаний.
Подмена Git common dir у уже зарегистрированного checkout отвергается.

## Классификация и разбор Inbox

`inbox.status` по-прежнему равен `untriaged`; UPDATE/DELETE исходных строк
запрещены прежними триггерами. Каждая классификация — отдельная неизменяемая
строка `inbox_observations`, связанная с Inbox и проектом. Наблюдение содержит
вид (NULL означает «не определён»), task/resource scope, `classified_by`,
`policy_version`, confidence (NULL либо число `0..1`), mode и время.
`jev` разрешён схемой для будущего адаптера; текущий рантайм его не пишет.
Ресурс пока обозначается идентификатором без отдельного реестра или чтения
файлов; ссылка на задачу проверяется в текущем проекте.

При `capture.prompt` после оригинала, в той же транзакции, записывается
`rule`/`rule-1`, `mode=active`, `confidence=null`. Единственное правило:
`text.endswith("?")` → `question`, иначе `info`. Пробелы/CRLF не обрезаются,
пустой текст даёт info; никаких иных эвристик нет. Scope — активная задача
в фокусе на момент захвата либо пустой. Захват сам не создаёт задачи, а
последующий bind не переопределяет сохранённый scope.

Необязательная классификация защищена отдельным savepoint. SQL-ошибка или
исключение её Python-кода откатывают только новое наблюдение; оригинал,
capture-событие и идемпотентный ответ фиксируются. У такого пункта type,
classifiedBy, policyVersion, confidence, mode и observedAt равны null,
scope пустой, triageStatus=untriaged, triageRevision=0. Общий сбой базы всё
ещё возвращает DB_UNAVAILABLE и не выдаётся за успешный захват.

Действующее наблюдение — последнее авторизованное `panel`, иначе последнее
`user` через CLI, иначе последнее наблюдение остальных источников. Более
поздняя запись CLI не вытесняет решение панели. Авторизованная запись должна
принадлежать той же сессии и рабочему дереву, что исходное указание; свидетельство
должно быть зарегистрировано раньше первого захваченного указания этой привязки.
«Последнее» определяется observation_id. Статус и происхождение разбора берутся
из той же действующей строки. Shadow не входит в счётчик блокирующих;
классификатор не может задать triage_status — схема разрешает его только у user.

`inbox.triage` требует хотя бы одно из type/taskId/resourceId/status.
Неуказанные вид и scope сохраняются из текущей проекции; статус наследуется
только при совпадении происхождения, иначе становится `untriaged`. Поэтому
частичная запись панели не превращает CLI-разбор в решение человека.
Явный null очищает
type или соответствующую ссылку. Операция добавляет наблюдение
`user`/`user-1`, `active`, confidence=null; не меняет оригинал или фокус.
`status=triaged` означает «разобран», rejected — «отклонён»; untriaged
снова оставляет пункт неразобранным. Ответ — фильтрованный InboxPreview именно
новой строки с происхождением текущего запроса; snapshot показывает действующее наблюдение.
дословный текст читается только отдельным прежним `inbox.get`/`show`.

`triageRevision` равна числу наблюдений этого пункта (0 для старого или
оставшегося без классификации). Любая новая запись, включая shadow,
увеличивает её; устаревший expectedRevision даёт REVISION_CONFLICT без
нового наблюдения. `inboxCounts.untriaged` теперь считает производный статус,
форма старого объекта сохранена. `inboxTriageCounts` считает неразобранные
и активные блокирующие неразобранные пункты текущего worktree, независимо
от лимита показанного списка. Наличие счётчика не включает страж мутаций.

## Страж мутаций: только наблюдение

Флаг `gate` относится к проекту (общий Git common dir), по умолчанию `off`.
`cockpitctl config get|set gate off|observe` использует проект из `--cwd`.
Другого режима нет; недопустимое значение отвергается. Настройку, записанную
панелью, нельзя перезаписать через CLI без правильного свидетельства.
Прежняя глобальная
настройка capture-mode остаётся независимой.

`gate.check` и `task.bind` используют одну функцию `bind_with_gate`: bind, проверку и обновление аренды, вычисление
исхода и запись наблюдения вместе с идемпотентным ответом в одной транзакции
`BEGIN IMMEDIATE`. При `off` возвращает прежние поля bind, сводку с mode=off
и observation=null, без новой аренды или наблюдения. `task.bind` при off
сохраняет прежний набор полей; при observe проверяет аренду, происхождение
разбора и пишет наблюдение с событием `gate.observed`. Если resourcePath
не задан, наблюдение относится к корню рабочего дерева, а проверка консервативно
учитывает все подходящие блокирующие resource-scope пункты этого дерева.
Пропуск пути поэтому не скрывает блокирующий ресурс; явный путь сужает проверку.

При observe BLOCK имеет приоритет над BIND/ALLOW. Без причин первая проверка
с задачей в этом рабочем дереве даёт BIND, последующие — ALLOW. Работа без
задачи даёт ALLOW либо BLOCK; её наблюдения сохраняются в существующем
журнале событий `gate.unbound` и входят в stats/recent. Привязка всё
равно выполняется и при BLOCK; статус задачи и её уверенность автоматически
не меняются. Это запись «остановил бы», без отказа, вопроса или инструмента модели.

Закрытый список причин:

- `foreign-lease`: другая сессия владеет неистёкшей арендой данного worktree.
  Первая мутация получает аренду на **900 секунд (15 минут)**; следующая
  мутация владельца продлевает её, сохраняя acquired_at. Чужая сессия её не
  продлевает и не перехватывает. На границе expires_at аренда истекла;
  следующая мутация получает её заново. `session.end` удаляет аренду
  текущего sessionId/projectId/worktreeId, соседние деревья сохраняет. Сбой доставки конца сессии
  компенсируется сроком простоя; фонового таймера или демона нет.
- `stale-read`: мод передал staleRead=true по своей карте успешных Read.
  Рантайм не читает содержимое файлов, отпечатки в БД или RPC не передаются.
  Если Read не было или состояние файла неизвестно, этой причины нет.
- `blocking-inbox`: действующий `mode=active`, `type=blocking`,
  нет разбора triaged/rejected с `triageProvenance=panel`, scope.taskId совпадает с фокусом **или**
  scope.resourceId совпадает с ресурсом операции.
- `pending-decision`: действующий active-пункт decision/approval,
  без разбора triaged/rejected с `triageProvenance=panel` и связанный с задачей в фокусе. Одна привязка к ресурсу
  без задачи для решения недостаточна.

Пункты чужих задач (даже с совпавшим ресурсом), непривязанные, shadow,
triaged/rejected через авторизованную панель и прочие виды не влияют на исход.
Авторизация требует автора исходной сессии и дерева и регистрации до первого
захваченного указания этой привязки. Разбор через CLI может менять показ
и счётчики, пока нет действующего решения панели, но причину стража не снимает.
Смена вида или очистка области через CLI также не снимает прежнюю причину:
страж учитывает активные наблюдения до их замены последним разбором панели.
После него новые строки CLI этого пункта сохраняются в журнале, но не
заменяют решение панели и не наследуют её статус. Новые пункты Inbox
оцениваются независимо. Классификация правилом не заменяет разбор панели.
Чистота Inbox,
деструктивность, прод и секреты не оцениваются.

Ресурс нормализуется realpath без чтения файла. resourceId —
`path-` + SHA-256 канонического абсолютного пути в UTF-8; его можно использовать
как `triage --resource`. В журнал сохраняется относительный путь, если ресурс
лежит внутри канонического корня worktree; вне дерева — только resourceId,
resource_path=NULL. Показ пути, включая идемпотентный повтор, проходит через
shown/plain; содержимого файлов в журнале нет. UPDATE/DELETE наблюдений
запрещены триггерами, причины проверяются на закрытый список и отсутствие повторов.

`gate stats [--days N]`: исходы всех worktree текущего проекта; без days —
всё время, N — целое 1..36500 суток. Разбивка BLOCK считает каждую причину
один раз на наблюдение: сумма причин может превышать число BLOCK.
`gate recent [--limit N]`: последние записи проекта по observation_id,
по умолчанию 10, N — целое 0..100. Snapshot и ответ gate.check содержат
сводку текущего sessionId во всех worktree проекта, без отдельного RPC для счётчика мода.

## Контрольные точки и явный отход/возврат

Контрольная точка хранит вид, короткий текст (непустой, не только пробелы,
до 1000 code points), время и SourceKind. Текст сохраняется дословно, все
выводы проходят через `shown(text,1000)`. Заголовки Task/TaskSummary/пакета
также проходят shown; task.update сохраняет переданный title дословно и
не подменяет его фильтрованным представлением при изменении одного status.
В events попадают только идентификаторы и фиксированные типы, без текстов.

`checkpoint.add` проверяет ревизию задачи, добавляет неизменяемую строку и
увеличивает ревизию/updatedAt задачи. Источник по умолчанию user; вызывающий
инструмент может явно указать tool/engine/agent/claude/provider. Это запись
сообщённого события, без запуска тестов, чтения коммита или подтверждения
результата. `checkpoint.list` читает последние записи по rowid убывая;
limit по умолчанию 10, диапазон `0..100`, bool отвергается. Чтение не меняет
ревизию задачи. Терминальной задаче можно добавить отметку или подтверждение,
но эти операции не открывают её заново.

`focus.detour` — только явное действие пользователя с CAS ревизии фокуса.
Текущая задача обязательна. Она кладётся в устойчивый стек текущего worktree
глубиной до 8; задача назначения становится фокусом. Назначение — другая
незавершённая задача текущего проекта либо новая задача с заданным title
до 300 code points. Новая задача no-source, active, confirmed/user: название
задал человек. Выбор существующей задачи не меняет её уверенность. Уходящая
задача получает checkpoint detour от user, её ревизия увеличивается;
статусы задач автоматически не меняются. При пределе глубины INVALID_REQUEST
не оставляет ни задачи, ни frame, ни checkpoint.

`focus.return` проверяет ту же ревизию фокуса, снимает верхнюю задачу со стека
и возвращает её в фокус. Вернувшаяся задача получает checkpoint return от
user и новую ревизию. Пакет строится детерминированно: её название, до 5
последних контрольных точек (включая только что записанную) и до 5 последних
неразобранных пунктов текущего worktree с действующей привязкой к ней.
Тексты и предпросмотры фильтруются shown; модель не вызывается.

Пустой стек, завершённая/отменённая задача на его вершине дают INVALID_REQUEST,
стек и фокус при отказе сохраняются; терминальные frames автоматически
не пропускаются. Возврат допустим и после завершения задачи отхода, когда
её фокус уже очищен: нужен актуальный expectedRevision. Стек переживает
смену сессии, но не переносится в другой worktree. Оба действия фиксируются
вместе с focus, checkpoints, событиями и ответом requestId в BEGIN IMMEDIATE.
Идемпотентный повтор не добавляет frame/отметку и не снимает вторую задачу.

## Приватность и граница этапа

В базе есть config с capture_mode; по умолчанию `full-local`. Включение
`off` касается **новых captures**, а не удаления ранее сохранённых оригиналов
или ответов идемпотентности. Каждая запись имеет собственный captureMode;
get/preview full-local читают её неизменяемый текст, off всегда дают null.
off сохраняет только длину, SHA-256 и метаданные; текст не попадает даже в
requests, так как там только hash запроса и безопасный ответ capture.
`redacted` не поддерживается: set и capture в такой конфигурации возвращают
NOT_IMPLEMENTED. Никакой подделки редактирования/восстановления исходника.

От проектной спецификации реализованы M1 и описанные выше операции M2;
нет receipts, форм решений, actions, dependencies,
acceptance gates, шестиисходного triage, native task mirror, watcher,
демона. Нет Jev, автоматического сбора checkpoints из
Git/тестов или автоматической смены фокуса. Завершение done — учёт статуса, без проверки
результата. Настройка глобальных hooks/installers не меняется.

## Диагностика выделения

`inbox.material` маскирует весь оригинал до обрезки: до 6000 знаков, а у
более длинного — по 3000 с начала и конца плюс пометка пропуска.
Служебные теги pasted_content удаляются из материала и показов; inbox.get
по-прежнему отдаёт исходник дословно.

`extraction.report` принимает только inboxId текущей сессии и код из
`extracted`, `no-tasks`, `skipped-gate`, `no-attestation`, `model-timeout`,
`model-unparsable`, `runtime-rejected`, `error`. Повтор для того же Inbox не
увеличивает счётчик. Успешная `tasks.extract` записывает исход атомарно.
В событиях нет реплик. `doctor` возвращает extraction со счётчиками, последним
успехом и длиной последовательности сбоев; человеческий CLI печатает
`extraction.<код>` и `extraction.last-success-at` через прежний вывод counts.
Snapshot содержит статистику текущей runtime session для подвала панели.

## Проверки

```sh
python3 agents/claude/cockpit/tests/store.test.py
python3 agents/claude/cockpit/tests/rpc.test.py
time python3 agents/claude/cockpit/tests/cost.test.py
python3 agents/claude/cockpit/tests/migration.test.py
python3 agents/claude/cockpit/tests/m2.test.py
python3 agents/claude/cockpit/tests/cli.test.py
python3 agents/claude/cockpit/tests/gate.test.py
python3 agents/claude/cockpit/tests/attestation.test.py
python3 agents/claude/cockpit/tests/extraction.test.py
python3 agents/claude/cockpit/tests/tasks-panel.test.py
python3 agents/claude/cockpit/tests/priority.test.py
python3 agents/claude/cockpit/tests/agent-create.test.py
python3 agents/claude/cockpit/tests/agent-actions.test.py
python3 agents/claude/cockpit/tests/context.test.py
python3 agents/claude/cockpit/tests/migration10.test.py
python3 agents/claude/cockpit/tests/owner-comments.test.py
python3 agents/claude/plugins/cockpit/tests/contract.test.py
claude plugin test agents/claude/plugins/cockpit
python3 -m py_compile tools/cockpitctl.py agents/claude/cockpit/*.py agents/claude/cockpit/tests/*.py
./agentctl validate
```

Все тесты исполняются без Claude, с одноразовым COCKPIT_STATE_DIR, удаляют
свои данные и возвращают ненулевой exit при провале. cost.test.py проверяет
не только скорость, но и десять durable строк в inbox/requests/events.
attestation.test.py проходит полный цикл регистрации, подтверждения,
разбора, отметки, отхода, возврата и настройки: проверяет stdout/stderr,
все таблицы и файлы БД, а в requests — отсутствие видов и отпечаток каждого
журналируемого RPC без секрета с сохранённым ответом без секрета или его SHA-256. Отсутствие свидетельства
в проекции мода, тостах и текстах команд проверяют тесты плагина;
настоящая перезагрузка и отображение панели требуют живой сессии Claude.
