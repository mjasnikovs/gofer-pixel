// Registers a real DOM for `bun test`, so UI tests are real React against real nodes.
// See `docs/techstack.md` §3 — nothing in a test ever waits on wall-clock time.
import {GlobalRegistrator} from '@happy-dom/global-registrator'

GlobalRegistrator.register()
;(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true
