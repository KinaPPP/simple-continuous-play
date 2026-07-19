# シンプル連続再生 / Simple Continuous Play

Amazonプライムビデオで、オープニング(OP)やエンディング(ED)をスキップせずに次のエピソードへ自動的に連続再生するChrome拡張機能です。

A Chrome extension that automatically advances to the next episode on Amazon Prime Video — without skipping the opening (OP) or ending credits (ED).

---

## 背景 / Background

Amazonプライムビデオの「自動再生」機能をONにすると、次のエピソードへ自動的に進んでくれる代わりに、OP・EDが強制的にスキップされてしまいます。この拡張機能は、Amazon純正の自動再生設定は**ONのまま**にしつつ、EDの自動スキップだけをキャンセルし、映像が本当に終わったタイミングで次話へ進めます。

Turning on Amazon Prime Video's built-in "Autoplay" setting advances episodes automatically, but it also force-skips the OP and ED. This extension keeps Amazon's autoplay setting **ON**, cancels the automatic ED-skip, and instead advances to the next episode only once playback has genuinely finished.

## 主な機能 / Features

- 「クレジットを観る」ボタンを自動クリックし、EDの自動スキップをキャンセル / Automatically clicks "Watch Credits" to cancel the automatic ED skip
- 動画が本当に終わった(`ended`イベント)タイミングで「次のエピソード」ボタンを自動クリック / Automatically clicks "Next Episode" once the video's native `ended` event fires
- 「イントロをスキップ」ボタンには一切触れないため、OPは常にフル再生される / Never touches the "Skip Intro" button, so the OP always plays in full
- 「あなたにおすすめの商品」パネルをAmazon純正の「非表示」ボタンで自動的に畳む(映画・TV共通) / Automatically collapses the "Recommended for you" panel via Amazon's own "Hide" button (movies and TV series alike)
- 映画の場合、次作への自動遷移を止める「Stop Autoplay」ボタンも自動クリック(映画では連続再生せず、EDだけを守る) / For movies, also clicks "Stop Autoplay" so the ED plays in full without auto-advancing to another film
- ポップアップからON/OFF切り替え可能 / Toggle on/off from the popup

## インストール方法 / Installation

### Chrome / Chrome系ブラウザ

1. このリポジトリをダウンロードまたはクローン / Download or clone this repository
2. `chrome://extensions` を開く / Open `chrome://extensions`
3. 右上の「デベロッパーモード」をON / Enable "Developer mode" (top right)
4. 「パッケージ化されていない拡張機能を読み込む」から `simple-continuous-play` フォルダを選択 / Click "Load unpacked" and select the `simple-continuous-play` folder

### Firefox

一時的な読み込み(ブラウザを再起動すると消えます) / Temporary installation (removed on browser restart):

1. `about:debugging#/runtime/this-firefox` を開く / Open `about:debugging#/runtime/this-firefox`
2. 「一時的なアドオンを読み込む」をクリック / Click "Load Temporary Add-on"
3. `simple-continuous-play` フォルダ内の `manifest.json` を選択 / Select `manifest.json` inside the `simple-continuous-play` folder

恒久的に使い続けたい場合は、Mozillaの署名(AMOへの提出、または自己配布用の署名)が別途必要です / For permanent installation, the extension needs to be signed by Mozilla (either by submitting to AMO or via self-distribution signing).

## 使い方 / Usage

- Amazon側の「自動再生」設定はONのままにしてください(OFFだと次話への自動遷移自体が発生しません) / Keep Amazon's own "Autoplay" setting ON — turning it off prevents automatic progression entirely
- 拡張機能アイコンのポップアップから有効/無効を切り替えられます / Use the extension icon's popup to toggle the extension on/off

## 注意事項 / Notes

- Amazon側のUI構造(要素ID)に依存しているため、Amazonのアップデートで動作しなくなる可能性があります / Relies on Amazon's current UI element IDs — may break after Amazon updates its player
- 最終話など「次のエピソード」が存在しない場合は、通常通り再生が終了します / If there is no next episode (e.g. the season finale), playback simply ends as normal
- FirefoxではON/OFFの状態(`storage.sync`)がFirefox Syncの設定に応じてローカル限定になる場合があります / In Firefox, the on/off toggle state (`storage.sync`) may stay local-only depending on your Firefox Sync settings

## ライセンス / License

MIT License. See [LICENSE](./LICENSE).

## 作者 / Author

KINA ([@KinaPPP](https://github.com/KinaPPP))
