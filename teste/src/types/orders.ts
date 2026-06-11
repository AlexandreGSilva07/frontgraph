/**
 * @graph
 * id: src/types/orders
 * category: contract
 * summary: Domain type contracts — branded types, 4 discriminated unions, Result monad, state transition table, type predicates, sample catalog
 * dependencies: []
 * exports: [OrderId, ProductId, Money, asMoney, asOrderId, asProductId, ProductCategory, PhysicalProduct, DigitalProduct, SubscriptionProduct, BundleProduct, Product, CreditCardPayment, PixPayment, BoletoPayment, WalletPayment, PaymentMethod, PricingRule, CartItem, Cart, emptyCart, OrderState, ORDER_STATE_TRANSITIONS, StateTransition, Order, Result, ok, err, WizardStep, WIZARD_STEPS, PaymentByMethod, ProductsByCategory, ReadonlyOrder, UnwrapResult, UnwrapResults, isPhysical, isDigital, isSubscription, isBundle, CATALOG]
 * doc: Docs/src/types/orders.md
 */

// ── Branded types ──
declare const IdBrand: unique symbol
declare const MoneyBrand: unique symbol
type Branded<T, B> = T & { readonly [IdBrand]: B }

export type OrderId = Branded<string, 'OrderId'>
export type ProductId = Branded<string, 'ProductId'>
export type Money = Branded<number, 'Money'>

export const asMoney = (cents: number): Money => cents as Money
export const asOrderId = (id: string): OrderId => id as OrderId
export const asProductId = (id: string): ProductId => id as ProductId

// ── Products discriminated union ──
export type ProductCategory = 'physical' | 'digital' | 'subscription' | 'bundle'

interface ProductBase {
  id: ProductId
  name: string
  basePrice: Money
  category: ProductCategory
}

export interface PhysicalProduct extends ProductBase {
  category: 'physical'
  weightGrams: number
  dimensions: { width: number; height: number; depth: number }
  shippingCost: Money
  stockQuantity: number
}

export interface DigitalProduct extends ProductBase {
  category: 'digital'
  fileSizeMb: number
  downloadLimit: number
  licenseType: 'single' | 'team' | 'enterprise'
}

export interface SubscriptionProduct extends ProductBase {
  category: 'subscription'
  billingCycle: 'monthly' | 'yearly'
  trialDays: number
  autoRenew: boolean
}

export interface BundleProduct extends ProductBase {
  category: 'bundle'
  items: Product[]
  discountPercent: number
}

export type Product = PhysicalProduct | DigitalProduct | SubscriptionProduct | BundleProduct

// ── Payment methods discriminated union ──
export interface CreditCardPayment {
  method: 'credit_card'
  cardNumber: string
  expiryMonth: number
  expiryYear: number
  cvv: string
  installments: number
  brand: 'visa' | 'mastercard' | 'amex'
}

export interface PixPayment {
  method: 'pix'
  cpf: string
}

export interface BoletoPayment {
  method: 'boleto'
  cpf: string
  address: string
}

export interface WalletPayment {
  method: 'wallet_credit'
  walletId: string
  amount: Money
}

export type PaymentMethod = CreditCardPayment | PixPayment | BoletoPayment | WalletPayment

// ── Pricing rules discriminated union ──
interface TieredPricingRule {
  type: 'tiered'
  tiers: { minQuantity: number; pricePerUnit: Money }[]
}

interface CouponRule {
  type: 'coupon'
  code: string
  discountType: 'percent' | 'fixed'
  discountValue: number
  minPurchase?: Money
  maxDiscount?: Money
  expiresAt?: Date
  applicableCategories?: ProductCategory[]
}

interface BundleRule {
  type: 'bundle'
  requiredProductIds: ProductId[]
  discountPercent: number
}

interface RegionalTaxRule {
  type: 'regional_tax'
  region: string
  taxPercent: number
  exemptCategories?: ProductCategory[]
}

interface LoyaltyRule {
  type: 'loyalty'
  minimumPriorOrders: number
  discountPercent: number
  maxDiscount: Money
}

export type PricingRule = TieredPricingRule | CouponRule | BundleRule | RegionalTaxRule | LoyaltyRule

// ── Cart ──
export interface CartItem {
  product: Product
  quantity: number
  lineTotal: Money
  discountTotal: Money
}

export interface Cart {
  items: CartItem[]
  subtotal: Money
  discount: Money
  tax: Money
  total: Money
  appliedRules: PricingRule[]
}

export const emptyCart: Cart = {
  items: [],
  subtotal: asMoney(0),
  discount: asMoney(0),
  tax: asMoney(0),
  total: asMoney(0),
  appliedRules: [],
}

// ── Order state machine ──
export type OrderState =
  | 'draft'
  | 'pending_payment'
  | 'paid'
  | 'processing'
  | 'shipped'
  | 'delivered'
  | 'cancelled'
  | 'refunded'

export const ORDER_STATE_TRANSITIONS: Record<OrderState, readonly OrderState[]> = {
  draft: ['pending_payment', 'cancelled'],
  pending_payment: ['paid', 'cancelled'],
  paid: ['processing', 'refunded'],
  processing: ['shipped', 'cancelled'],
  shipped: ['delivered'],
  delivered: ['refunded'],
  cancelled: [],
  refunded: [],
}

export interface StateTransition {
  from: OrderState
  to: OrderState
  timestamp: Date
  metadata?: Record<string, unknown>
}

export interface Order {
  id: OrderId
  cart: Cart
  paymentMethod: PaymentMethod | null
  state: OrderState
  stateHistory: StateTransition[]
  createdAt: Date
}

// ── Result type (Either monad) ──
export type Result<T, E = string> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E }

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value })
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error })

// ── Wizard form steps ──
export type WizardStep = 'products' | 'pricing' | 'payment' | 'review'

export const WIZARD_STEPS: WizardStep[] = ['products', 'pricing', 'payment', 'review']

// ── Advanced utility types ──
/** Extract payment info by method discriminator */
export type PaymentByMethod<M extends PaymentMethod['method']> = Extract<PaymentMethod, { method: M }>

/** Extract products of a specific category */
export type ProductsByCategory<C extends ProductCategory> = Extract<Product, { category: C }>

/** Make all properties deeply readonly */
type DeepReadonly<T> = T extends (infer R)[]
  ? readonly DeepReadonly<R>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T

export type ReadonlyOrder = DeepReadonly<Order>

/** Extract the value type from a Result */
export type UnwrapResult<R> = R extends Result<infer T> ? T : never

/** Map a union of Results to a union of their value types */
export type UnwrapResults<R extends Result<unknown>[]> = {
  [K in keyof R]: R[K] extends Result<infer T> ? T : never
}

// ── Guard type predicates ──
export const isPhysical = (p: Product): p is PhysicalProduct => p.category === 'physical'
export const isDigital = (p: Product): p is DigitalProduct => p.category === 'digital'
export const isSubscription = (p: Product): p is SubscriptionProduct => p.category === 'subscription'
export const isBundle = (p: Product): p is BundleProduct => p.category === 'bundle'

// ── Sample catalog ──
export const CATALOG: Product[] = [
  {
    id: asProductId('p1'),
    name: 'Wireless Mouse',
    basePrice: asMoney(15000),
    category: 'physical',
    weightGrams: 120,
    dimensions: { width: 6, height: 4, depth: 11 },
    shippingCost: asMoney(1200),
    stockQuantity: 50,
  } satisfies PhysicalProduct,
  {
    id: asProductId('p2'),
    name: 'VS Code Theme Pack',
    basePrice: asMoney(3500),
    category: 'digital',
    fileSizeMb: 45,
    downloadLimit: 5,
    licenseType: 'single',
  } satisfies DigitalProduct,
  {
    id: asProductId('p3'),
    name: 'Cloud Backup Pro',
    basePrice: asMoney(2900),
    category: 'subscription',
    billingCycle: 'monthly',
    trialDays: 14,
    autoRenew: true,
  } satisfies SubscriptionProduct,
  {
    id: asProductId('p4'),
    name: 'Dev Starter Kit',
    basePrice: asMoney(20000),
    category: 'bundle',
    items: [], // populated at runtime
    discountPercent: 15,
  } satisfies BundleProduct,
]

// Resolve bundle references
;(CATALOG[3] as BundleProduct).items = [CATALOG[0], CATALOG[1]]
