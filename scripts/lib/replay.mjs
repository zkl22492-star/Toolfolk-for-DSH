import { createStudio, reduce, snapshot } from '../../src/shared/state-engine.mjs'
import { createEmployeeResolver } from '../../src/shared/employee-resolver.mjs'

/** Each replay starts from a fresh baseline; its clock is supplied by the fixture. */
export function replayStudio({ catalog, plugins, tools, events, sessionId, now = 0 }) {
  const resolver = createEmployeeResolver(catalog, plugins, tools)
  const state = createStudio({ resolveEmployee: resolver, now: () => now })
  reduce(state, { type: 'roster', plugins: resolver.roster })
  for (const event of events) {
    if (Number.isFinite(event.at)) now = event.at
    reduce(state, event)
  }
  return snapshot(state, sessionId)
}
