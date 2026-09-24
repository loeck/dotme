export function initSceneInfo(): () => void {
  const trigger = document.querySelector<HTMLButtonElement>('.scene-info-trigger')
  const dialog = document.querySelector<HTMLDialogElement>('.scene-info-dialog')
  if (!trigger || !dialog) return () => {}
  const lifetime = new AbortController()
  const { signal } = lifetime
  trigger.hidden = false
  trigger.addEventListener('click', () => dialog.showModal(), { signal })
  dialog.addEventListener('close', () => trigger.focus({ preventScroll: true }), { signal })
  dialog.addEventListener(
    'click',
    (event) => {
      if (event.target !== dialog) return
      const bounds = dialog.getBoundingClientRect()
      if (
        event.clientX < bounds.left ||
        event.clientX > bounds.right ||
        event.clientY < bounds.top ||
        event.clientY > bounds.bottom
      )
        dialog.close()
    },
    { signal },
  )
  return () => {
    lifetime.abort()
    dialog.close()
    trigger.hidden = true
  }
}
