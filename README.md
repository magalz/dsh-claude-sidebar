# dsh-claude-sidebar

A plugin for DeepSeek Harness (dsh) that adds a right sidebar in the style of Claude desktop. It has an icon rail and tabs for the open session: Environment, Jobs, Subagents and Git. It also adds a Run button on chat code blocks, automatic pane sizes and an `open_in_browser` tool for the agent. Each feature is its own row in **Plugins**, so you can switch off the ones you do not want.

## Requirements

- DeepSeek Harness 0.2.x. The package declares `engines.dsh` as `>=0.2.2-0 <0.2.3-0 || >=0.2.3-0 <0.3.0-0`.
- Developed and tested on the Windows desktop app.

## Install

1. In dsh, open **Plugins → Add plugin**.
2. Enter `github:magalz/dsh-claude-sidebar`.

The Add plugin dialog accepts a package name, a Git address, a tarball or an absolute local path.

If the sidebar does not appear, restart dsh.

## Features

| Feature | What it does | Row in Plugins |
| --- | --- | --- |
| Whole plugin | Carries the browser code and the list of enabled features. Turning it off turns everything off. | Claude sidebar |
| Icon rail | Opens any right-sidebar tab with one click. | Claude sidebar: icon rail |
| Jobs | Lists the session's background jobs with live output and a stop control. | Claude sidebar: Jobs tab |
| Subagents | Shows the tree of subagents the session started. | Claude sidebar: Subagents tab |
| Environment | Shows the machine, folder, branch, context use, connectors, changes and pull requests. | Claude sidebar: Environment tab |
| Run button | Runs a shell code block from chat in a new terminal. | Claude sidebar: Run button |
| Git | Shows branch, changed files with diffs, and recent commits. | Claude sidebar: Git tab |
| Pane sizes | Sizes the docked right-sidebar panes automatically. | Claude sidebar: pane sizes |
| Open in Browser | Lets the agent open a web address in a Browser tab. | Claude sidebar: open in Browser |

### Icon rail

A thin rail of icons stays beside the open right sidebar and follows its width. One click opens the matching tab. The rail is adapted from `dsh-rightbar-quicknav` (see [Credits](#credits)).

### Jobs tab

Lists the background jobs the open session started. Expand a job to see its live output. A running job has a stop control that asks you to press it twice.

### Subagents tab

Shows the tree of subagents the open session started, each with its state and model. A click opens a subagent inside the sidebar. A second button opens it full screen.

### Environment tab

A column of collapsible sections that you can reorder by dragging the header, or with `Alt+ArrowUp` and `Alt+ArrowDown` on a focused header. The order and collapsed state are saved in your browser's local storage.

- **Environment** shows the computer, the folder and branch (with the upstream state) and the GitHub repository. Optional task facts are described under [Settings](#settings).
- **Context** shows how much of the context window is used, with a bar and a breakdown. A **Compact session** button types and sends `/compact` when the message box is empty and the turn has ended. If the dsh-oh-my-claude plugin is installed, the numbers come from it. Otherwise they come from dsh's own context data.
- **Connectors** lists the MCP servers with a short state (`Connecting…`, `Sign in`, `Failed`, `Off`). A failed or closed server offers **Reconnect**. A server that waits for a credential offers **Sign in**, which opens a form with one password field per credential name. Both actions need the matching dsh services. Without them the section is read-only.
- **Changes** lists the session's pull requests, then the uncommitted files in the work tree.

In a pane narrower than 320 px the column shows a strip of section icons instead.

### Run button

Shell code blocks in chat get a **Run** button. It supports `bash`, `sh`, `shell`, `zsh`, `console`, `powershell`, `pwsh`, `ps1`, `cmd` and `bat` blocks. One click opens a new terminal tab in the session's folder and types the command at once. There is no confirmation step. Every click opens a new terminal. The button is hidden while a message is streaming, and on hosts without the terminal service.

### Git tab

A read-only tab with the session folder's branch (with `↑N ↓M` against its upstream), the changed files with `+N −M` counts, and the last 20 commits. Click a file to expand its inline diff. **Refresh** reloads the status and every open diff. The tab never stages, commits, fetches or pushes.

### Pane sizes

Sizes the docked right-sidebar panes automatically. The Environment pane keeps a fixed width. Other panes default to the width of the conversation. If you resize a pane by hand, it keeps that size until you close its tab.

### Open in Browser

Gives the agent an `open_in_browser` tool. When the agent calls it, the chat shows a one-line row and the address opens in a new Browser tab of the right sidebar. The row has an **Open** button to open it again. Only `http` and `https` addresses are accepted. An address without a scheme gets `https://`. Addresses with a user name or password are refused.

## Turning features off

Each row has its own switch in **Plugins → dsh-claude-sidebar**. A switched-off feature does nothing, and the others keep working. Switching off the root row, **Claude sidebar**, turns off all of them.

## Settings

The Environment row has a **Configure** page: **Plugins → dsh-claude-sidebar → Claude sidebar: Environment tab → Configure**. It has three settings:

- **Show task facts** (off by default): shows the tracker card named by the branch, read from an itsaplan link registry, and the work tree's `<worktree>.progress.md` file.
- **Tracker web address**: used to link cards. With it empty, a card shows its key as plain text. No address is built into the plugin.
- **Registry path**: the itsaplan link registry. Empty means `~/.claude/itsaplan/links.json`.

Changes apply on the next refresh of the tab. You do not need to restart dsh.

## What it reads and what it can do

### Host routes

The plugin adds these routes to the dsh web server:

| Route | Used by |
| --- | --- |
| `/dsh-claude-sidebar/features` | Tells the browser code which features are on. |
| `/dsh-claude-sidebar/environment` | The Environment tab. |
| `/dsh-claude-sidebar/git` | The Git tab: branch, files, commits. |
| `/dsh-claude-sidebar/git/diff` | The Git tab: the diff of one changed file. |

All four are read-only: they answer `GET` and reject other methods. They also reject requests whose `Host` or `Origin` header, when present, does not name a loopback address (`127.0.0.1`, `localhost` or `::1`). Every route also passes through DSH's own connection access check (`ctx.connection.requestRejection`) before reading anything, and fails closed with 503 when the connection service is not mounted.

### What the routes read

- **Git.** Read-only commands (`status`, `rev-parse`, `diff`, `log`, `config --get remote.origin.url`, `worktree list`), run without a shell, with a 10-second limit and bounded output. They run in the session's folder. The diff route only serves paths that appear in the current `git status` and stay inside the repository. For an untracked file it reads at most 512 KiB.
- **Session data.** The session's working directory and its pull-request bindings, from dsh.
- **Connectors.** The names and states of MCP servers and the tools they register. For a server that waits for a credential, the route sends only the credential names (the `NAME` in `${credential:NAME}`). It never sends credential values, headers or arguments. A connector's error text is cut to 200 characters, and any URL in it loses its user name, password, query and fragment.
- **Task facts.** Only when **Show task facts** is on: the link registry file and the work tree's progress file.

### What it can do

- **Run button.** It types the command into a new terminal at once, with no confirmation. The command runs with your own permissions and outside the agent's sandbox. dsh limits how many terminals a session can have. When the limit is reached, Run shows an error and sends nothing.
- **`open_in_browser`.** The agent can open `http` and `https` addresses in a Browser tab of your window. The tool does not fetch or return the page.
- **Connectors section.** **Reconnect** restarts an MCP server. **Sign in** stores the credential values you type. Both run only when you click.
- **Compact session.** Sends `/compact` to the session when you click.

### External services

The plugin's code makes no requests to external services. Its browser code calls the four routes above on the dsh server and, to fill the Context section, the `/dsh-oh-my-claude/context` route of the dsh-oh-my-claude plugin on the same server, when that plugin is installed. Its Host code talks only to dsh and to local `git`. The tracker address is used only to build a link that you click. The `open_in_browser` tool only asks your dsh window to open an address.

## Known limits

- Pane sizes rely on dsh internals that are not a public API. An app update can break them. The feature then does nothing and warns once in the console.
- It works with dsh 0.2.x only.
- The interface is in English; only the icon rail's labels switch to Chinese when dsh or the browser is set to Chinese.
- It has been tested on Windows only.

## Development

Requires Node.js 22 or newer. There are no dependencies to install.

```sh
npm test         # run the node:test suites (fakes only, no dsh process)
npm run check    # check the syntax of shipped files and that client.js is current
npm run build    # regenerate client.js
```

`client.js` is generated from `client/shared.js` and `features/*/client/*.js`, and it is committed. Never edit it by hand. After you change a client source file, run `npm run build` and commit the result.

### Layout

- `index.js`: the root row and the `/dsh-claude-sidebar/features` route.
- `host/`: helpers shared by the Host routes (request guard, session lookup, git runner, redaction, feature registry).
- `features/<feature>/`: one folder per feature. It holds the feature's Host row (`host.js`), its `locale/en.json` and `icon.svg`, and its browser code in `client/`. The Environment and Git features also keep their routes and helpers here.
- `client/shared.js`: code shared by every browser feature.
- `client.js`: the generated browser bundle.
- `scripts/build-client.mjs`: builds `client.js`.
- `test/`: the test suites.

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to contribute.

## Credits

The icon rail is adapted from [`dsh-rightbar-quicknav`](https://github.com/zuoyunlai/dsh-rightbar-quicknav) (MIT). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

MIT. See [LICENSE](LICENSE).
