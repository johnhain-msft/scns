'use client'

export function SkipToContent() {
  return (
    <a
      href="#main-content"
      className="skip-to-content"
      style={{
        position: 'absolute',
        left: '-9999px',
        top: 'auto',
        width: '1px',
        height: '1px',
        overflow: 'hidden',
      }}
      onFocus={(e) => {
        e.currentTarget.style.position = 'fixed'
        e.currentTarget.style.top = '0'
        e.currentTarget.style.left = '0'
        e.currentTarget.style.width = 'auto'
        e.currentTarget.style.height = 'auto'
        e.currentTarget.style.padding = '0.5rem 1rem'
        e.currentTarget.style.zIndex = '9999'
        e.currentTarget.style.background = 'var(--accent-9)'
        e.currentTarget.style.color = 'white'
      }}
      onBlur={(e) => {
        e.currentTarget.style.position = 'absolute'
        e.currentTarget.style.left = '-9999px'
      }}
    >
      Skip to content
    </a>
  )
}
