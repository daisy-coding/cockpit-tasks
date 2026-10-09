"""Команда чтения контекста без доступа к агентским записям."""
import argparse
import json
import os
import uuid

from . import rpc


def main():
    parser = argparse.ArgumentParser(description="Прочитать сводку поручений Cockpit.")
    commands = parser.add_subparsers(dest="command", required=True)
    context = commands.add_parser("context", help="Показать сводку задач в JSON.")
    context.add_argument("--cwd", default=os.getcwd())
    context.add_argument("--cursor", type=int)
    args = parser.parse_args()
    response = rpc.handle({"v": 1, "op": "tasks.context", "requestId": str(uuid.uuid4()),
                           "session": {"sessionId": "cli", "cwd": os.path.abspath(args.cwd)},
                           "args": {} if args.cursor is None else {"cursor": args.cursor}})
    print(json.dumps(response["result"] if response["ok"] else response, ensure_ascii=False, indent=2))
    return 0 if response["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
