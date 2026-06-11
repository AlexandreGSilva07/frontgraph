# order-machine.ts — Order State Machine

## Visão Geral

Implementa uma máquina de estados finita para o ciclo de vida de um pedido. Controla quais transições são válidas e quais condições de negócio (guards) precisam ser satisfeitas para cada transição.

## Estrutura de Estados

8 estados modelados como string literal union:

```
draft → pending_payment → paid → processing → shipped → delivered
  ↓         ↓              ↓         ↓
cancelled cancelled     refunded cancelled
                                    ↑
                              delivered
```

A tabela `ORDER_STATE_TRANSITIONS` declara as transições válidas. Estados terminais (`cancelled`, `refunded`) têm array vazio.

## Sistema de Guards

Há dois tipos de guard, diferenciados por quando disparam:

### Source Guards (`SOURCE_GUARDS`)

Disparam quando o pedido SAI de um estado específico. Verificam se o pedido está em condições de prosseguir:

| Estado origem | Guard | Condições |
|--------------|-------|-----------|
| `draft` | `guardToPendingPayment` | Carrinho não vazio + payment method definido |
| `pending_payment` | `alwaysOk` | Sempre passa (validação real de pgto é externa) |
| `paid` | `guardToProcessing` | Itens físicos exigem payment method confirmado |
| `processing` | `guardToShipped` | Só pode shipar se houver itens físicos no pedido |
| `shipped` | `alwaysOk` | Sempre passa |

### Target Guards (`TARGET_GUARDS`)

Disparam quando o pedido ENTRA em um estado específico. Verificam se o estado atual permite a transição:

| Estado destino | Guard | Condições |
|---------------|-------|-----------|
| `cancelled` | `guardToCancelled` | Não pode cancelar de `shipped`, `delivered`, `cancelled`, `refunded` |
| `refunded` | `guardToRefunded` | Só pode refundar de `paid` ou `delivered` |

## Função `transition(order, to)`

Algoritmo principal:

1. **Validação de transição**: verifica se `to` está em `ORDER_STATE_TRANSITIONS[order.state]`
2. **Target guard**: executa o guard do estado destino (se existir)
3. **Source guard**: executa o guard do estado origem (se existir)
4. **Cria registro**: `StateTransition { from, to, timestamp }`
5. **Retorna novo Order**: com `state = to` e transição appended ao `stateHistory`

Se qualquer guard falhar, retorna `err(mensagem)`. Se a transição não for válida, retorna `err('Invalid transition: X → Y')`.

## Função `availableTransitions(order)`

Retorna os estados alcançáveis a partir do estado atual, filtrando por guards. Útil para a UI mostrar apenas botões de ações válidas. Para cada estado candidato em `ORDER_STATE_TRANSITIONS[order.state]`, executa tanto o target guard quanto o source guard — só inclui se ambos passarem.

## Função `isTerminal(state)`

Estados terminais são aqueles com array vazio em `ORDER_STATE_TRANSITIONS`: `cancelled` e `refunded`.

## Design de Imutabilidade

Todas as funções operam em modo imutável: recebem um `Order`, retornam um novo `Order` com as alterações. O `stateHistory` é um array que só cresce (append-only). Isso torna o histórico auditável e permite time-travel debugging.
