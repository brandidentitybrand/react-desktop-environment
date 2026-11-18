The boundaries:

- Engine → compositor only, with a stock default.
- Compositor → window manager + application manager, coordinating Surface lifecycle and restoration.
- Managers → their own records, independently importable.
- GUI → presentation, outside the engine’s dependencies.

One important detail: compositor operations should publish consistent snapshots across all three tables, including during restoration and failed opens. Application CRUD can delegate to the application manager while the compositor enforces Surface relationships.