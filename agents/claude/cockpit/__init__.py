"""Локальное транзакционное ядро Cockpit, этап M1 (observe)."""


class CockpitError(Exception):
    """Ошибка контракта или доступности с безопасным сообщением для клиента."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message
