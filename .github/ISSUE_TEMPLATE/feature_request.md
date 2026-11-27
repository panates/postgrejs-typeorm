---
name: Feature request
about: Suggest an idea for this project
title: ''
labels: ''
assignees: ''

---

**Is your feature request related to a problem? Please describe.**
A clear and concise description of what the problem is.

**Describe the solution you'd like**
What you want to happen - the option, the exported member or the behaviour,
and how it would be used.

```ts
// e.g. a sketch of what you have in mind
```

**Is this the facade's job?**
This package's surface is `pg`'s, and what it returns is what PostgreJS
decoded. A request to change how a value is decoded usually belongs in
[postgrejs](https://github.com/panates/postgrejs); a request to change how
TypeORM uses the driver usually belongs in TypeORM. Say which you think it is
and why, if you have a view.

**Describe alternatives you've considered**
Other ways to solve the same problem, including what you do today and why it
falls short.

**Additional context**
Anything else relevant - what `pg` does in the same situation, links to the
PostgreSQL docs the behaviour depends on.
