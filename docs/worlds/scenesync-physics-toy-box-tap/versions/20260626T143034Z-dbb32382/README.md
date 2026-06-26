# Physics Toy Box: Tap + Push Buttons

Scene Sync / Rapier / Loomlet 用の軽量Export ZIPです。

## 遊び方

1. Scene SyncでこのZIPをImportします。
2. Player Shellで開きます。
3. 3つの大きい `TAP` パッドを指・マウス・Player Shellでタップします。
4. タップしたパッドと物理ボタンが、Loomlet `pointer.click` で光って少し膨らみます。
5. Playを押すと、物理ボール・ドミノ・ゴール演出を確認できます。

## 変更点

- 物理ボタンの上に、分かりやすいタップ専用パッドを追加。
- `pointer.click` を使ったLoomlet反応を追加。
- タップ反応が一瞬で見えない問題を避けるため、Loomlet内で短いflash timerを作っています。
- 物理ボタンの質量を軽めにして、Player Shellで押したときの反応も少し見えやすくしました。

## 注意

このZipはScene Syncへ読み込むためのSceneDocumentです。standalone viewerの完全同梱版ではありません。
