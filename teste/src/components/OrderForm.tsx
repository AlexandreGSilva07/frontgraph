/**
 * @graph
 * id: src/components/OrderForm
 * category: ui
 * summary: Multi-step wizard component — 4-step flow, 16 action types via useReducer, async coupon debounce, conditional rendering per discriminated union variant
 * dependencies: [src/logic/order-machine, src/logic/pricing, src/logic/validation, src/types/orders]
 * exports: [OrderForm (default)]
 * doc: Docs/src/components/OrderForm.md
 */

import { useCallback, useEffect, useMemo, useReducer } from 'react'
import type {
  Cart,
  Money,
  Order,
  OrderState,
  PaymentMethod,
  PricingRule,
  Product,
  WizardStep,
} from '../types/orders'
import {
  asMoney,
  asOrderId,
  CATALOG,
  WIZARD_STEPS,
  isBundle,
  isDigital,
  isPhysical,
  isSubscription,
} from '../types/orders'
import { addToCart, pricingPipeline, recalcCart } from '../logic/pricing'
import { validateCart, validateCoupon, validateItemQuantity, validatePayment, validatePaymentForCart } from '../logic/validation'
import { availableTransitions, transition } from '../logic/order-machine'

// ── Form state ──
interface FormState {
  step: WizardStep
  stepIndex: number
  cart: Cart
  paymentMethod: PaymentMethod | null
  appliedRules: PricingRule[]
  order: Order | null
  errors: string[]
  fieldErrors: Record<string, string>
  couponLoading: boolean
  couponCode: string
  couponResult: string | null
}

type FormAction =
  | { type: 'SET_STEP'; step: WizardStep }
  | { type: 'NEXT_STEP' }
  | { type: 'PREV_STEP' }
  | { type: 'SET_CART'; cart: Cart }
  | { type: 'SET_PAYMENT'; payment: PaymentMethod }
  | { type: 'SET_PAYMENT_FIELD'; field: string; value: string | number }
  | { type: 'ADD_RULE'; rule: PricingRule }
  | { type: 'REMOVE_RULE'; index: number }
  | { type: 'SET_ERRORS'; errors: string[] }
  | { type: 'SET_FIELD_ERROR'; field: string; error: string }
  | { type: 'CLEAR_FIELD_ERRORS' }
  | { type: 'SET_ORDER'; order: Order | null }
  | { type: 'TRANSITION_ORDER'; to: OrderState }
  | { type: 'SET_COUPON_CODE'; code: string }
  | { type: 'SET_COUPON_LOADING'; loading: boolean }
  | { type: 'SET_COUPON_RESULT'; result: string | null }

function formReducer(state: FormState, action: FormAction): FormState {
  switch (action.type) {
    case 'SET_STEP': {
      const idx = WIZARD_STEPS.indexOf(action.step)
      return { ...state, step: action.step, stepIndex: idx, errors: [] }
    }
    case 'NEXT_STEP': {
      const next = Math.min(state.stepIndex + 1, WIZARD_STEPS.length - 1)
      return { ...state, step: WIZARD_STEPS[next], stepIndex: next, errors: [] }
    }
    case 'PREV_STEP': {
      const prev = Math.max(state.stepIndex - 1, 0)
      return { ...state, step: WIZARD_STEPS[prev], stepIndex: prev, errors: [] }
    }
    case 'SET_CART':
      return { ...state, cart: action.cart }
    case 'SET_PAYMENT':
      return { ...state, paymentMethod: action.payment }
    case 'SET_PAYMENT_FIELD': {
      if (!state.paymentMethod) return state
      return {
        ...state,
        paymentMethod: { ...state.paymentMethod, [action.field]: action.value },
      }
    }
    case 'ADD_RULE':
      return { ...state, appliedRules: [...state.appliedRules, action.rule] }
    case 'REMOVE_RULE': {
      const rules = [...state.appliedRules]
      rules.splice(action.index, 1)
      return { ...state, appliedRules: rules }
    }
    case 'SET_ERRORS':
      return { ...state, errors: action.errors }
    case 'SET_FIELD_ERROR':
      return { ...state, fieldErrors: { ...state.fieldErrors, [action.field]: action.error } }
    case 'CLEAR_FIELD_ERRORS':
      return { ...state, fieldErrors: {} }
    case 'SET_ORDER':
      return { ...state, order: action.order, errors: [] }
    case 'TRANSITION_ORDER': {
      if (!state.order) return state
      const result = transition(state.order, action.to)
      if (!result.ok) return { ...state, errors: [result.error] }
      return { ...state, order: result.value, errors: [] }
    }
    case 'SET_COUPON_CODE':
      return { ...state, couponCode: action.code }
    case 'SET_COUPON_LOADING':
      return { ...state, couponLoading: action.loading }
    case 'SET_COUPON_RESULT':
      return { ...state, couponResult: action.result }
    default:
      return state
  }
}

const initialPayment: PaymentMethod = {
  method: 'credit_card',
  cardNumber: '',
  expiryMonth: 1,
  expiryYear: 2026,
  cvv: '',
  installments: 1,
  brand: 'visa',
}

function initialState(): FormState {
  const cart = CATALOG.reduce(
    (c, p) => {
      const r = addToCart(c, p, 1)
      return r.ok ? r.value : c
    },
    { items: [], subtotal: asMoney(0), discount: asMoney(0), tax: asMoney(0), total: asMoney(0), appliedRules: [] } as Cart,
  )
  return {
    step: 'products',
    stepIndex: 0,
    cart,
    paymentMethod: initialPayment,
    appliedRules: [],
    order: null,
    errors: [],
    fieldErrors: {},
    couponLoading: false,
    couponCode: '',
    couponResult: null,
  }
}

// ── Format money ──
const fmt = (m: Money): string => `R$ ${(m / 100).toFixed(2).replace('.', ',')}`

export default function OrderForm() {
  const [state, dispatch] = useReducer(formReducer, null, initialState)

  // Sync pricing rules to cart
  const pricedCart = useMemo(() => {
    if (state.appliedRules.length === 0) return state.cart
    const result = pricingPipeline(state.cart, state.appliedRules)
    return result.ok ? result.value : state.cart
  }, [state.cart, state.appliedRules])

  // Sync coupon
  useEffect(() => {
    dispatch({ type: 'SET_FIELD_ERROR', field: 'coupon', error: '' })
    if (state.couponCode.length < 3) return
    const timer = setTimeout(async () => {
      dispatch({ type: 'SET_COUPON_LOADING', loading: true })
      const result = await validateCoupon(state.couponCode, state.cart.subtotal)
      dispatch({ type: 'SET_COUPON_LOADING', loading: false })
      if (result.ok) {
        dispatch({ type: 'SET_COUPON_RESULT', result: `Coupon ${result.value} applied!` })
        dispatch({
          type: 'ADD_RULE',
          rule: {
            type: 'coupon',
            code: result.value,
            discountType: 'percent',
            discountValue: result.value === 'VIP30' ? 30 : result.value === 'SAVE20' ? 20 : 10,
            maxDiscount: asMoney(10000),
          },
        })
      } else {
        dispatch({ type: 'SET_COUPON_RESULT', result: null })
        dispatch({ type: 'SET_FIELD_ERROR', field: 'coupon', error: result.error[0] })
      }
    }, 600)
    return () => clearTimeout(timer)
  }, [state.couponCode])

  // ── Step validators ──
  const validateStep = useCallback((): boolean => {
    dispatch({ type: 'SET_ERRORS', errors: [] })

    switch (state.step) {
      case 'products': {
        const r = validateCart(state.cart)
        if (!r.ok) {
          dispatch({ type: 'SET_ERRORS', errors: r.error })
          return false
        }
        return true
      }
      case 'pricing':
        return true // optional step
      case 'payment': {
        if (!state.paymentMethod) {
          dispatch({ type: 'SET_ERRORS', errors: ['Select a payment method'] })
          return false
        }
        const r = validatePayment(state.paymentMethod)
        if (!r.ok) {
          dispatch({ type: 'SET_ERRORS', errors: r.error })
          return false
        }
        const cross = validatePaymentForCart(state.paymentMethod, pricedCart)
        if (!cross.ok) {
          dispatch({ type: 'SET_ERRORS', errors: cross.error })
          return false
        }
        return true
      }
      case 'review':
        return true
    }
  }, [state.step, state.cart, state.paymentMethod, pricedCart])

  const handleNext = () => {
    if (validateStep()) {
      if (state.step === 'review') {
        const order: Order = {
          id: asOrderId(`ORD-${Date.now()}`),
          cart: pricedCart,
          paymentMethod: state.paymentMethod,
          state: 'draft',
          stateHistory: [],
          createdAt: new Date(),
        }
        dispatch({ type: 'SET_ORDER', order })
        const result = transition(order, 'pending_payment')
        if (result.ok) {
          dispatch({ type: 'SET_ORDER', order: result.value })
        }
      }
      dispatch({ type: 'NEXT_STEP' })
    }
  }

  // ── Product step handlers ──
  const handleQuantityChange = (product: Product, qty: number) => {
    const item = state.cart.items.find(i => i.product.id === product.id)
    if (!item) return

    const qtyResult = validateItemQuantity(item, qty)
    if (!qtyResult.ok) {
      dispatch({ type: 'SET_FIELD_ERROR', field: `qty-${product.id}`, error: qtyResult.error[0] })
      return
    }

    dispatch({ type: 'CLEAR_FIELD_ERRORS' })
    const newItem = { ...item, quantity: qty, lineTotal: asMoney(item.product.basePrice * qty) }
    const newItems = state.cart.items.map(i => (i.product.id === product.id ? newItem : i))
    dispatch({ type: 'SET_CART', cart: recalcCart({ ...state.cart, items: newItems }) })
  }

  const handleRemoveItem = (product: Product) => {
    const newItems = state.cart.items.filter(i => i.product.id !== product.id)
    dispatch({ type: 'SET_CART', cart: recalcCart({ ...state.cart, items: newItems }) })
  }

  // ── Payment handlers ──
  const handlePaymentMethodChange = (method: PaymentMethod['method']) => {
    dispatch({ type: 'CLEAR_FIELD_ERRORS' })
    switch (method) {
      case 'credit_card':
        dispatch({ type: 'SET_PAYMENT', payment: { ...initialPayment } })
        break
      case 'pix':
        dispatch({ type: 'SET_PAYMENT', payment: { method: 'pix', cpf: '' } })
        break
      case 'boleto':
        dispatch({ type: 'SET_PAYMENT', payment: { method: 'boleto', cpf: '', address: '' } })
        break
      case 'wallet_credit':
        dispatch({ type: 'SET_PAYMENT', payment: { method: 'wallet_credit', walletId: '', amount: asMoney(0) } })
        break
    }
  }

  // ── Render helpers ──
  const errorBanner = state.errors.length > 0 && (
    <div className="error-banner">
      {state.errors.map((e, i) => <p key={i}>{e}</p>)}
    </div>
  )

  const progressBar = (
    <div className="progress-bar">
      {WIZARD_STEPS.map((s, i) => (
        <div key={s} className={`progress-step ${i <= state.stepIndex ? 'active' : ''} ${i === state.stepIndex ? 'current' : ''}`}>
          <span className="step-dot" />
          <span className="step-label">{s}</span>
        </div>
      ))}
    </div>
  )

  // ── Render step content ──
  const renderProductStep = () => (
    <div className="step-content">
      <h3>Select Products</h3>
      {state.cart.items.map(item => (
        <div key={item.product.id} className="cart-item">
          <div className="item-info">
            <strong>{item.product.name}</strong>
            <span className="item-category-badge">
              {item.product.category}
              {isBundle(item.product) && ` (${item.product.items.length} items)`}
            </span>
            <span>{fmt(item.product.basePrice)} / unit</span>
            {isPhysical(item.product) && <small>Stock: {item.product.stockQuantity}</small>}
            {isDigital(item.product) && <small>{item.product.licenseType} license</small>}
            {isSubscription(item.product) && (
              <small>{item.product.billingCycle} • {item.product.trialDays}d trial</small>
            )}
          </div>
          <div className="item-actions">
            <input
              type="number"
              min={0}
              max={isPhysical(item.product) ? item.product.stockQuantity : 99}
              value={item.quantity}
              onChange={e => handleQuantityChange(item.product, Number(e.target.value))}
            />
            <button className="btn-remove" onClick={() => handleRemoveItem(item.product)}>
              Remove
            </button>
          </div>
          {state.fieldErrors[`qty-${item.product.id}`] && (
            <div className="field-error">{state.fieldErrors[`qty-${item.product.id}`]}</div>
          )}
        </div>
      ))}
      <div className="cart-summary">
        <span>Subtotal: <strong>{fmt(pricedCart.subtotal)}</strong></span>
        {pricedCart.discount > 0 && <span>Discount: <strong>{fmt(pricedCart.discount)}</strong></span>}
        {pricedCart.tax > 0 && <span>Tax: <strong>{fmt(pricedCart.tax)}</strong></span>}
        <span className="cart-total">Total: <strong>{fmt(pricedCart.total)}</strong></span>
      </div>
    </div>
  )

  const renderPricingStep = () => (
    <div className="step-content">
      <h3>Apply Discounts & Rules</h3>

      <div className="coupon-section">
        <label>Coupon Code</label>
        <div className="coupon-input-row">
          <input
            type="text"
            placeholder="e.g. WELCOME10"
            value={state.couponCode}
            onChange={e => dispatch({ type: 'SET_COUPON_CODE', code: e.target.value })}
          />
          {state.couponLoading && <span className="loading">Checking...</span>}
        </div>
        {state.fieldErrors.coupon && <div className="field-error">{state.fieldErrors.coupon}</div>}
        {state.couponResult && <div className="field-success">{state.couponResult}</div>}
      </div>

      <div className="active-rules">
        <h4>Active Rules ({state.appliedRules.length})</h4>
        {state.appliedRules.length === 0 && <p className="muted">No rules applied</p>}
        {state.appliedRules.map((rule, i) => (
          <div key={i} className="rule-item">
            <span className="rule-badge">{rule.type}</span>
            <span>
              {rule.type === 'coupon' && `${rule.code} (${rule.discountValue}${rule.discountType === 'percent' ? '%' : ' fixed'})`}
              {rule.type === 'bundle' && `${rule.discountPercent}% bundle`}
              {rule.type === 'tiered' && `${rule.tiers.length} tiers`}
              {rule.type === 'regional_tax' && `${rule.taxPercent}% tax (${rule.region})`}
              {rule.type === 'loyalty' && `${rule.discountPercent}% loyalty`}
            </span>
            <button className="btn-remove" onClick={() => dispatch({ type: 'REMOVE_RULE', index: i })}>
              Remove
            </button>
          </div>
        ))}
      </div>

      <div className="cart-summary">
        <span>Subtotal: <strong>{fmt(pricedCart.subtotal)}</strong></span>
        {pricedCart.discount > 0 && <span>Discount: <strong>-{fmt(pricedCart.discount)}</strong></span>}
        {pricedCart.tax > 0 && <span>Tax: <strong>+{fmt(pricedCart.tax)}</strong></span>}
        <span className="cart-total">Total: <strong>{fmt(pricedCart.total)}</strong></span>
      </div>
    </div>
  )

  const renderPaymentStep = () => (
    <div className="step-content">
      <h3>Payment Method</h3>

      <div className="payment-methods">
        {(['credit_card', 'pix', 'boleto', 'wallet_credit'] as const).map(m => (
          <label key={m} className={`payment-option ${state.paymentMethod?.method === m ? 'selected' : ''}`}>
            <input
              type="radio"
              name="payment_method"
              value={m}
              checked={state.paymentMethod?.method === m}
              onChange={() => handlePaymentMethodChange(m)}
            />
            {m.replace('_', ' ')}
          </label>
        ))}
      </div>

      {state.paymentMethod?.method === 'credit_card' && (
        <div className="payment-fields">
          <div className="field">
            <label>Card Number</label>
            <input
              type="text"
              value={state.paymentMethod.cardNumber}
              onChange={e => dispatch({ type: 'SET_PAYMENT_FIELD', field: 'cardNumber', value: e.target.value })}
            />
          </div>
          <div className="field-row">
            <div className="field">
              <label>Expiry Month</label>
              <input
                type="number"
                min={1} max={12}
                value={state.paymentMethod.expiryMonth}
                onChange={e => dispatch({ type: 'SET_PAYMENT_FIELD', field: 'expiryMonth', value: Number(e.target.value) })}
              />
            </div>
            <div className="field">
              <label>Expiry Year</label>
              <input
                type="number"
                value={state.paymentMethod.expiryYear}
                onChange={e => dispatch({ type: 'SET_PAYMENT_FIELD', field: 'expiryYear', value: Number(e.target.value) })}
              />
            </div>
            <div className="field">
              <label>CVV</label>
              <input
                type="text"
                value={state.paymentMethod.cvv}
                onChange={e => dispatch({ type: 'SET_PAYMENT_FIELD', field: 'cvv', value: e.target.value })}
              />
            </div>
          </div>
          <div className="field-row">
            <div className="field">
              <label>Brand</label>
              <select
                value={state.paymentMethod.brand}
                onChange={e => dispatch({ type: 'SET_PAYMENT_FIELD', field: 'brand', value: e.target.value })}
              >
                <option value="visa">Visa</option>
                <option value="mastercard">Mastercard</option>
                <option value="amex">Amex</option>
              </select>
            </div>
            <div className="field">
              <label>Installments</label>
              <input
                type="number"
                min={1} max={12}
                value={state.paymentMethod.installments}
                onChange={e => dispatch({ type: 'SET_PAYMENT_FIELD', field: 'installments', value: Number(e.target.value) })}
              />
            </div>
          </div>
        </div>
      )}

      {state.paymentMethod?.method === 'pix' && (
        <div className="payment-fields">
          <div className="field">
            <label>CPF (11 digits)</label>
            <input
              type="text"
              value={state.paymentMethod.cpf}
              onChange={e => dispatch({ type: 'SET_PAYMENT_FIELD', field: 'cpf', value: e.target.value })}
            />
          </div>
        </div>
      )}

      {state.paymentMethod?.method === 'boleto' && (
        <div className="payment-fields">
          <div className="field">
            <label>CPF (11 digits)</label>
            <input
              type="text"
              value={state.paymentMethod.cpf}
              onChange={e => dispatch({ type: 'SET_PAYMENT_FIELD', field: 'cpf', value: e.target.value })}
            />
          </div>
          <div className="field">
            <label>Billing Address</label>
            <input
              type="text"
              value={state.paymentMethod.address}
              onChange={e => dispatch({ type: 'SET_PAYMENT_FIELD', field: 'address', value: e.target.value })}
            />
          </div>
        </div>
      )}

      {state.paymentMethod?.method === 'wallet_credit' && (
        <div className="payment-fields">
          <div className="field">
            <label>Wallet ID</label>
            <input
              type="text"
              value={state.paymentMethod.walletId}
              onChange={e => dispatch({ type: 'SET_PAYMENT_FIELD', field: 'walletId', value: e.target.value })}
            />
          </div>
          <div className="field">
            <label>Available Credit (cents)</label>
            <input
              type="number"
              value={state.paymentMethod.amount}
              onChange={e => dispatch({ type: 'SET_PAYMENT_FIELD', field: 'amount', value: Number(e.target.value) })}
            />
          </div>
        </div>
      )}

      <div className="cart-summary">
        <span className="cart-total">Total to pay: <strong>{fmt(pricedCart.total)}</strong></span>
      </div>
    </div>
  )

  const renderReviewStep = () => (
    <div className="step-content">
      <h3>Review Order</h3>

      <div className="review-section">
        <h4>Items</h4>
        {pricedCart.items.map(item => (
          <div key={item.product.id} className="review-item">
            <span>{item.product.name} x{item.quantity}</span>
            <span>{fmt(item.lineTotal)}</span>
          </div>
        ))}
      </div>

      {state.appliedRules.length > 0 && (
        <div className="review-section">
          <h4>Applied Rules</h4>
          {state.appliedRules.map((r, i) => (
            <div key={i} className="review-rule">
              <span className="rule-badge">{r.type}</span>
              <span>{r.type === 'coupon' ? r.code : r.type}</span>
            </div>
          ))}
        </div>
      )}

      <div className="review-section">
        <h4>Payment</h4>
        <p>{state.paymentMethod?.method.replace('_', ' ')}</p>
      </div>

      <div className="cart-summary">
        <span>Subtotal: <strong>{fmt(pricedCart.subtotal)}</strong></span>
        {pricedCart.discount > 0 && <span>Discount: <strong>-{fmt(pricedCart.discount)}</strong></span>}
        {pricedCart.tax > 0 && <span>Tax: <strong>+{fmt(pricedCart.tax)}</strong></span>}
        <span className="cart-total">Total: <strong>{fmt(pricedCart.total)}</strong></span>
      </div>
    </div>
  )

  const renderOrderTracking = () => {
    if (!state.order) return null

    const next = availableTransitions(state.order)
    const allStates: OrderState[] = ['draft', 'pending_payment', 'paid', 'processing', 'shipped', 'delivered']

    return (
      <div className="step-content">
        <h3>Order #{state.order.id}</h3>

        <div className="order-timeline">
          {allStates.map(s => {
            const historyIdx = state.order!.stateHistory.findIndex(h => h.to === s)
            const isCurrent = state.order!.state === s
            const isPast = historyIdx >= 0 && !isCurrent
            const isRelevant = isCurrent || isPast || next.includes(s)

            return (
              <div key={s} className={`timeline-step ${isCurrent ? 'current' : ''} ${isPast ? 'past' : ''} ${isRelevant ? '' : 'muted'}`}>
                <div className="timeline-dot" />
                <span>{s}</span>
                {isPast && state.order!.stateHistory[historyIdx] && (
                  <small>{state.order!.stateHistory[historyIdx].timestamp.toLocaleTimeString()}</small>
                )}
              </div>
            )
          })}
        </div>

        {next.length > 0 && (
          <div className="order-actions">
            <h4>Next Actions</h4>
            {next.map(n => (
              <button
                key={n}
                className="btn-action"
                onClick={() => dispatch({ type: 'TRANSITION_ORDER', to: n })}
              >
                {n.replace('_', ' ')}
              </button>
            ))}
          </div>
        )}

        <div className="order-history">
          <h4>History</h4>
          {state.order.stateHistory.map((h, i) => (
            <div key={i} className="history-entry">
              <span>{h.from} → {h.to}</span>
              <small>{h.timestamp.toLocaleString()}</small>
            </div>
          ))}
        </div>
      </div>
    )
  }

  const stepContent = () => {
    switch (state.step) {
      case 'products': return renderProductStep()
      case 'pricing': return renderPricingStep()
      case 'payment': return renderPaymentStep()
      case 'review': return renderReviewStep()
      default: return null
    }
  }

  return (
    <div className="order-form">
      <h2>Complex Order System</h2>
      {progressBar}
      {errorBanner}
      {state.step !== 'review' ? stepContent() : (
        state.order ? renderOrderTracking() : stepContent()
      )}
      <div className="step-actions">
        {state.stepIndex > 0 && !state.order && (
          <button className="btn-secondary" onClick={() => dispatch({ type: 'PREV_STEP' })}>
            Back
          </button>
        )}
        {!state.order && (
          <button className="btn-primary" onClick={handleNext}>
            {state.step === 'review' ? 'Place Order' : 'Next'}
          </button>
        )}
        {state.order && (
          <button className="btn-secondary" onClick={() => dispatch({ type: 'SET_ORDER', order: null })}>
            New Order
          </button>
        )}
      </div>
    </div>
  )
}
