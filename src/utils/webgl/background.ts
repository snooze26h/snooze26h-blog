export function enableGradientBackground(): void {
  const gradientBg = document.getElementById('gradient-background')
  if (gradientBg) {
    gradientBg.style.display = 'block'
    gradientBg.style.opacity = '1'
  }
  // The upstream theme used to inject an !important rule here that made the
  // scrolled header fully transparent so the gradient could show through it.
  // The header must stay opaque over page content, so that hack is gone.
}

export function disableGradientBackground(): void {
  const gradientBg = document.getElementById('gradient-background')
  if (gradientBg) {
    gradientBg.style.opacity = '0'
    setTimeout(() => {
      gradientBg.style.display = 'none'
    }, 1000)
  }
}

export function applyCachedWebGLState(
  webglSupported: boolean,
  hardwareAccelerated: boolean
): void {
  const gradientBg = document.getElementById('gradient-background')
  if (!gradientBg) return
  
  if (!webglSupported || !hardwareAccelerated) {
    disableGradientBackground()
  } else {
    enableGradientBackground()
  }
}