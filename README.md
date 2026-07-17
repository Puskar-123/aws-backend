# CodeHub backend

## Project Health Score

`GET /repo/:id/insights/health?range=30d` returns the authorized evidence-based score for 30, 90, or 180 days without executing repository code.

Node.js/Express/Mongoose backend for CodeHub. Repository authorization is centralized in `services/repositoryPermissionService.js`; built-in roles and permissions are defined once in `constants/repositoryPermissions.js`.

Run tests with `npm test`. Repository-role migration is manual only:

```powershell
npm run migrate:repository-roles:dry
npm run migrate:repository-roles
```

Review the dry run and take a database backup before the real migration. The server never runs it at startup. See `../docs/CUSTOM_REPOSITORY_ROLES.md` for roles, APIs, security, rollback, and deployment.
