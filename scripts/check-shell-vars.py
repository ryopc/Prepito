#!/usr/bin/env python3
"""シェル変数参照の直後に全角文字（その他 ASCII 以外）ilename がある箇所を検出する。

## なぜ検出が必要か

bash の変数名は `[A-Za-z_][A-Za-z0-9_]*` だが、locale によっては
非 ASCII バイトが `isalnum()` に真と判定され、**変数名の一部として取り込まれる**。
その場合:

```bash
echo "エイリアス: $PREPITO_KEY_ALIAS）"
# -> bash: PREPITO_KEY_ALIAS?: unbound variable
```

のように、変数名が `\xef\xbc\x89` まで伸びた別の未定義変数として解釈され、
`set -u` の下でスクリプトが停止する。
エラーメッセージにも別の変数名が見えてしまうため、原因の特定が難しい。

## 検出ルール

`$識別子` の直後に ASCII 以外の文字（日本語の括弧・句読点など）が
来ている行をエラーとして報告する。

## 対処

波括弧記法で変数名を明示的に区切る:

```bash
echo "エイリアス: ${PREPITO_KEY_ALIAS}）"
```

## 使い方

    python3 scripts/check-shell-vars.py fdroid/build-recipe.sh scripts/build-android.sh
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

# `$識別子`（`${...}` 形式は既に区切りが明確なので対象外）
VARIABLE_REF = re.compile(r"\$[A-Za-z_][A-Za-z0-9_]*")


def check_file(path: Path) -> list[str]:
    """指定ファイルから問題を検出する。

    @param path 検査対象のファイル
    @returns 問題箇所のメッセージ一覧
    """
    problems: list[str] = []
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeDecodeError) as exc:
        return [f"{path}: 読み取りに失敗しました: {exc}"]

    for lineno, line in enumerate(lines, 1):
        for match in VARIABLE_REF.finditer(line):
            tail = line[match.end() : match.end() + 1]
            if tail and ord(tail[0]) > 127:
                problems.append(
                    f"{path}:{lineno}: 変数参照の直後に非 ASCII 文字があります: "
                    f"{match.group(0)}{tail!r} "
                    f"→ 波括弧記法 {{{match.group(0)[1:]}}} を使ってください"
                )
    return problems


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("使い方: python3 scripts/check-shell-vars.py <file> [<file> ...]", file=sys.stderr)
        return 2

    problems: list[str] = []
    for arg in argv[1:]:
        problems.extend(check_file(Path(arg)))

    if problems:
        print("ERROR: シェル変数参照に非 ASCII 文字が隣接しています", file=sys.stderr)
        for problem in problems:
            print(f"  {problem}", file=sys.stderr)
        return 1

    print(f"OK: 検査した {len(argv) - 1} ファイルで問題は見つかりませんでした")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
