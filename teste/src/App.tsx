/**
 * @graph
 * id: src/App
 * category: entry
 * summary: Root component — mounts OrderForm wizard in a centered container
 * dependencies: [src/components/OrderForm]
 * exports: [App (default)]
 * doc: Docs/src/App.md
 */

import OrderForm from './components/OrderForm'
import './App.css'

export default function App() {
  return (
    <div className="app">
      <OrderForm />
    </div>
  )
}
