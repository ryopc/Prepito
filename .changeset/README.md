# Changesets

このディレクトリは [Changesets](https://github.com/changesets/changesets) の
設定と、リリースノート用テキスト（change file）を保持する。

## 使い方

```bash
# 変更内容を記述した change file を作る
pnpm changeset

# 現在のバージョンと未反映の change file を確認
pnpm changeset status

# change file を適用してバージョン番号と CHANGELOG を更新
pnpm changeset version
```

## 補足

- npm に公開される対象は `@prepito/shared` のみ
  （`@prepito/app` とルートは `private: true` のため publish 対象外）
- アプリの配布（F-Droid / GitHub Releases）は
  `.github/workflows/release.yml` が担当しており、Changesets とは独立している
