import axe from 'axe-core'

export async function checkA11y(container: HTMLElement) {
  const results = await axe.run(container, {
    rules: {
      // jsdom doesn't compute styles
      'color-contrast': { enabled: false },
      // Region rule requires full page layout with landmarks
      region: { enabled: false },
    },
  })
  return results.violations
}
