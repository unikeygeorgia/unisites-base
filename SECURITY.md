# Security

Please do not open a public issue for a vulnerability. Report it privately through GitHub's
"Report a vulnerability" (Security → Advisories) on this repository.

What this package depends on for its security, and how it is kept:

- **better-auth** is pinned to an exact version. Its advisories
  (github.com/better-auth/better-auth/security) are followed; a fix is released here as a new tag,
  and each project moves to it after its own tests.
- **Only the plugins base needs** are enabled: phone number, email OTP, admin, two-factor, captcha
  (Turnstile), haveibeenpwned. SSO, SCIM, the OAuth provider and OAuth proxy are not.
- **Secrets** (the signing secret, SMS and mail keys, Google's client secret) live only as the
  project's Worker secrets. None is in this repository or in a project's repository.
- **Tags are not moved.** A project installs a tag and its lockfile pins the commit.
