# アセット画像

Expo アプリのアプリアイコン / スプラッシュ画像。

| ファイル | サイズ | 用途 | 備考 |
|---------|--------|------|------|
| `icon.png` | 1024×1024 | iOS / Android アイコン | アルファチャンネルなし (RGB) |
| `adaptive-icon.png` | 1024×1024 | Android adaptive icon のフォアグラウンド | アルファチャンネルあり (白グリフのみ) |
| `splash.png` | 2048×2048 | スプラッシュ | 白背景 + 中央のロゴ |

## 生成方法

マスター画像は **Hugging Face Z-Image (`Z-Image-Turbo`)** で生成している。

- プロンプト:
  > A minimal flat mobile app icon of a closed white padlock, perfectly centered, on a
  > smooth vertical gradient background that goes from light sky blue at the top to deep
  > ocean blue at the bottom. The padlock is a simple geometric shape: a rounded rectangle
  > body with a thin circular shackle arch on top and a small round keyhole in the middle.
  > Crisp vector-like edges, generous empty padding all around the glyph, perfectly
  > symmetric composition, high contrast white on blue, clean modern iOS app icon style,
  > flat design, no text, no letters, no numbers, no shadow, no reflection, no gloss, no
  > extra objects, no background pattern
- 解像度: `1024x1024 (1:1)` / seed: `20261020` / steps: `8`

`icon.png` はマスター画像をそのまま 1024×1024 PNG へ変換したもの。
`adaptive-icon.png` と `splash.png` はマスター画像から以下のように派生させている。

1. `adaptive-icon.png`
   - 高輝度かつ非青（白）のピクセルを白グリフとして抽出
   - グリフの bounding box を切り出し 560×560 へリサイズ
     （Android adaptive icon の安全域 66% ≒ 675px に対して十分な余白を確保）
   - ソフトアルファを付与し 1024×1024 の透明キャンバスの中央へ配置
   - 背景色は `app.config.ts` の `android.adaptiveIcon.backgroundColor` (`#0EA5E9`) で供給
2. `splash.png`
   - 2048×2048 の白キャンバス中央へ 640×640 にリサイズしたロゴを配置

再生成する場合は、マスター画像を WebP で取得してから上記の手順を再現すること。
