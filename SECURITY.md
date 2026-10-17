# Security policy

twosystems runs inside developer tools and handles session summaries and API keys, so security reports get priority.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private vulnerability reporting instead: open the **Security** tab of this repository and choose **Report a vulnerability**. You will get a reply within seven days.

## Scope

Of particular interest:

- Secrets (API keys, tokens, passwords) reaching a decision model, a log file or the network.
- Hook files written without the user's consent, or not removed on uninstall.
- Anything that lets twosystems act without the user's approval.

## Supported versions

Until v1.0 is released, only the latest commit on `main` is supported.
