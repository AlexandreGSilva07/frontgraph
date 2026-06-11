# validation.ts — Multi-Level Validation System

## Visão Geral

Sistema de validação em três camadas: validação de campo individual, validação de entidade, e validação cross-entity. Inclui validação assíncrona simulando chamadas de API.

## Validação de Pagamento (`validatePayment`)

Função exaustiva que cobre todas as 4 variantes de `PaymentMethod` via switch no discriminador `method`. Cada branch aplica regras específicas e acumula erros em `string[]`.

### Cartão de Crédito
- Número do cartão: obrigatório + regex `^\d{13,19}$`
- CVV: obrigatório + regex `^\d{3,4}$`
- Mês de expiração: range 1-12
- Validade: compara com `new Date()` — mês/ano não podem ser passados
- Parcelas: range 1-12

### Pix
- CPF: obrigatório + regex exato `^\d{11}$` (11 dígitos, sem pontuação)

### Boleto
- CPF: mesma validação do Pix
- Endereço: obrigatório (boleto é entregue fisicamente)

### Wallet Credit
- Wallet ID: obrigatório, não vazio

A função retorna `Result<PaymentMethod, string[]>` — acumula múltiplos erros em vez de parar no primeiro.

## Validação de Carrinho (`validateCart`)

Regras por item:
- Carrinho vazio: erro global
- Quantidade ≤ 0: erro por item
- Produto físico com quantidade > `stockQuantity`: erro por item
- Produto digital com quantidade > `downloadLimit`: erro por item

Erros são acumulados em array com nome do produto como prefixo.

## Validação Cruzada (`validatePaymentForCart`)

Valida a combinação payment + cart, que não pode ser validada isoladamente em nenhuma das duas entidades:

- **Boleto + valor alto**: limite de R$1.000,00 (100000 centavos). Se `cart.total > 100000`, rejeita.
- **Pix + muitos itens**: limite de 10 itens no total (soma de quantidades de todos os itens).
- **Wallet + saldo insuficiente**: `wallet.amount < cart.total` → rejeita com mensagem indicando o déficit.

Retorna `Result<{ payment, cart }, string[]>` — em caso de sucesso, devolve o par validado.

## Validação Assíncrona de Cupom (`validateCoupon`)

Simula uma chamada de API para validar cupons:

1. **Delay artificial**: 800ms + random(0-400ms) para simular latência de rede
2. **Lookup**: busca o código (uppercase) em `VALID_COUPONS`, um dicionário interno com `maxUses` e `_used`
3. **Regras de negócio simuladas**:
   - Cupom não encontrado → erro
   - Limite de usos atingido (`_used >= maxUses`) → erro
   - `SAVE20`: exige subtotal mínimo de R$50,00 (5000 centavos)
   - `VIP30`: exige subtotal mínimo de R$200,00 (20000 centavos)
4. **Retorno**: `Result<string, string[]>` com o código validado em uppercase

A base de cupons interna:
| Código | Usos máx | Usos consumidos |
|--------|---------|-----------------|
| WELCOME10 | 100 | 42 |
| SAVE20 | 50 | 50 (esgotado) |
| VIP30 | 10 | 1 |

## Validação de Quantidade (`validateItemQuantity`)

Validada ao alterar quantidade de um item no formulário:
- Quantidade positiva
- Respeita `stockQuantity` para físicos
- Respeita `downloadLimit` para digitais
