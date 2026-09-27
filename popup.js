const toggle = document.getElementById('enabledToggle');
document.getElementById('version').textContent = 'v' + chrome.runtime.getManifest().version;
chrome.storage.sync.get({ enabled: true }, data => { toggle.checked = data.enabled !== false; });

const diagnose = document.getElementById('diagnose');
const diagnosticText = document.getElementById('diagnosticText');
const diagnosticStatus = document.getElementById('diagnosticStatus');
const copyDiagnostic = document.getElementById('copyDiagnostic');
const exportDiagnostic = document.getElementById('exportDiagnostic');
copyDiagnostic.disabled = exportDiagnostic.disabled = true;

diagnose.addEventListener('click', () => {
  if (diagnose.disabled) return;
  diagnose.disabled = true;
  copyDiagnostic.disabled = exportDiagnostic.disabled = true;
  diagnosticText.value = '';
  diagnosticText.hidden = true;
  diagnosticStatus.textContent = '確認しています…';
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    if (chrome.runtime.lastError || !tabs[0]?.id) {
      diagnose.disabled = false;
      diagnosticStatus.textContent = 'Prime Videoのタブを開いてから再度お試しください。';
      return;
    }
    chrome.tabs.sendMessage(tabs[0].id, { type: 'scp-diagnostics' }, { frameId: 0 }, data => {
      if (chrome.runtime.lastError || !data) {
        diagnose.disabled = false;
        diagnosticStatus.textContent = 'ページ側の拡張が応答しません。拡張とPrime Videoページを再読み込みしてください。';
        return;
      }
      chrome.tabs.sendMessage(tabs[0].id, { type: 'scp-network-diagnostics' }, { frameId: 0 }, network => {
        const unavailable = !!chrome.runtime.lastError || !network || typeof network.ready !== 'boolean';
        diagnosticText.value = JSON.stringify({ extensionVersion: chrome.runtime.getManifest().version,
          ...data, networkObservation: unavailable ? { status: 'unavailable-reload-page' } : network }, null, 2);
        diagnosticText.hidden = false;
        diagnose.disabled = false;
        copyDiagnostic.disabled = exportDiagnostic.disabled = false;
        diagnosticStatus.textContent = '再生状態と観察結果です。作品名・URL・認証情報は含みません。';
      });
    });
  });
});
copyDiagnostic.addEventListener('click', async () => {
  if (copyDiagnostic.disabled || !diagnosticText.value) return;
  try {
    await navigator.clipboard.writeText(diagnosticText.value);
    diagnosticStatus.textContent = 'コピーしました。作品名・話数・起きたことを添えて報告してください。';
  } catch {
    diagnosticText.focus();
    diagnosticText.select();
    diagnosticStatus.textContent = '選択した情報をCtrl+Cでコピーしてください。';
  }
});

toggle.addEventListener('change', () => {
  chrome.storage.sync.set({ enabled: toggle.checked });
  document.getElementById('settingStatus').textContent = 'Prime Videoページを再読み込みすると、変更が完全に反映されます。';
});

exportDiagnostic.addEventListener('click', () => {
  if (exportDiagnostic.disabled || !diagnosticText.value) return;
  let url;
  const link = document.createElement('a');
  try {
    const blob = new Blob([diagnosticText.value], { type: 'application/json;charset=utf-8' });
    url = URL.createObjectURL(blob);
    link.href = url;
    link.download = 'simple-continuous-play-diagnostics.json';
    document.body.appendChild(link);
    link.click();
    diagnosticStatus.textContent = 'JSONの保存を開始しました。作品名・話数・起きたことは報告文に記入してください。';
  } catch {
    diagnosticStatus.textContent = 'JSONを保存できませんでした。「ログをコピー」をお試しください。';
  } finally {
    link.remove();
    // Allow both browsers to start reading before releasing the download URL.
    if (url) setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
});
