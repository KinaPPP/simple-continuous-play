@echo off
setlocal

if "%AMO_JWT_ISSUER%"=="" (
  echo [ERROR] AMO_JWT_ISSUER が設定されていません。
  echo sign-firefox.local.bat をコピーしてキーを記入してから、そちらを実行してください。
  pause
  exit /b 1
)
if "%AMO_JWT_SECRET%"=="" (
  echo [ERROR] AMO_JWT_SECRET が設定されていません。
  echo sign-firefox.local.bat をコピーしてキーを記入してから、そちらを実行してください。
  pause
  exit /b 1
)

echo ==============================
echo manifest.json のバージョン:
findstr "version" manifest.json
echo ==============================
echo.

set /p CONFIRM=このバージョンでFirefox向けに署名します。よろしいですか? (y/n): 
if /i not "%CONFIRM%"=="y" (
  echo 中止しました。
  pause
  exit /b 0
)

echo.
echo 署名を開始します...
REM --ignore-files で、拡張機能の中身ではないファイル(このバッチ群やREADME等)を
REM 提出物のZIPから除外する。これをしないとAPIキーが書かれたファイルまで
REM Mozillaへ送信されてしまい、キーが自動的に無効化される事故につながる。
npx web-ext sign ^
  --channel=unlisted ^
  --api-key=%AMO_JWT_ISSUER% ^
  --api-secret=%AMO_JWT_SECRET% ^
  --ignore-files="*.bat" ^
  --ignore-files="*.bat.template" ^
  --ignore-files="README.md" ^
  --ignore-files="LICENSE" ^
  --ignore-files=".gitignore"

echo.
echo 完了しました。web-ext-artifacts フォルダの中の .xpi を確認してください。
pause
