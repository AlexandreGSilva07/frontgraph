# pricing.ts — Pricing Engine & Pipeline

## Visão Geral

Motor de precificação que aplica regras de negócio sobre um carrinho. Opera como um pipeline: recebe um `Cart` e uma lista de `PricingRule[]`, aplica cada regra em ordem de prioridade, e retorna o `Cart` transformado com preços, descontos e impostos recalculados.

## Pipeline de Execução

A função principal é `pricingPipeline(cart, rules)`:

1. **Ordenação**: As regras são ordenadas por prioridade — `tiered` (0) primeiro, `regional_tax` (4) por último. Isso garante que descontos sejam aplicados antes de impostos.
2. **Reset**: `recalcCart()` zera todos os descontos e recompõe os `lineTotal` a partir do `basePrice * quantity`.
3. **Aplicação sequencial**: Para cada regra, o switch por `rule.type` dispara a função específica.
4. **Cálculo final**: `netSubtotal = sum(lineTotal - discountTotal) + tax`, produzindo o total final.

## Regras Individuais

### Tiered Pricing (`applyTiered`)

Opera no nível do item. Os tiers são ordenados do maior `minQuantity` para o menor. Para cada item, busca o primeiro tier cujo `minQuantity` é atendido pela quantidade no carrinho. O novo `lineTotal` substitui o `basePrice * quantity`. A diferença vai para `discountTotal`.

Exemplo: Mouse custa R$150/unidade. Tier: acima de 3 unidades, R$120/unidade. Se quantidade=4, lineTotal=480, discountTotal=120.

### Coupon (`applyCouponToCart`)

Opera no nível do carrinho. Validações:
- Cupom expirado (`expiresAt` no passado) → retorna carrinho inalterado
- Compra mínima não atingida (`minPurchase`) → retorna carrinho inalterado
- Categorias restritas (`applicableCategories`) → aplica só nos itens elegíveis

O desconto é calculado como:
- `percent`: `(lineTotal - discountTotal) * discountValue / 100`
- `fixed`: `discountValue * quantity`

Há um cap opcional (`maxDiscount`) que limita o desconto total. O cupom é registrado em `cart.appliedRules`.

### Bundle Discount (`applyBundleDiscount`)

Verifica se TODOS os `requiredProductIds` estão no carrinho. Se sim, aplica `discountPercent` extra sobre cada item do bundle. A verificação é estrita — se faltar um produto, o desconto não é aplicado.

### Regional Tax (`applyRegionalTax`)

Aplica `taxPercent` sobre itens não isentos. Categorias em `exemptCategories` são puladas. O imposto é acumulativo com o imposto já existente no carrinho.

### Loyalty Discount (`applyLoyaltyDiscount`)

Desconto percentual progressivo com teto `maxDiscount`. Itera sobre os itens aplicando desconto até que o teto seja atingido. O cálculo é: `min(potential, remaining)`, onde `remaining = maxDiscount - accumulatedDiscount`.

## Função `recalcCart`

Reseta o carrinho ao estado base: recalcula `lineTotal` de cada item como `basePrice * quantity`, zera `discountTotal`, zera `discount` e `tax` do carrinho, e define `total = subtotal`. Usada no início do pipeline e quando itens são adicionados/removidos.

## Função `addToCart`

Adiciona produto ao carrinho com validações:
- **Quantidade negativa/zero**: rejeitado
- **Produto já existente**: incrementa a quantidade (merge), com validação de download limit para digitais
- **Produto novo**: valida estoque para físicos
- Após adição, chama `recalcCart` para atualizar totais
