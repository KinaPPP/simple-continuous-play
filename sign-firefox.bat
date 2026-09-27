@echo off
setlocal DisableDelayedExpansion

if not defined AMO_JWT_ISSUER goto missing_key
if not defined AMO_JWT_SECRET goto missing_key

pushd "%~dp0"
if errorlevel 1 goto bad_directory

if not exist "dist\firefox\manifest.json" (
  echo [ERROR] dist\firefox\manifest.json がありません。
  echo 先に build.py で生成するか、Firefox用ファイルを配置してください。
  goto failed
)
findstr /L /C:"simple-continuous-play@kinappp.github.io" "dist\firefox\manifest.json" >nul
if errorlevel 1 (
  echo [ERROR] Firefox用manifestのアドオンIDを確認してください。
  goto failed
)

echo ==============================
echo 署名対象: dist\firefox
echo manifest.json のバージョン:
findstr /C:"version" "dist\firefox\manifest.json"
echo 出力先: web-ext-artifacts
echo ==============================
set "CONFIRM="
set /p "CONFIRM=この内容でFirefox向けに署名します。よろしいですか? (y/n): "
if /i not "%CONFIRM%"=="y" (
  echo 中止しました。
  popd
  pause
  exit /b 0
)

REM Credentials are passed through environment variables, not command arguments.
set "WEB_EXT_API_KEY=%AMO_JWT_ISSUER%"
set "WEB_EXT_API_SECRET=%AMO_JWT_SECRET%"
echo 署名を開始します...
call npx web-ext sign ^
  --channel=unlisted ^
  --source-dir="dist\firefox" ^
  --artifacts-dir="web-ext-artifacts" ^
  --no-config-discovery ^
  --ignore-files="*.bat" "*.bat.template"
if errorlevel 1 goto failed

echo 完了しました。web-ext-artifacts 内の署名済みXPIを確認してください。
popd
pause
exit /b 0

:failed
echo [ERROR] 署名を完了できませんでした。上のエラーを確認してください。
popd
pause
exit /b 1

:missing_key
echo [ERROR] AMO_JWT_ISSUER または AMO_JWT_SECRET が設定されていません。
echo キーを設定した sign-firefox.local.bat から実行してください。
pause
exit /b 1

:bad_directory
echo [ERROR] バッチのフォルダを開けませんでした。
pause
exit /b 1
