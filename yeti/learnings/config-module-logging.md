When adding diagnostics or watcher code in `src/config.ts`, do not import
`src/log.ts`: the logger imports config live bindings such as `LOG_LEVEL`, so a
config-to-log import creates a circular dependency. Keep config diagnostics on
`console.warn`/`console.error` or move logging to a caller/listener outside the
config module.
