---
name: Bug report
about: Report unexpected or incorrect behavior
title: ''
labels: ''
assignees: ''

---

**Describe the bug**
A clear and concise description of what the bug is.

**Does `pg` do the same?**
This package is a `pg`-compatible facade, so the first question is almost always
whether `pg` answers differently. Run the same program with `driver: pg` if you
can and say what each one returned. A difference from `pg` is a bug here; the
same answer from both is usually a question about PostgreSQL or TypeORM.

**To Reproduce**
A minimal, self-contained snippet - the DataSource options used (redact any
password or host you don't want public), the entity or raw query involved, and
the column types it touches.

```ts
// e.g.
import { DataSource } from 'typeorm';
import * as pgjs from 'typeorm-postgrejs';

const ds = new DataSource({ type: 'postgres', driver: pgjs, url: '...' });
await ds.initialize();
const rows = await ds.query('select $1::numeric', ['19.99']);
```

**Expected behavior**
What you expected to happen - the value or the shape `pg` returns, if that is
the comparison.

**Actual behavior**
What actually happened: the full error message and stack trace, or the
incorrect value returned.

**Environment**
 - typeorm-postgrejs version: [e.g. 2.0.2]
 - postgrejs version: [e.g. 3.15.1]
 - typeorm version: [e.g. 1.1.1]
 - Node.js version: [e.g. 24.15.0]
 - PostgreSQL version and provider: [e.g. PostgreSQL 18, self-hosted / RDS / Supabase / ...]
 - OS: [e.g. Ubuntu 24.04]

**Additional context**
Anything else relevant - pooling, SSL/TLS, PgBouncer, whether it reproduces
consistently, and any non-default option you pass (`inferParameterTypes`,
`postgrejs: { ... }`).
