/**
 * The features whose Host rows are mounted. Every row of this package imports this one
 * module file, so they all share the same set; the root row serves it to the browser half.
 */
export const features = new Set()

/** Add a feature while its row is mounted and remove it when the row stops. */
export function enableFeature(ctx, name) {
  features.add(name)
  ctx.effect(() => () => features.delete(name), 'claude-sidebar feature: ' + name)
}

/** The mounted feature names, sorted so the route answers are stable. */
export function getFeatures() {
  return [...features].sort()
}
