#!/bin/sh
set -eu
suite_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if ! command -v python3 >/dev/null 2>&1; then
  printf '%s\n' 'Итог установки:' 'поставлено: ничего' 'пропущено: весь набор — python3 не найден; установите Python 3.10+ и повторите sh install.sh' 'не настроено: проверка сервисов не выполнялась'
  exit 1
fi
exec python3 -B "$suite_dir/install.py" --home "${HOME}" "$@"
