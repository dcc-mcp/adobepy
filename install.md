# Install and Use adobepy

`adobepy` has two installable parts:

- the Python SDK (`adobepy` on PyPI);
- the local broker and Adobe bridge templates (the Windows GitHub Release
  bundle).

Install only the SDK for offline development or tests. Install the runtime
bundle as well when Python must communicate with Photoshop, InDesign, Premiere
Pro, After Effects, or Illustrator.

## Requirements

For Adobe host integration, use Windows x64 with:

- Python 3.8 or newer;
- the target Adobe desktop application;
- Node.js 22 and npm only when building bridge bundles from source;
- Rust stable only when building the broker CLI from source.

The Python SDK has no third-party runtime dependencies. The broker and bridge
still need an Adobe application and a loaded bridge to execute host operations.

## Option 1: Install the Python SDK from PyPI

Create an isolated environment and install the released SDK:

~~~powershell
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install adobepy==0.5.2
~~~

Verify the package without starting Adobe or a broker:

~~~powershell
python -c "from adobe.photoshop import Photoshop; from adobe.indesign import InDesign; from adobe.premiere import Premiere; from adobe.after_effects import AfterEffects; from adobe.illustrator import Illustrator; print('adobepy SDK import OK')"
~~~

This installation provides the Python facades only. It does not provide the
`adobepy` broker executable or Adobe bridge templates.

## Option 2: Install the Windows runtime bundle

Use this option for the complete supported Windows workflow.

1. Download these two files from the same GitHub Release:

   - `adobepy-<version>-windows-x64.zip`;
   - `adobepy-<version>-windows-x64.zip.sha256`.

2. Verify the archive before extracting it:

   ~~~powershell
   $zip = 'C:\Tools\adobepy-0.5.2-windows-x64.zip'
   $expected = (Get-Content "$zip.sha256").Split()[0].ToLowerInvariant()
   $actual = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant()
   if ($actual -ne $expected) { throw 'SHA256 verification failed' }
   ~~~

3. Extract the archive to a stable directory. Do not run it from a temporary
   download directory:

   ~~~powershell
   Expand-Archive $zip -DestinationPath C:\Tools\adobepy -Force
   Set-Location C:\Tools\adobepy\adobepy-0.5.2-windows-x64
   ~~~

4. Install the SDK wheel and optionally add the broker directory to the user
   PATH:

   ~~~powershell
   .\install.ps1 -Python py -AddToUserPath
   ~~~

   Open a new PowerShell window after using `-AddToUserPath`. The installer
   uses the selected Python interpreter's user site and does not modify the
   system Python installation.

5. Verify both installed parts:

   ~~~powershell
   python -c "from adobe.photoshop import Photoshop; print('SDK import OK')"
   .\bin\adobepy.exe doctor --json
   ~~~

   `doctor` may report the broker port as a warning when no broker is running.
   Missing Python or bridge-template checks are actionable errors. Node.js and
   npm are not required for an installed release bundle.

## Start the broker

Run the broker in a separate PowerShell window. Use a private local token and
reuse it for the Python client and Adobe bridge:

~~~powershell
$env:ADOBEPY_TOKEN = 'replace-with-a-local-secret'
adobepy broker --token $env:ADOBEPY_TOKEN
~~~

The default endpoint is `http://127.0.0.1:47391`. To use another loopback
port, pass the same bind address to the broker and set the client URL:

~~~powershell
adobepy broker --bind 127.0.0.1:47392 --token $env:ADOBEPY_TOKEN
$env:ADOBEPY_BROKER_URL = 'http://127.0.0.1:47392'
~~~

Do not expose the broker on a public interface. The token is required for
authenticated requests.

## Load an Adobe bridge

Copy a configured bridge template to a working directory:

~~~powershell
$bridge = 'C:\Tools\adobepy-bridges\photoshop'
adobepy install-bridge photoshop `
  --dest $bridge `
  --broker-url http://127.0.0.1:47391 `
  --token $env:ADOBEPY_TOKEN `
  --json
~~~

Supported bridge hosts are `photoshop`, `indesign`, `premiere`,
`after-effects`, and `illustrator`. The command selects UXP for the first three
and CEP for the last two. Use the Adobe UXP Developer Tool or the applicable CEP
development workflow to load the copied directory into the matching Adobe
application.

The generated `adobepy.config.js` contains the broker URL, target, and token.
Treat it as a secret-bearing local file. Regenerate it if the token changes.

## Call the Python facade

With the broker running and the bridge loaded, set the connection variables in
the client window:

~~~powershell
$env:ADOBEPY_BROKER_URL = 'http://127.0.0.1:47391'
$env:ADOBEPY_TOKEN = 'replace-with-the-same-token'
python -c "from adobe.photoshop import Photoshop; app = Photoshop(); print(app.version)"
~~~

Use the host-specific facade when the operation is modeled. Use
`adobe.raw.RawSession` only for APIs that are not yet part of the typed facade.
See [`docs/usage.md`](docs/usage.md) for host examples and
[`docs/protocol.md`](docs/protocol.md) for the transport contract.

## Option 3: Use the standalone Python interpreter

The `adobepy-standalone-<version>-<platform>.zip` artifact contains an embedded
Python interpreter with the `adobepy` SDK already installed. It does not contain
the Rust broker or Adobe bridge templates.

Extract the matching artifact and run Python code directly:

~~~powershell
Expand-Archive .\adobepy-standalone-0.5.2-windows-x64.zip -DestinationPath C:\Tools\adobepy-python
Set-Location C:\Tools\adobepy-python
.\adobepy-python.exe -c "from adobe.photoshop import Photoshop; print('standalone SDK import OK')"
~~~

Use the full Windows runtime bundle as well when the standalone interpreter
must connect to an Adobe host. The standalone interpreter is useful for
shipping a fixed Python runtime to an adapter or for running SDK scripts on a
machine without system Python.

## Build from source

Clone the repository and install the development tools:

~~~powershell
git clone https://github.com/dcc-mcp/adobepy.git
Set-Location adobepy
npm ci
py -3.12 -m pip install --upgrade build coverage[toml] setuptools wheel
~~~

Run the verification gates:

~~~powershell
npm run test:quick
npm run test:bridges
npm run test:all
~~~

Build and install the Python wheel locally:

~~~powershell
python -m build --wheel
python -m pip install --force-reinstall (Get-ChildItem dist\adobepy-*.whl | Select-Object -First 1)
~~~

Build the Windows runtime archive:

~~~powershell
.\scripts\package-release.ps1
~~~

The archive and its SHA256 file are written to `dist\`. Use
`.\scripts\smoke_install.ps1 -ZipPath <archive>` to verify extraction,
installation, imports, and the packaged CLI in a temporary directory.

Build the standalone interpreter after building a wheel:

~~~powershell
$wheel = Get-ChildItem dist\adobepy-*.whl | Select-Object -First 1
pyoxidizer build --path pyadobe --var ADOBEPY_WHEEL $wheel.FullName
~~~

## Troubleshooting

### `adobepy` is not recognized

Open a new terminal after `-AddToUserPath`, or invoke the executable directly:

~~~powershell
.\bin\adobepy.exe doctor
~~~

### `No module named 'adobe'`

The SDK wheel is not installed in the Python interpreter being used. Check the
interpreter and reinstall into that same environment:

~~~powershell
python -c "import sys; print(sys.executable)"
python -m pip install --force-reinstall adobepy==0.5.2
~~~

### `broker_port` is unhealthy

Start `adobepy broker` in another terminal and verify the endpoint:

~~~powershell
Invoke-RestMethod http://127.0.0.1:47391/health
~~~

### Error `-32002` or no Adobe session

The broker is reachable, but no matching bridge session is connected. Confirm
that the bridge is loaded in the correct Adobe application, its generated
configuration uses the broker token, and the target matches the Python client.

### Token or unauthorized errors

Use one token for the broker, Python client, and bridge. Do not commit
`adobepy.config.js` or put the token in a shared repository.

## Uninstall

Remove the Python SDK from the interpreter where it was installed:

~~~powershell
python -m pip uninstall adobepy
~~~

If `-AddToUserPath` was used, remove the extracted `bin` directory from the
user PATH in Windows Environment Variables. Delete the extracted runtime and
bridge directories after stopping any broker process.
