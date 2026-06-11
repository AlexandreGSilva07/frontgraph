/**
 * @graph
 * id: src/main
 * category: entry
 * summary: Application entry point — mounts App inside #root with StrictMode
 * dependencies: [src/App]
 * exports: []
 * doc: Docs/src/main.md
 */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
