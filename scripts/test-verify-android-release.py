#!/usr/bin/env python3
"""Offline gate tests: mock transport/Android tools, real ZIP/hash utilities."""
import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import zipfile

SCRIPT = pathlib.Path(__file__).resolve().with_name('verify-android-release.sh')
BASH = os.environ.get('TEST_BASH') or shutil.which('bash')
CURL = r'''#!/usr/bin/env python3
import hashlib, os, pathlib, sys
args = sys.argv[1:]
root = pathlib.Path(os.environ['FIXTURE_ROOT'])
case = os.environ['CASE']
apk = root / 'fixture.apk'
def flag(k):
    return args[args.index(k) + 1]
head = '--head' in args
sums = args[-1].endswith('/SHA256SUMS')
if case == 'http404' or (sums and case == 'sums404'):
    sys.exit(22)
ctype = 'application/json' if case == 'type' else 'application/vnd.android.package-archive'
if head:
    size = apk.stat().st_size + (1 if case == 'headsize' else 0)
    length = '' if case == 'getsize' else 'Content-Length: %s\r\n' % size
    pathlib.Path(flag('--dump-header')).write_text(
        'HTTP/2 302\r\nContent-Length: 1\r\n\r\nHTTP/2 200\r\n'
        + length + 'Content-Type: ' + ctype + '\r\n\r\n')
    print('200|' + ctype, end='')
    sys.exit()
out = pathlib.Path(flag('--output'))
if sums:
    sha = hashlib.sha256(apk.read_bytes()).hexdigest()
    if case == 'checksum':
        sha = '0' * 64
    text = sha + '  OpenChat.apk\n'
    if case == 'duplicate':
        text += text
    if case == 'noentry':
        text = sha + '  Other.apk\n'
    out.write_text(text)
    print('200', end='')
else:
    out.write_bytes(apk.read_bytes())
    print('200|' + ctype, end='')
'''
AAPT = '''#!/usr/bin/env python3
import os
case = os.environ['CASE']
package = 'other.package' if case == 'package' else 'com.jacobcole.openchat'
version = '0.0.1' if case == 'version' else '1.0.20'
code = '1' if case == 'code' else '4'
print("package: name='%s' versionCode='%s' versionName='%s'" % (package, code, version))
'''
SIGNER = '''#!/usr/bin/env python3
import os, sys
case = os.environ['CASE']
pin = 'dc568c4ccbf4dde1ed7c411a01e3e40f519cc93a57a26a6e8b32708b61ce8cea'
if case == 'signer-failure':
    sys.exit(42)
print('Verifies')
if case == 'signer-missing':
    sys.exit()
if case == 'signer-wrong':
    pin = '0' * 64
if case == 'signer-uppercase':
    pin = pin.upper()
if case == 'signer-public-key':
    print('Signer #1 public key SHA-256 digest: ' + pin)
    sys.exit()
if case == 'signer-malformed':
    pin += ' junk'
print('Signer #1 certificate SHA-256 digest: ' + pin)
if case == 'signer-extra':
    print('Signer #2 certificate SHA-256 digest: ' + '0' * 64)
if case == 'signer-duplicate':
    print('Signer #1 certificate SHA-256 digest: ' + pin)
'''
CASES = {
    'valid': None,
    'http404': '',
    'type': 'content type',
    'headsize': 'HEAD size',
    'getsize': 'expected',
    'sums404': '',
    'checksum': 'does not match',
    'duplicate': 'exactly one',
    'noentry': 'exactly one',
    'badzip': 'invalid or corrupt',
    'nomanifest': 'missing AndroidManifest.xml',
    'package': 'package: expected',
    'version': 'version: expected',
    'code': 'version code: expected',
    'signer-uppercase': None,
    'signer-unavailable': None,
    'signer-wrong': 'pinned',
    'signer-missing': 'pinned',
    'signer-extra': 'pinned',
    'signer-duplicate': 'pinned',
    'signer-malformed': 'pinned',
    'signer-public-key': 'pinned',
    'signer-failure': '',
}
POSITIVES = {'valid', 'signer-uppercase', 'signer-unavailable'}


def executable(path, source):
    path.write_text(source)
    path.chmod(0o755)


with tempfile.TemporaryDirectory(prefix='openchat-release-fixtures-') as td:
    root = pathlib.Path(td)
    bin_dir = root / 'bin'
    bin_dir.mkdir()
    # Controlled PATH makes the optional signer-absent case deterministic.
    for tool in ('python3', 'unzip', 'awk', 'sed', 'wc', 'tr', 'mktemp',
                 'rm', 'cat', 'grep', 'sha256sum', 'shasum'):
        target = shutil.which(tool)
        if target:
            (bin_dir / tool).symlink_to(target)
    executable(bin_dir / 'curl', CURL)
    executable(bin_dir / 'aapt2', AAPT)
    signer = bin_dir / 'apksigner'
    results = []
    for case, error in CASES.items():
        if signer.exists():
            signer.unlink()
        if case != 'signer-unavailable':
            executable(signer, SIGNER)
        apk = root / 'fixture.apk'
        with zipfile.ZipFile(apk, 'w') as archive:
            manifest = 'Other.xml' if case == 'nomanifest' else 'AndroidManifest.xml'
            archive.writestr(manifest, b'manifest fixture')
            archive.writestr('classes.dex', b'dex fixture')
        if case == 'badzip':
            apk.write_bytes(b'not an APK archive')
        size = apk.stat().st_size + (1 if case == 'getsize' else 0)
        env = {**os.environ, 'PATH': str(bin_dir), 'CASE': case,
               'FIXTURE_ROOT': str(root), 'TMPDIR': str(root)}
        env.pop('AAPT', None)
        result = subprocess.run([BASH, str(SCRIPT), 'test-tag', str(size)],
                                env=env, capture_output=True, text=True)
        assert (result.returncode == 0) == (case in POSITIVES), (
            case, result.returncode, result.stdout, result.stderr)
        if error:
            assert error in result.stderr, (case, result.stderr)
        assert not list(root.glob('openchat-android-verify.*')), case
        results.append({'case': case, 'expected': 'pass' if case in POSITIVES else 'reject',
                        'exit': result.returncode})
    print(json.dumps(results, indent=2))
