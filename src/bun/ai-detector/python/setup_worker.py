"""Model provisioning/check only; never receives manuscript text."""
import contextlib
from importlib.metadata import version
import json
from pathlib import Path
import sys
import time

CONFIG = json.loads(Path(__file__).with_name('detector_config.json').read_text())


def emit(value):
    print(json.dumps(value), flush=True)


def check():
    from huggingface_hub import snapshot_download
    if version('detectorscope') != CONFIG['packageVersion']:
        return False
    snapshot_download(CONFIG['model'], revision=CONFIG['revision'], local_files_only=True)
    return True


if __name__ == '__main__':
    if '--check' in sys.argv:
        try:
            with contextlib.redirect_stdout(sys.stderr):
                ready = check()
        except Exception:
            ready = False
        emit({'ready': ready})
    else:
        from huggingface_hub import snapshot_download
        from tqdm import tqdm

        class FileProgress(tqdm):
            def __init__(self, *args, **kwargs):
                kwargs['file'] = sys.stderr
                super().__init__(*args, **kwargs)
                self.last_report = 0
                self.report()

            def report(self):
                now = time.monotonic()
                if now - self.last_report >= 0.5 or self.n == self.total:
                    self.last_report = now
                    emit({'completed': self.n, 'total': self.total, 'kind': 'bytes' if self.unit == 'B' else 'files'})

            def update(self, n=1):
                result = super().update(n)
                self.report()
                return result

        snapshot_download(CONFIG['model'], revision=CONFIG['revision'], tqdm_class=FileProgress)
        emit({'downloaded': True})
