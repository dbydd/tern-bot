"""exec the sandbox-side ACP connector named by a Worker target file.

The target file is `{"argv": [...]}`. `os.execvp` replaces this process, so the
relay never buffers ACP frames and stdin EOF reaches the connector directly.
"""

import json
import os
import sys


def main(path: str) -> int:
    with open(path, encoding="utf-8") as handle:
        target = json.load(handle)
    argv = target.get("argv") if isinstance(target, dict) else None
    if not isinstance(argv, list) or not argv or not all(isinstance(a, str) for a in argv):
        print(f"tern-bot worker: bad ACP target in {path}", file=sys.stderr)
        return 1
    os.execvp(argv[0], argv)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
