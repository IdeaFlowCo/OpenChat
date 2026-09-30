# Browser card scanner verification

Run from the monorepo root with the lockfile dependencies installed. This focused
browser test uses the actual React Native Web scanner and card screens and real
jsQR decoding of a generated QR in a canvas MediaStream. Navigation/context/API
fixtures isolate the flow without signing in or writing production data. Save
contact verifies the vCard URL handed to the browser; server route tests separately
exercise the vCard response and friendship service. It does not test a physical
phone camera, OS contact import, or production authentication.

Use an already installed Playwright and Chrome; no dependency installation is
performed by these scripts. Set `PLAYWRIGHT_MODULE_PATH` if Playwright is outside
the workspace. Set `QR_TEST_CHROME_PATH` to use an existing Chrome executable,
or omit it to use Playwright's existing browser. Evidence goes only to the
explicitly supplied `QR_TEST_EVIDENCE_DIR`.

```sh
node apps/mobile/test/browser-qr/build.mjs
QR_TEST_EVIDENCE_DIR=/authorized/evidence/path node apps/mobile/test/browser-qr/verify.cjs
```

Assertions cover camera consent, denied/unavailable camera with working paste,
foreign links and real QR rejection, explicit Save contact versus friendship,
no conversation on scan/request, track shutdown on exit/success, and one
navigation despite repeated frames. Phone-width screenshots and an event
transcript are produced. Remove the generated `.browser-qr-test/` directory
after verification; it is a transient browser bundle, not source.
