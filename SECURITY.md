# Security

Report a vulnerability to justin@justinstimatze.com rather than in a public issue. I'll reply within a week.

The server holds a Linear credential with write access to your workspace. It sends that credential only to `api.linear.app`, and it never writes a token to its logs or tool results. Credentials from `auth login` are stored with mode `0600`.
