// Interactive doc-page components (review route, editor replay). Loaded on
// demand by app.js only when a page contains one, so the home page never pays
// for it. Init is idempotent via data-ready.

function initReviewRoute() {
  for (const route of document.querySelectorAll('[data-review-route]:not([data-ready])')) {
    route.dataset.ready = '1'
    const checks = [...route.querySelectorAll('[data-review-check]')]
    const status = route.querySelector('[data-review-status]')
    const update = () => {
      let left = 0
      let done = 0
      for (const check of checks) {
        check.closest('.review-step').classList.toggle('review-step-done', check.checked)
        if (check.checked) done += 1
        else left += Number(check.dataset.minutes)
      }
      status.textContent =
        done === 0
          ? `About ${route.dataset.totalMinutes} minutes for a full first pass, including the code and commits these steps point at.`
          : done === checks.length
            ? 'You have read the whole map.'
            : `${done} of ${checks.length} steps done. About ${left} minutes left.`
    }
    for (const check of checks) check.addEventListener('change', update)
    update()
  }
}

function initEditorReplay(cleanupCallbacks) {
  for (const replay of document.querySelectorAll('[data-editor-replay]:not([data-ready])')) {
    replay.dataset.ready = '1'
    const button = replay.querySelector('[data-er-play]')
    const tabs = [...replay.querySelectorAll('[role="tab"]')]
    let timerId = null
    const stopReplay = () => {
      if (timerId !== null) clearTimeout(timerId)
      timerId = null
    }
    cleanupCallbacks.push(stopReplay)
    button.addEventListener('click', () => {
      stopReplay()
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
        const current = tabs.findIndex((tab) => tab.getAttribute('aria-selected') === 'true')
        tabs[(current + 1) % tabs.length].click()
        return
      }
      // Each step lingers for over two seconds, so without a label change the
      // button reads "Play" for the whole walkthrough and looks unresponsive.
      button.textContent = 'Playing…'
      button.setAttribute('aria-label', 'Playing editor walkthrough')
      let index = 0
      const advance = () => {
        if (!replay.isConnected) return stopReplay()
        tabs[index++].click()
        if (index < tabs.length) timerId = setTimeout(advance, 2400)
        else {
          timerId = null
          button.textContent = 'Replay'
          button.setAttribute('aria-label', 'Replay editor walkthrough')
        }
      }
      advance()
    })
  }
}

function initChoosers() {
  for (const chooser of document.querySelectorAll('[data-chooser]:not([data-ready])')) {
    chooser.dataset.ready = '1'
    const options = [...chooser.querySelectorAll('[data-chooser-option]')]
    const panels = [...chooser.querySelectorAll('[data-chooser-panel]')]
    const select = (index) => {
      for (const option of options) {
        option.setAttribute('aria-pressed', String(option.dataset.chooserOption === index))
      }
      for (const panel of panels) panel.hidden = panel.dataset.chooserPanel !== index
    }
    for (const option of options) {
      option.addEventListener('click', () => select(option.dataset.chooserOption))
    }
    // Without JS every answer is on the page at once; with JS the reader picks
    // theirs, so start on the first rather than on nothing.
    select(options[0].dataset.chooserOption)
  }
}

export function init(cleanupCallbacks) {
  initReviewRoute()
  initChoosers()
  initEditorReplay(cleanupCallbacks)
}
