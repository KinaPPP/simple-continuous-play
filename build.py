"""Build both browsers from one source tree; never include local signing secrets."""
from pathlib import Path
import json
import shutil
import zipfile

SOURCE = Path(__file__).resolve().parent
DIST = SOURCE / 'dist'
FILES = ['content.js', 'network-observer.js', 'network-bridge.js',
         'popup.html', 'popup.js', 'popup.css', 'LICENSE',
         'icons/icon16.png', 'icons/icon48.png', 'icons/icon128.png']


def build():
    manifest = json.loads((SOURCE / 'manifest.json').read_text(encoding='utf-8-sig'))
    version = manifest['version']
    for browser in ('chrome', 'firefox'):
        target = DIST / browser
        target.mkdir(parents=True, exist_ok=True)
        # Refuse unexpected files instead of packaging stale files or deleting them.
        expected = set(FILES + ['manifest.json'])
        extra = [p.relative_to(target).as_posix() for p in target.rglob('*')
                 if p.is_file() and p.relative_to(target).as_posix() not in expected]
        if extra:
            raise RuntimeError(f'Unexpected files in {target}: {extra}')
        for name in FILES:
            (target / name).parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(SOURCE / name, target / name)
        browser_manifest = json.loads(json.dumps(manifest))
        if browser == 'chrome':
            browser_manifest.pop('browser_specific_settings', None)
        (target / 'manifest.json').write_text(
            json.dumps(browser_manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        archive = DIST / f'simple-continuous-play-{version}-{browser}-candidate.zip'
        with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as out:
            for name in sorted(expected):
                out.write(target / name, name)
        with zipfile.ZipFile(archive) as check:
            assert set(check.namelist()) == expected
            assert check.testzip() is None
        print(archive)


if __name__ == '__main__':
    build()
