# OrderForm.tsx — Multi-Step Order Wizard Component

## Visão Geral

Componente React que implementa um wizard de 4 passos para criar e gerenciar pedidos. É o ponto central onde types, pricing, validation e order-machine se encontram. Usa `useReducer` para gerenciar estado complexo com 16 action types.

## Gerenciamento de Estado (`formReducer`)

Estado central `FormState` contém:
- `step` / `stepIndex` — passo atual do wizard
- `cart` — carrinho com itens e totais
- `paymentMethod` — método de pagamento (nullable, tipado como union)
- `appliedRules` — regras de pricing ativas
- `order` — pedido criado após submit (nullable até o review)
- `errors` — erros globais do passo atual
- `fieldErrors` — erros por campo (chaveado por identificador)
- `couponCode` / `couponLoading` / `couponResult` — estado do async coupon flow

### Actions

| Action | O que faz |
|--------|-----------|
| `SET_STEP` | Navegação direta para um step |
| `NEXT_STEP` / `PREV_STEP` | Navegação sequencial com limpeza de erros |
| `SET_CART` | Substitui carrinho inteiro |
| `SET_PAYMENT` | Substitui método de pagamento inteiro |
| `SET_PAYMENT_FIELD` | Atualiza campo específico do payment (spread) |
| `ADD_RULE` / `REMOVE_RULE` | Gerencia regras de pricing |
| `SET_ERRORS` / `SET_FIELD_ERROR` / `CLEAR_FIELD_ERRORS` | Controle de erros |
| `SET_ORDER` | Define order como `Order \| null` |
| `TRANSITION_ORDER` | Dispara `transition()` da order-machine |
| `SET_COUPON_CODE` / `SET_COUPON_LOADING` / `SET_COUPON_RESULT` | Async coupon state |

### Inicialização

`initialState()` cria um carrinho com 1 unidade de cada produto do catálogo e um payment method credit_card vazio.

## Integração com o Pricing Engine

O carrinho exibido na UI é sempre `pricedCart`, derivado via `useMemo`:
```
pricedCart = pricingPipeline(state.cart, state.appliedRules) ?? state.cart
```
Isso significa que adicionar/remover regras recalcula automaticamente os preços visíveis em todos os passos.

## Validação Assíncrona de Cupom

Usa `useEffect` com debounce de 600ms no campo `couponCode`:
1. Se code tem < 3 caracteres, não faz nada
2. Dispara timer de 600ms
3. Ao disparar: seta loading, chama `validateCoupon()` (async)
4. No retorno:
   - Sucesso: exibe mensagem verde + adiciona `CouponRule` às appliedRules
   - Falha: exibe erro no campo

O cleanup do effect cancela o timer pendente (digitação rápida não gera chamadas).

## Validação por Passo (`validateStep`)

Cada passo tem validação específica antes de permitir avançar:

| Passo | Validações |
|-------|-----------|
| `products` | `validateCart()` — carrinho não vazio, estoque, limites |
| `pricing` | Sempre válido (opcional) |
| `payment` | `validatePayment()` + `validatePaymentForCart()` — campos + cross-validation |
| `review` | Sempre válido |

Se validação falhar, `errors` são setados e o avanço é bloqueado.

## Criação do Pedido

No passo `review`, ao clicar "Place Order":
1. Cria `Order` com id timestamp, carrinho precificado, payment method, estado `draft`
2. Dispara `transition(order, 'pending_payment')` → move para pending_payment
3. Navega para tracking view

## Renderização Condicional por Variante

### Payment Methods

O formulário de pagamento renderiza campos totalmente diferentes baseado em `state.paymentMethod.method`:
- `credit_card`: 6 campos (number, month, year, cvv, brand select, installments)
- `pix`: 1 campo (CPF)
- `boleto`: 2 campos (CPF, address)
- `wallet_credit`: 2 campos (walletId, amount)

A troca de método (`handlePaymentMethodChange`) reseta o payment para um novo objeto da variante correta.

### Order Tracking

A timeline mostra 7 estados (`draft` → `delivered`), renderizando cada um como:
- `past`: transição já ocorreu (verde)
- `current`: estado atual (azul com glow)
- `future` + `available`: próximo alcançável (cinza normal)
- `future` + `unavailable`: cinza opaco (muted)

Botões de ação são renderizados apenas para estados em `availableTransitions(order)`.

### Product Categories

Cada item no carrinho exibe informações específicas da categoria:
- Physical: peso, dimensões, estoque
- Digital: tamanho, licença, limite de downloads
- Subscription: billing cycle, trial days
- Bundle: quantidade de itens no bundle

## Controle de Quantidade

Ao alterar quantidade de um item:
1. `validateItemQuantity()` verifica limites
2. Se inválido: seta `fieldError` específico para `qty-{productId}`
3. Se válido: recalcula `lineTotal`, chama `recalcCart()`
