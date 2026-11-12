# Security

Please report security problems privately through GitHub's **Report a vulnerability** button on this
repository rather than in a public issue.

Rec-It's security design is described in ARCHITECTURE.md §21. In short: a sandboxed renderer with no
Node access, validated IPC, no shell execution, secrets encrypted with the operating system's secure
storage, and AI actions that are undoable and need a click inside Rec-It for anything heavy or external.
