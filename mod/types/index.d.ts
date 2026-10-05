export type ClefChromeMetrics = {
  local: number
  fallback: Record<string, number>
  shadow: { agree: number; disagree: number }
  ms: number
}

declare module 'claude-code' {
  interface PluginState {
    'clef-chrome': { metrics: ClefChromeMetrics }
  }
}
