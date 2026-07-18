# CodeHub backend

Voice messages and WebRTC call signalling extend the existing authenticated Chat server. See `../docs/CODEHUB_VOICE_AND_CALLING.md` for REST/socket contracts, private storage, TURN variables, permissions, tests, and deployment notes.

## Project Health Score

`GET /repo/:id/insights/health?range=30d` returns the authorized evidence-based score for 30, 90, or 180 days without executing repository code.

Node.js/Express/Mongoose backend for CodeHub. Repository authorization is centralized in `services/repositoryPermissionService.js`; built-in roles and permissions are defined once in `constants/repositoryPermissions.js`.

Run tests with `npm test`. Repository-role migration is manual only:

CodeHub Chat shares the Express HTTP server through Socket.IO, persists conversations and messages in MongoDB, and enforces current repository access on REST and socket events. See `../docs/CODEHUB_CHAT.md` for APIs, privacy, attachment controls, Nginx configuration, testing, and limitations.

Guided Contribution adds authenticated profiles and history at `/contributions`, repository-scoped guides/recommendations/sessions under `/repo/:repoId`, deterministic scoring, and stored-evidence validation. It reuses central permissions and existing branches, commits, pull requests, Actions evidence, notifications, and Mentor Chat; it never executes repository code. See `../docs/GUIDED_CONTRIBUTION_SYSTEM.md`.

```powershell
npm run migrate:repository-roles:dry
npm run migrate:repository-roles
```

Review the dry run and take a database backup before the real migration. The server never runs it at startup. See `../docs/CUSTOM_REPOSITORY_ROLES.md` for roles, APIs, security, rollback, and deployment.
