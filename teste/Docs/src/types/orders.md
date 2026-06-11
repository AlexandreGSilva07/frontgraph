# orders.ts — Type System & Domain Contracts

## Visão Geral

Define todos os contratos de tipo do sistema de pedidos. É o alicerce sobre o qual toda a lógica de negócio e a UI são construídas. Não contém lógica de runtime, apenas tipos, type predicates, e constantes de dados.

## Branded Types

Três tipos "branded" são usados para impedir confusão entre valores primitivos de domínios diferentes:

- `OrderId` — string marcada como identificador de pedido
- `ProductId` — string marcada como identificador de produto  
- `Money` — número (centavos) marcado como valor monetário

O branding é estrutural: `Branded<T, B>` faz intersection de `T` com um objeto contendo um `unique symbol`. Isso força o compilador a tratar `Money` como incompatível com `number`, e `OrderId` como incompatível com `ProductId`, mesmo sendo o mesmo primitivo.

As funções `asMoney()`, `asOrderId()`, `asProductId()` são os "cast gates" — a única forma de criar valores branded fora dos limites do módulo.

## Discriminated Unions

### Product (4 variantes)

A union `Product` é o coração do domínio. Cada variante compartilha `id`, `name`, `basePrice`, `category`, mas diverge radicalmente nos campos específicos:

| Variante | Discriminador | Campos exclusivos |
|----------|-------------|-------------------|
| `PhysicalProduct` | `category: 'physical'` | peso, dimensões, custo de envio, quantidade em estoque |
| `DigitalProduct` | `category: 'digital'` | tamanho de arquivo, limite de downloads, tipo de licença |
| `SubscriptionProduct` | `category: 'subscription'` | ciclo de cobrança, dias de trial, renovação automática |
| `BundleProduct` | `category: 'bundle'` | array recursivo de `Product[]`, percentual de desconto |

O campo `BundleProduct.items` é recursivo — um bundle contém outros produtos, que podem ser outros bundles. Isso força qualquer código que percorra produtos a ser explícito sobre qual variante está tratando.

### PaymentMethod (4 variantes)

Cada método de pagamento exige campos completamente diferentes:

- `CreditCardPayment` — número do cartão, expiry, CVV, parcelas, bandeira
- `PixPayment` — apenas CPF
- `BoletoPayment` — CPF + endereço de cobrança
- `WalletPayment` — ID da carteira + saldo disponível

O discriminador é `method`. A inexistência de campos comuns (além do discriminador) é intencional — força a UI a renderizar formulários totalmente diferentes para cada método.

### PricingRule (5 variantes)

Regras que transformam o preço de um carrinho:

| Variante | Como afeta o preço |
|----------|-------------------|
| `TieredPricing` | Preço por unidade cai conforme quantidade aumenta |
| `CouponRule` | Desconto percentual ou fixo, com validações (minPurchase, expiresAt, categorias) |
| `BundleRule` | Desconto extra quando produtos específicos estão juntos no carrinho |
| `RegionalTaxRule` | Imposto percentual por região, com categorias isentas |
| `LoyaltyRule` | Desconto para cliente com histórico de pedidos, com teto máximo |

Cada regra tem prioridade numérica diferente que determina a ordem de aplicação no pipeline.

### OrderState (8 estados)

Máquina de estados finita mapeada em `ORDER_STATE_TRANSITIONS`:

```
draft → pending_payment → paid → processing → shipped → delivered
  ↓         ↓              ↓         ↓
cancelled cancelled     refunded cancelled
                                    ↑
                              delivered
```

Estados terminais (sem transições de saída): `cancelled`, `refunded`.

## Tipos Auxiliares

### Result<T, E>

Monad Either minimalista. Toda operação que pode falhar retorna `Result`:
- Sucesso: `{ ok: true, value: T }`
- Falha: `{ ok: false, error: E }`

As funções `ok()` e `err()` são os constructors. O default de `E` é `string`.

### WizardStep

Quatro passos sequenciais: `'products' | 'pricing' | 'payment' | 'review'`. A ordem é definida pelo array `WIZARD_STEPS`.

### Type Predicates

Funções de narrowing para refinar `Product` em variantes específicas em runtime:
- `isPhysical()` — check `category === 'physical'`
- `isDigital()` — check `category === 'digital'`
- `isSubscription()` — check `category === 'subscription'`
- `isBundle()` — check `category === 'bundle'`

### Advanced Utility Types

- `PaymentByMethod<M>` — extrai um método de pagamento específico da union (ex: `PaymentByMethod<'pix'>` retorna `PixPayment`)
- `ProductsByCategory<C>` — extrai produtos de uma categoria
- `DeepReadonly<T>` — versão recursiva de `Readonly`
- `ReadonlyOrder` — Order inteiro deep readonly
- `UnwrapResult<R>` — extrai o tipo de valor de dentro de um `Result<T>`
- `UnwrapResults<R[]>` — mapeia array de Results para array de valores

## Catálogo de Exemplo

`CATALOG` é um array de 4 produtos (um de cada categoria) usado como dados iniciais. O bundle (índice 3) tem seus `items` populados via side-effect após a definição do array, referenciando os produtos físicos e digitais do catálogo.
