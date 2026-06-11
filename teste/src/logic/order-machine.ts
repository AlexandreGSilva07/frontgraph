/**
 * @graph
 * id: src/logic/order-machine
 * category: logic
 * summary: Order state machine — validates transitions, enforces guards per source/target state, maintains append-only history
 * dependencies: [src/types/orders]
 * exports: [transition, availableTransitions, isTerminal]
 * doc: Docs/src/logic/order-machine.md
 */

import type { Order, OrderState, Result, StateTransition } from '../types/orders'
import { ORDER_STATE_TRANSITIONS } from '../types/orders'
import { err, ok } from '../types/orders'

// ── Guard: checks if transition is valid ──
function isValidTransition(from: OrderState, to: OrderState): boolean {
  const allowed = ORDER_STATE_TRANSITIONS[from]
  return allowed.includes(to)
}

// ── Guards: business rules for specific transitions ──
function guardToPendingPayment(order: Order): Result<Order> {
  if (order.cart.items.length === 0) return err('Cannot submit empty cart')
  if (!order.paymentMethod) return err('Payment method is required to submit')
  return ok(order)
}

function guardToProcessing(order: Order): Result<Order> {
  const hasPhysicalItems = order.cart.items.some(i => i.product.category === 'physical')
  if (hasPhysicalItems && !order.paymentMethod) {
    return err('Physical orders require a confirmed payment method')
  }
  return ok(order)
}

function guardToShipped(order: Order): Result<Order> {
  const hasPhysicalItems = order.cart.items.some(i => i.product.category === 'physical')
  if (!hasPhysicalItems) return err('Cannot ship order with only digital/subscription items')
  return ok(order)
}

function guardToCancelled(order: Order): Result<Order> {
  const nonCancellable: OrderState[] = ['shipped', 'delivered', 'cancelled', 'refunded']
  if (nonCancellable.includes(order.state)) {
    return err(`Cannot cancel order in '${order.state}' state`)
  }
  return ok(order)
}

function guardToRefunded(order: Order): Result<Order> {
  const refundable: OrderState[] = ['paid', 'delivered']
  if (!refundable.includes(order.state)) {
    return err(`Cannot refund order in '${order.state}' state. Must be 'paid' or 'delivered'`)
  }
  return ok(order)
}

const alwaysOk = (o: Order): Result<Order> => ok(o)

// ── Guard dispatcher: guards triggered by the SOURCE state ──
const SOURCE_GUARDS: Partial<Record<OrderState, (order: Order) => Result<Order>>> = {
  draft: guardToPendingPayment,
  pending_payment: alwaysOk,
  paid: guardToProcessing,
  processing: guardToShipped,
  shipped: alwaysOk,
}

// ── Guard dispatcher: guards triggered by the TARGET state ──
const TARGET_GUARDS: Partial<Record<OrderState, (order: Order) => Result<Order>>> = {
  cancelled: guardToCancelled,
  refunded: guardToRefunded,
}

// ── Main transition function ──
export function transition(order: Order, to: OrderState): Result<Order> {
  if (!isValidTransition(order.state, to)) {
    return err(`Invalid transition: '${order.state}' → '${to}'`)
  }

  // Run target-state guard (for cancelled, refunded)
  const targetGuard = TARGET_GUARDS[to] ?? alwaysOk
  const targetResult = targetGuard(order)
  if (!targetResult.ok) return targetResult

  // Run source-state guard
  const sourceGuard = SOURCE_GUARDS[order.state] ?? alwaysOk
  const sourceResult = sourceGuard(order)
  if (!sourceResult.ok) return sourceResult

  const transitionRecord: StateTransition = {
    from: order.state,
    to,
    timestamp: new Date(),
  }

  return ok({
    ...order,
    state: to,
    stateHistory: [...order.stateHistory, transitionRecord],
  })
}

// ── Query: get available next states ──
export function availableTransitions(order: Order): OrderState[] {
  const allowed = [...ORDER_STATE_TRANSITIONS[order.state]]
  return allowed.filter(to => {
    const targetGuard = TARGET_GUARDS[to] ?? alwaysOk
    if (!targetGuard(order).ok) return false
    const sourceGuard = SOURCE_GUARDS[order.state] ?? alwaysOk
    return sourceGuard(order).ok
  })
}

// ── Check if order is terminal ──
export function isTerminal(state: OrderState): boolean {
  return ORDER_STATE_TRANSITIONS[state].length === 0
}
