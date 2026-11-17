# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/dikadavidsatu/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/dikadavidsatu/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node process, built from scratch on the standard
library alone: real git objects and packfiles behind smart-HTTP clone/push (protocol v0 and
v2, shallow fetch included), the REST API (repositories, contents, refs, branches, commits,
labels, issues, comments, pull requests with squash merges), a GraphQL API with cursor
connections and introspection, and an MCP server whose tools act on the same store — so an
object created on one surface reads back identically on all the others.

## Run it

```sh
MAKEFUN_SHOP_TOKEN=<token> node main.ts   # or: node app.ts; the suite starts it via main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=nimble-sparrow-96&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
