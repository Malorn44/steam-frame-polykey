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
- **Anything that runs on the Frame**: the injected bundle, the packs it loads, the systemd user unit
  (`contrib/polykey.service`) and the deploy script.

Bugs in Steam, SteamOS or the projects polykey uses belong with those projects, unless polykey makes
them exploitable.

Only the latest version on `main` is supported.
