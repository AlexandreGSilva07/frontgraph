/**
 * @graph
 * id: src/logic/validation
 * category: logic
 * summary: Multi-level validation — field-level, entity-level, cross-entity, and async coupon validation against simulated API
 * dependencies: [src/types/orders]
 * exports: [validatePayment, validateCart, validatePaymentForCart, validateCoupon, validateItemQuantity]
 * doc: Docs/src/logic/validation.md
 */

import type {
  Cart,
  CartItem,
  PaymentMethod,
  Result,
} from '../types/orders'
import { err, ok } from '../types/orders'

// ── Payment validation (exhaustive switch on discriminated union) ──
export function validatePayment(pm: PaymentMethod): Result<PaymentMethod, string[]> {
  switch (pm.method) {
    case 'credit_card': {
      const errors: string[] = []

      if (pm.cardNumber.trim().length === 0) errors.push('Card number is required')
      else if (!/^\d{13,19}$/.test(pm.cardNumber)) errors.push('Card number format is invalid')

      if (pm.cvv.trim().length === 0) errors.push('CVV is required')
      else if (!/^\d{3,4}$/.test(pm.cvv)) errors.push('CVV format is invalid')

      if (pm.expiryMonth < 1 || pm.expiryMonth > 12) errors.push('Expiry month must be 1-12')

      const now = new Date()
      const currentYear = now.getFullYear()
      const currentMonth = now.getMonth() + 1
      if (pm.expiryYear < currentYear || (pm.expiryYear === currentYear && pm.expiryMonth < currentMonth)) {
        errors.push('Card is expired')
      }

      if (pm.installments < 1 || pm.installments > 12) errors.push('Installments must be 1-12')

      return errors.length > 0 ? err(errors) : ok(pm)
    }

    case 'pix': {
      if (!pm.cpf || pm.cpf.trim().length === 0) return err(['CPF is required'])
      if (!/^\d{11}$/.test(pm.cpf)) return err(['CPF must be exactly 11 digits'])
      return ok(pm)
    }

    case 'boleto': {
      const errors: string[] = []
      if (!pm.cpf || pm.cpf.trim().length === 0) errors.push('CPF is required')
      else if (!/^\d{11}$/.test(pm.cpf)) errors.push('CPF must be exactly 11 digits')
      if (!pm.address || pm.address.trim().length === 0) errors.push('Address is required for Boleto')
      return errors.length > 0 ? err(errors) : ok(pm)
    }

    case 'wallet_credit': {
      if (!pm.walletId || pm.walletId.trim().length === 0) return err(['Wallet ID is required'])
      return ok(pm)
    }
  }
}

// ── Cart validation ──
export function validateCart(cart: Cart): Result<Cart, string[]> {
  if (cart.items.length === 0) return err(['Cart is empty'])

  const itemErrors: string[] = []
  for (const item of cart.items) {
    if (item.quantity <= 0) {
      itemErrors.push(`${item.product.name}: quantity must be positive`)
    }
    if (item.product.category === 'physical' && item.quantity > item.product.stockQuantity) {
      itemErrors.push(`${item.product.name}: only ${item.product.stockQuantity} in stock`)
    }
    if (item.product.category === 'digital' && item.quantity > item.product.downloadLimit) {
      itemErrors.push(`${item.product.name}: download limit is ${item.product.downloadLimit}`)
    }
  }

  return itemErrors.length > 0 ? err(itemErrors) : ok(cart)
}

// ── Cross-field validation (payment method vs cart contents) ──
export function validatePaymentForCart(
  pm: PaymentMethod,
  cart: Cart,
): Result<{ payment: PaymentMethod; cart: Cart }, string[]> {
  const errors: string[] = []

  // Boleto has a max purchase of R$ 1.000,00 (100000 cents)
  if (pm.method === 'boleto' && cart.total > 100000) {
    errors.push('Boleto maximum purchase is R$ 1.000,00')
  }

  // Pix has per-item quantity limits
  if (pm.method === 'pix') {
    const totalQty = cart.items.reduce((sum, i) => sum + i.quantity, 0)
    if (totalQty > 10) {
      errors.push('Pix purchases limited to 10 items total')
    }
  }

  // Wallet credit must cover the total
  if (pm.method === 'wallet_credit' && pm.amount < cart.total) {
    errors.push(`Insufficient wallet balance. Need ${cart.total}, have ${pm.amount}`)
  }

  return errors.length > 0 ? err(errors) : ok({ payment: pm, cart })
}

// ── Async coupon validation (simulated API call) ──
const VALID_COUPONS: Record<string, { maxUses: number; _used: number }> = {
  WELCOME10: { maxUses: 100, _used: 42 },
  SAVE20: { maxUses: 50, _used: 50 },
  VIP30: { maxUses: 10, _used: 1 },
}

export async function validateCoupon(
  code: string,
  cartSubtotal: number,
): Promise<Result<string, string[]>> {
  // Simulate network delay
  await new Promise(r => setTimeout(r, 800 + Math.random() * 400))

  const coupon = VALID_COUPONS[code.toUpperCase()]
  if (!coupon) return err(['Coupon not found'])

  if (coupon._used >= coupon.maxUses) return err(['Coupon usage limit reached'])

  if (code === 'SAVE20' && cartSubtotal < 5000) {
    return err(['Minimum purchase of R$ 50,00 required for SAVE20'])
  }

  if (code === 'VIP30' && cartSubtotal < 20000) {
    return err(['Minimum purchase of R$ 200,00 required for VIP30'])
  }

  return ok(code.toUpperCase())
}

// ── Quantity validator ──
export function validateItemQuantity(item: CartItem, newQty: number): Result<number, string[]> {
  if (newQty <= 0) return err(['Quantity must be positive'])

  if (item.product.category === 'physical' && newQty > item.product.stockQuantity) {
    return err([`Only ${item.product.stockQuantity} in stock`])
  }

  if (item.product.category === 'digital' && newQty > item.product.downloadLimit) {
    return err([`Download limit is ${item.product.downloadLimit}`])
  }

  return ok(newQty)
}
