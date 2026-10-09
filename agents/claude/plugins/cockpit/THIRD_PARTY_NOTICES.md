# Использованный сторонний код

## Human in the loop

Источник: `tzafrir/human-in-the-loop`, ревизия
`9b38b2119fcf55de3294d826589f63f46a40d8bf`, исходник образца.

Перенесённые файлы:

- `hooks/register.tsx` → `hooks/owner/engine.tsx`: регистрация инструментов,
  доставка ответов, контекст, серверные действия, длинный ответ и удержание секрета;
  встроено в существующую панель через `hooks/register.tsx`.
- `hooks/tasks.ts` → `hooks/owner/tasks.ts`: разбор аргументов, дубли,
  сообщения, сводки, контекст и проверка похожести на секрет.
- `hooks/project.ts` → `hooks/owner/project.ts`: слоты сессий, пульс и принятие задач.
- `hooks/text.ts` → `hooks/owner/text.ts`: безопасный текст, возраст, размер и формы числа.
- `types/index.d.ts` → типы `OwnerTask` и `OwnerEditing` и новые поля `PluginState`
  в `types/index.d.ts`.
- `tests/register.test.tsx.txt` → `tests/owner-tasks.test.tsx`: сценарии инструментов,
  ответов и переходов между сессиями, адаптированные к русскому интерфейсу и общей панели.

Правила из `docs/DESIGN.md` сохранены в механике и описаны в разделе README
«Задачи владельцу». Справочная копия образца не изменялась.

MIT License

Copyright (c) 2026 Tzafrir Rehan

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## FileTree

Ревизия: оригинальный мод agent-config, см. UPSTREAM.md.

hooks/rows.tsx:1–142 → hooks/rows.tsx (полоса AbovePrompt); hooks/icons.ts:1–131 → hooks/icons.ts (только тип узла заменён). hooks/rows.tsx: shimmer, тона и захват ползунка → hooks/task-cards.tsx; hooks/register.tsx:1779–1903 → hooks/register.tsx (шапка, Client, подвал). Палитра разрешается существующим hooks/theme.ts.

MIT License

Copyright (c) 2026 Kurt Buhler

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## todo-bar

Ревизия: 8fb6f67cad9fd023cc7c06b7923518b4bbc45aea.

hooks/board.ts:113–118 → hooks/tasks.ts:53–58, formatDuration. hooks/register.tsx:176–249 → hooks/tasks.ts:143–160, состав строки над вводом (адаптация).

MIT License

Copyright (c) 2026 hoobnn

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## linear-tickets

Ревизия: 6e0fc0ff046f00f2df396f71cc0d9313bed5307f.

hooks/linear-api.ts:286–297 → hooks/tasks.ts: stacked. hooks/linear-tickets.tsx:250–300 → заголовки групп со счётчиком и строка +N ещё (приём).

MIT License

Copyright (c) 2025 Daniel (San) Ávila

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## ContextSaver и Flightdeck

Источники: исходник образца ContextSaver, hooks/ui.tsx:646–716
(cardRows, cardBlock, compactRow, emptySection) и
исходник образца Flightdeck, hooks/register.tsx:800–830,880–920;
flightdeck/hooks/core.ts:450–457 (titleLines).

В hooks/task-cards.tsx перенесено строение нативной карточки: закруглённая
рамка, paddingX, акцентная главная карточка, приглушённые остальные,
контекст, состояние и действия. В hooks/tasks.ts заголовок в две строки
адаптирован к ширине графем и ячеек существующего layout.ts.
Палитры и данные этих модов не переносились.

MIT License

Copyright (c) 2026 Almog Baku (ContextSaver)
Copyright (c) 2026 Stephen Casella (Flightdeck)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## agentpane

Ревизия: 17be88979e5782591a2a184959df1c4168600066.

hooks/register.tsx:1074–1101 → композиция AbovePrompt в hooks/register.tsx; нижний результат сохраняется.

MIT License

Copyright (c) 2026 Anji Xu

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## chat-clean

Источник: https://github.com/achammah/claude-chat-clean, ревизия ea50e19b.

`hooks/register.tsx`, обработчики `ToolUse`/`ToolResult` и `nothing` →
приём одной строки вызова и пустого узла `<Box display="none" />` в
`hooks/register.tsx` Cockpit. Перенесён приём; оформление чужих вызовов,
сообщений и групп, таймеры и состояние образца не переносились.
Cockpit перед подменой вызывает нижние обработчики через `await next(e)`.

MIT License

Copyright (c) 2026 Assem Chammah

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## atlas

Ревизия: 94e7855a9a41904b382fe12d8330210582aabf97.

`hooks/ui/shared.tsx:66–236` → `hooks/layout.ts`: сохранены графемы, ширина и обрезка по ячейкам из прежнего мода. Сетка, метаданные, детали «Входящих» удалены.

MIT License

Copyright (c) 2026 NeelAPatel

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
