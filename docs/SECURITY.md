# Security policy

polykey sees everything its user types, so security reports are taken seriously.

## Reporting a vulnerability

Report it privately through GitHub: on this repository's **Security** tab, choose
**Report a vulnerability**. Please don't open a public issue, pull request or discussion for it.

Describe the problem and how to reproduce it. **Never include typed text, passwords or recordings**
(audio or screen) in a report: describe what happened instead, with made-up text where an example
helps.

## Scope

- **The sidecar**: the Python service (`sidecar/`), including dictation's downloads and its speech
  helper.
- **Its bridge to the page**: the CDP binding between the bundle in Steam's keyboard popup and the
  sidecar, and the connection to Steam's debugger.
- **Releases and how they're installed**: the one-line installer (`scripts/install.sh`), the release
  tarballs and the checks made before one is installed (the signature on `latest.json`, the
  tarball's size and sha256, and how it's unpacked), and the service's self-updater (signature
  checking, download and unpacking).
- **Anything that runs on the Frame**: the injected bundle, the packs it loads, the systemd user unit
  (`contrib/polykey.service`) and the deploy script.

Bugs in Steam, SteamOS or the projects polykey uses belong with those projects, unless polykey makes
them exploitable. One is known: with CEF remote debugging on, SteamOS's
`steam-web-debug-portforward.service` opens Steam's debugger to the network on port 8081. It's a
SteamOS default, not polykey's bug (polykey uses only 127.0.0.1:8080), but the installer warns
about it and the [README](../README.md#install) says how to close it.

The latest release is supported, and so is `main`. Fixes go into a new release, not into older
ones.
