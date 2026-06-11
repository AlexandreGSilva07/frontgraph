/**
 * @graph
 * id: src/logic/pricing
 * category: logic
 * summary: Pricing engine pipeline — applies rules in priority order, recalculates cart totals, handles item-level and cart-level discounts
 * dependencies: [src/types/orders]
 * exports: [recalcCart, pricingPipeline, addToCart]
 * doc: Docs/src/logic/pricing.md
 */

import type {
  Cart,
  CartItem,
  PricingRule,
  Product,
  Result,
} from '../types/orders'
import { asMoney, err, ok } from '../types/orders'

// ── Tiered pricing ──
function applyTiered(item: CartItem, rule: Extract<PricingRule, { type: 'tiered' }>): CartItem {
  const sortedTiers = [...rule.tiers].sort((a, b) => b.minQuantity - a.minQuantity)
  const matchedTier = sortedTiers.find(t => item.quantity >= t.minQuantity)
  if (!matchedTier) return item

  const newLineTotal = asMoney(matchedTier.pricePerUnit * item.quantity)
  const discount = asMoney(item.lineTotal - newLineTotal)
  return { ...item, lineTotal: newLineTotal, discountTotal: asMoney(item.discountTotal + discount) }
}

// ── Coupon discount ──
function applyCouponToCart(cart: Cart, rule: Extract<PricingRule, { type: 'coupon' }>): Cart {
  if (rule.expiresAt && new Date() > rule.expiresAt) return cart
  if (rule.minPurchase && cart.subtotal < rule.minPurchase) return cart

  const applicableItems = rule.applicableCategories
    ? cart.items.filter(i => rule.applicableCategories!.includes(i.product.category))
    : cart.items

  if (applicableItems.length === 0) return cart

  let totalDiscount = asMoney(0)
  const updatedItems = cart.items.map(item => {
    if (!applicableItems.includes(item)) return item

    const itemDiscount =
      rule.discountType === 'percent'
        ? asMoney(Math.floor((item.lineTotal - item.discountTotal) * rule.discountValue / 100))
        : asMoney(rule.discountValue * item.quantity)

    const cappedDiscount = rule.maxDiscount
      ? asMoney(Math.min(itemDiscount, rule.maxDiscount - totalDiscount))
      : itemDiscount

    totalDiscount = asMoney(totalDiscount + cappedDiscount)

    return {
      ...item,
      discountTotal: asMoney(item.discountTotal + cappedDiscount),
    }
  })

  return recalcCart({ ...cart, items: updatedItems, appliedRules: [...cart.appliedRules, rule] })
}

// ── Bundle discount ──
function applyBundleDiscount(cart: Cart, rule: Extract<PricingRule, { type: 'bundle' }>): Cart {
  const bundleItems = cart.items.filter(i =>
    rule.requiredProductIds.some(rid => rid === i.product.id),
  )

  if (bundleItems.length < rule.requiredProductIds.length) return cart

  const updatedItems = cart.items.map(item => {
    if (!bundleItems.includes(item)) return item
    const extraDiscount = asMoney(Math.floor((item.lineTotal - item.discountTotal) * rule.discountPercent / 100))
    return { ...item, discountTotal: asMoney(item.discountTotal + extraDiscount) }
  })

  return recalcCart({ ...cart, items: updatedItems, appliedRules: [...cart.appliedRules, rule] })
}

// ── Regional tax ──
function applyRegionalTax(cart: Cart, rule: Extract<PricingRule, { type: 'regional_tax' }>): Cart {
  const taxableItems = rule.exemptCategories
    ? cart.items.filter(i => !rule.exemptCategories!.includes(i.product.category))
    : cart.items

  const taxAmount = taxableItems.reduce(
    (sum, item) => asMoney(sum + Math.floor((item.lineTotal - item.discountTotal) * rule.taxPercent / 100)),
    asMoney(0),
  )

  return { ...cart, tax: asMoney(cart.tax + taxAmount), appliedRules: [...cart.appliedRules, rule] }
}

// ── Loyalty discount ──
function applyLoyaltyDiscount(cart: Cart, rule: Extract<PricingRule, { type: 'loyalty' }>): Cart {
  let totalDiscount = asMoney(0)
  const updatedItems = cart.items.map(item => {
    if (totalDiscount >= rule.maxDiscount) return item

    const potential = asMoney(Math.floor((item.lineTotal - item.discountTotal) * rule.discountPercent / 100))
    const remaining = asMoney(rule.maxDiscount - totalDiscount)
    const applied = asMoney(Math.min(potential, remaining))
    totalDiscount = asMoney(totalDiscount + applied)

    return { ...item, discountTotal: asMoney(item.discountTotal + applied) }
  })

  return recalcCart({ ...cart, items: updatedItems, appliedRules: [...cart.appliedRules, rule] })
}

// ── Rule priority & conflict resolution ──
const RULE_PRIORITY: Record<PricingRule['type'], number> = {
  tiered: 0,
  bundle: 1,
  coupon: 2,
  loyalty: 3,
  regional_tax: 4,
}

function sortRulesByPriority(rules: PricingRule[]): PricingRule[] {
  return [...rules].sort((a, b) => RULE_PRIORITY[a.type] - RULE_PRIORITY[b.type])
}

// ── Recalculate cart totals ──
export function recalcCart(cart: Cart): Cart {
  const items = cart.items.map(item => ({
    ...item,
    lineTotal: asMoney(item.product.basePrice * item.quantity),
    discountTotal: asMoney(0),
  }))

  const subtotal = items.reduce((sum, i) => asMoney(sum + i.lineTotal), asMoney(0))

  return {
    ...cart,
    items,
    subtotal,
    discount: asMoney(0),
    tax: asMoney(0),
    total: subtotal,
  }
}

// ── Item-level rule application ──
function applyRuleToItem(item: CartItem, rule: PricingRule): CartItem {
  switch (rule.type) {
    case 'tiered':
      return applyTiered(item, rule)
    default:
      return item // cart-level rules are handled separately
  }
}

// ── Main pricing pipeline ──
export function pricingPipeline(cart: Cart, rules: PricingRule[]): Result<Cart> {
  const sorted = sortRulesByPriority(rules)
  let current = recalcCart(cart)

  for (const rule of sorted) {
    switch (rule.type) {
      case 'tiered':
        current = {
          ...current,
          items: current.items.map(i => applyRuleToItem(i, rule)),
        }
        break
      case 'coupon':
        current = applyCouponToCart(current, rule)
        break
      case 'bundle':
        current = applyBundleDiscount(current, rule)
        break
      case 'regional_tax':
        current = applyRegionalTax(current, rule)
        break
      case 'loyalty':
        current = applyLoyaltyDiscount(current, rule)
        break
      default:
        return err(`Unknown pricing rule: ${(rule as PricingRule).type}`)
    }
  }

  // Final total
  const netSubtotal = current.items.reduce(
    (sum, i) => asMoney(sum + i.lineTotal - i.discountTotal),
    asMoney(0),
  )
  const total = asMoney(netSubtotal + current.tax)

  return ok({
    ...current,
    discount: asMoney(current.subtotal - netSubtotal),
    total,
  })
}

// ── Add item to cart with quantity merge ──
export function addToCart(cart: Cart, product: Product, quantity: number): Result<Cart> {
  if (quantity <= 0) return err('Quantity must be positive')

  const existing = cart.items.findIndex(i => i.product.id === product.id)
  let newItems: CartItem[]

  if (existing >= 0) {
    if (product.category === 'digital' && cart.items[existing].quantity + quantity > product.downloadLimit) {
      return err(`Cannot exceed download limit of ${product.downloadLimit}`)
    }
    newItems = cart.items.map((item, idx) =>
      idx === existing
        ? { ...item, quantity: item.quantity + quantity, lineTotal: asMoney(item.product.basePrice * (item.quantity + quantity)) }
        : item,
    )
  } else {
    if (product.category === 'physical' && quantity > product.stockQuantity) {
      return err(`Insufficient stock. Available: ${product.stockQuantity}`)
    }
    newItems = [
      ...cart.items,
      {
        product,
        quantity,
        lineTotal: asMoney(product.basePrice * quantity),
        discountTotal: asMoney(0),
      },
    ]
  }

  return ok(recalcCart({ ...cart, items: newItems }))
}
